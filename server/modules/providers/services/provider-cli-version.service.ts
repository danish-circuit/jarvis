import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { LLMProvider, ProviderCliUpdateResult, ProviderCliVersion } from '@/shared/types.js';

const execFileAsync = promisify(execFile);

const VERSION_TIMEOUT_MS = 15_000;
const REGISTRY_TIMEOUT_MS = 20_000;
const UPDATE_TIMEOUT_MS = 300_000;
const REGISTRY_CACHE_MS = 30 * 60 * 1000;

/**
 * Per-provider knowledge of how to read and upgrade its CLI. Only Claude is
 * wired up today; the shape is here so another provider is a table entry
 * rather than a new endpoint.
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
    const { stdout } = await execFileAsync(descriptor.resolveExecutable(), ['--version'], {
      timeout: VERSION_TIMEOUT_MS,
    });
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
    const { stdout } = await execFileAsync('npm', ['view', descriptor.npmPackage, 'version'], {
      timeout: REGISTRY_TIMEOUT_MS,
    });
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
      const { stdout, stderr } = await execFileAsync(
        descriptor.resolveExecutable(),
        descriptor.updateArgs,
        { timeout: UPDATE_TIMEOUT_MS },
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
