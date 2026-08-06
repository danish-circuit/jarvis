import crossSpawn from 'cross-spawn';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { LLMProvider, ProviderCliUpdateResult, ProviderCliVersion } from '@/shared/types.js';

type CliRunResult = { stdout: string; stderr: string };

/**
 * Promisified cross-spawn with the stdout/stderr shape callers got from
 * execFile. cross-spawn (not execFile) is what resolves `.cmd` shims on
 * Windows, and it is what the pi runtime spawns with — reading a version
 * through execFile would report the bare `pi` command as missing there while
 * sessions run it fine.
 */
function runCli(file: string, args: string[], timeout: number): Promise<CliRunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = crossSpawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const error = new Error(`Command failed with exit code ${code}`) as Error & {
        stdout?: string;
        stderr?: string;
      };
      error.stdout = stdout;
      error.stderr = stderr;
      rejectPromise(error);
    });
  });
}

const VERSION_TIMEOUT_MS = 15_000;
const REGISTRY_TIMEOUT_MS = 20_000;
const UPDATE_TIMEOUT_MS = 300_000;
const REGISTRY_CACHE_MS = 30 * 60 * 1000;

/**
 * Per-provider knowledge of how to read and upgrade its CLI, so adding a
 * provider is a table entry rather than a new endpoint.
 */
type CliDescriptor = {
  /** Resolves the executable the server actually spawns for this provider. */
  resolveExecutable: () => string;
  /** npm package backing the CLI, used to look up the published version. */
  npmPackage: string;
  /** Argv that upgrades the CLI in place. */
  updateArgs: string[];
};

const CLI_DESCRIPTORS: Partial<Record<LLMProvider, CliDescriptor>> = {
  claude: {
    // Must match what claude-sdk.js passes as pathToClaudeCodeExecutable —
    // reporting on a different binary than the one we run is how you end up
    // telling someone they are up to date while their sessions are not.
    resolveExecutable: () => resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
    npmPackage: '@anthropic-ai/claude-code',
    updateArgs: ['update'],
  },
  pi: {
    // The runtime spawns the bare `pi` command (pi-runtime.provider.js), so
    // the version reported must be whatever PATH resolves for that same name.
    resolveExecutable: () => 'pi',
    npmPackage: '@earendil-works/pi-coding-agent',
    // Bare `update` updates pi itself; --no-approve keeps the updater from
    // trusting project-local files in whatever directory the server runs from.
    updateArgs: ['update', '--no-approve'],
  },
};

export class ProviderCliVersionUnsupportedError extends Error {
  constructor(provider: LLMProvider) {
    super(`CLI version management is not supported for provider "${provider}"`);
    this.name = 'ProviderCliVersionUnsupportedError';
  }
}

function readDescriptor(provider: LLMProvider): CliDescriptor {
  const descriptor = CLI_DESCRIPTORS[provider];
  if (!descriptor) {
    throw new ProviderCliVersionUnsupportedError(provider);
  }
  return descriptor;
}

/**
 * `claude --version` prints `2.1.220 (Claude Code)`; take the leading semver
 * and ignore whatever the CLI decides to append after it.
 */
function parseVersion(stdout: string): string | null {
  const match = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(stdout);
  return match ? match[0] : null;
}

let registryCache: { package: string; version: string; fetchedAt: number } | null = null;

async function readInstalledVersion(descriptor: CliDescriptor): Promise<string | null> {
  try {
    const { stdout } = await runCli(descriptor.resolveExecutable(), ['--version'], VERSION_TIMEOUT_MS);
    return parseVersion(stdout);
  } catch {
    return null;
  }
}

async function readLatestVersion(descriptor: CliDescriptor): Promise<string | null> {
  const cached = registryCache;
  if (cached && cached.package === descriptor.npmPackage && Date.now() - cached.fetchedAt < REGISTRY_CACHE_MS) {
    return cached.version;
  }

  try {
    // `npm` is itself a .cmd shim on Windows, so this goes through the same
    // cross-spawn runner as the CLI binaries.
    const { stdout } = await runCli('npm', ['view', descriptor.npmPackage, 'version'], REGISTRY_TIMEOUT_MS);
    const version = parseVersion(stdout);
    if (version) {
      registryCache = { package: descriptor.npmPackage, version, fetchedAt: Date.now() };
    }
    return version;
  } catch {
    return null;
  }
}

/**
 * Compares dotted numeric versions. Returns true when `latest` is strictly
 * newer than `current`; a non-numeric or unparseable pair reports false rather
 * than nagging about an update we cannot substantiate.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const latestParts = latest.split('.').map((part) => Number.parseInt(part, 10));
  const currentParts = current.split('.').map((part) => Number.parseInt(part, 10));
  const length = Math.max(latestParts.length, currentParts.length);

  for (let index = 0; index < length; index += 1) {
    const latestPart = latestParts[index] ?? 0;
    const currentPart = currentParts[index] ?? 0;
    if (Number.isNaN(latestPart) || Number.isNaN(currentPart)) {
      return false;
    }
    if (latestPart !== currentPart) {
      return latestPart > currentPart;
    }
  }

  return false;
}

export class ProviderCliVersionService {
  /**
   * Reports the version of the CLI binary this server would actually spawn,
   * alongside the newest published one.
   */
  async getCliVersion(provider: LLMProvider): Promise<ProviderCliVersion> {
    const descriptor = readDescriptor(provider);
    const [current, latest] = await Promise.all([
      readInstalledVersion(descriptor),
      readLatestVersion(descriptor),
    ]);

    return {
      provider,
      executablePath: descriptor.resolveExecutable(),
      currentVersion: current,
      latestVersion: latest,
      updateAvailable: Boolean(current && latest && isNewerVersion(latest, current)),
    };
  }

  /**
   * Runs the CLI's own updater, then re-reads the resolved binary to report
   * what actually changed.
   *
   * The re-read is the point. `claude update` can report success while
   * installing into a different npm prefix than the executable on PATH — the
   * update lands somewhere real, but every session keeps running the old
   * binary. Trusting the updater's exit code would tell the user they are
   * upgraded when nothing they run has changed, so the truth we report is the
   * before/after of the binary we resolve.
   */
  async updateCli(provider: LLMProvider): Promise<ProviderCliUpdateResult> {
    const descriptor = readDescriptor(provider);
    const previousVersion = await readInstalledVersion(descriptor);

    let output = '';
    let failure: string | undefined;
    try {
      const { stdout, stderr } = await runCli(
        descriptor.resolveExecutable(),
        descriptor.updateArgs,
        UPDATE_TIMEOUT_MS,
      );
      output = `${stdout}${stderr}`.trim();
    } catch (error) {
      const execError = error as { stdout?: string; stderr?: string; message?: string };
      output = `${execError.stdout ?? ''}${execError.stderr ?? ''}`.trim();
      failure = execError.message || 'CLI update failed';
    }

    const currentVersion = await readInstalledVersion(descriptor);
    const changed = Boolean(currentVersion && previousVersion && currentVersion !== previousVersion);

    return {
      provider,
      executablePath: descriptor.resolveExecutable(),
      previousVersion,
      currentVersion,
      changed,
      // An updater that exits 0 without moving the resolved binary is a
      // failure from the caller's point of view, so say so explicitly.
      unchangedDespiteSuccess: !failure && !changed,
      output,
      error: failure,
    };
  }
}

export const providerCliVersionService = new ProviderCliVersionService();
