import crossSpawn from 'cross-spawn';

import {
  buildPiActiveBranch,
  findPiSessionFilePath,
  readPiSessionFile,
  readPiSessionModel,
} from '@/modules/providers/list/pi/pi-session-file.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

/**
 * Catalog used when the Pi CLI cannot be reached at all.
 *
 * Kept deliberately small — it exists so the model picker renders something
 * usable when `pi` is missing from the service PATH, not as a mirror of Pi's
 * real catalog. If a user sees exactly these entries, the CLI is not resolving.
 */
export const PI_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'anthropic/claude-sonnet-4-5',
      label: 'Claude Sonnet 4.5',
      description: 'anthropic - claude-sonnet-4-5',
    },
    {
      value: 'anthropic/claude-opus-4-1',
      label: 'Claude Opus 4.1',
      description: 'anthropic - claude-opus-4-1',
    },
    {
      value: 'openai/gpt-5.1',
      label: 'GPT-5.1',
      description: 'openai - gpt-5.1',
    },
  ],
  DEFAULT: 'anthropic/claude-sonnet-4-5',
};

const PI_MODELS_TIMEOUT_MS = 20_000;

/**
 * Pi's thinking levels, weakest first.
 *
 * These are the exact strings `--thinking` accepts. A model's
 * `thinkingLevelMap` may map a level to `null` to mark it unsupported, which is
 * why the per-model list is filtered rather than assumed.
 */
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

type PiModel = {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  thinkingLevelMap?: Record<string, unknown>;
};

/**
 * Runs one short-lived Pi RPC process and returns the response to a single command.
 *
 * Pi has no "print the catalog as JSON" flag — `--list-models` renders a padded
 * ASCII table for humans. RPC mode is the only structured route, and its
 * `get_available_models` is backed by the very same `modelRuntime.getAvailable()`
 * call that `--list-models` uses, so the two can never disagree. `--no-session`
 * keeps this from littering the session index with empty transcripts.
 */
function runPiRpcCommand(command: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawnFunction('pi', ['--mode', 'rpc', '--no-session'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let settled = false;

    const finish = (handler: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      handler();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error('Pi models lookup timed out'))),
      PI_MODELS_TIMEOUT_MS,
    );

    if (!child.stdout || !child.stdin) {
      finish(() => reject(new Error('Pi RPC process has no usable stdio')));
      return;
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const record = readObjectRecord(parsed);
        // RPC mode also streams lifecycle events; only the matching response matters.
        if (!record || record.type !== 'response' || record.command !== command.type) {
          continue;
        }

        if (record.success === false) {
          const error = readOptionalString(record.error) ?? 'Pi RPC command failed';
          finish(() => reject(new Error(error)));
          return;
        }

        finish(() => resolve(record.data));
        return;
      }
    });

    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', () => finish(() => reject(new Error('Pi RPC process exited before responding'))));

    child.stdin.write(`${JSON.stringify(command)}\n`);
  });
}

function readPiModels(data: unknown): PiModel[] {
  const record = readObjectRecord(data);
  const rawModels = record?.models;
  if (!Array.isArray(rawModels)) {
    return [];
  }

  const models: PiModel[] = [];
  for (const rawModel of rawModels) {
    const modelRecord = readObjectRecord(rawModel);
    if (!modelRecord) {
      continue;
    }

    const provider = readOptionalString(modelRecord.provider);
    const id = readOptionalString(modelRecord.id);
    if (!provider || !id) {
      continue;
    }

    models.push({
      provider,
      id,
      name: readOptionalString(modelRecord.name),
      reasoning: modelRecord.reasoning === true,
      contextWindow: typeof modelRecord.contextWindow === 'number' ? modelRecord.contextWindow : undefined,
      thinkingLevelMap: readObjectRecord(modelRecord.thinkingLevelMap) ?? undefined,
    });
  }

  return models;
}

/**
 * Derives the `--thinking` levels a single model actually accepts.
 *
 * A missing `thinkingLevelMap` means the model takes provider defaults for every
 * level; an explicit `null` for a level means that level is unsupported and must
 * not be offered.
 */
function readPiEffortValues(model: PiModel): ProviderModelOption['effort'] {
  if (!model.reasoning) {
    return undefined;
  }

  const levelMap = model.thinkingLevelMap;
  const values = PI_THINKING_LEVELS.filter(
    (level) => !levelMap || !(level in levelMap) || levelMap[level] !== null,
  ).map((level) => ({ value: level }));

  if (values.length === 0) {
    return undefined;
  }

  return { default: values.some((entry) => entry.value === 'off') ? 'off' : values[0].value, values };
}

function buildPiDefinition(models: PiModel[]): ProviderModelsDefinition {
  const options: ProviderModelOption[] = models
    .slice()
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
    .map((model) => ({
      // `<provider>/<id>` is exactly what `pi --model` accepts, so the option
      // value can be passed to the runtime verbatim.
      value: `${model.provider}/${model.id}`,
      label: model.name || model.id,
      description: `${model.provider} - ${model.id}`,
      effort: readPiEffortValues(model),
    }));

  if (options.length === 0) {
    return PI_FALLBACK_MODELS;
  }

  // Pick a mid-tier default rather than whatever sorts first. Options are
  // ordered by provider then id, so "first anthropic entry" would land on
  // something like claude-fable-5 — a small fast model, not what someone
  // expects a fresh conversation to open with.
  const preferred = options.find((option) => /sonnet/i.test(option.value))
    ?? options.find((option) => /opus/i.test(option.value))
    ?? options.find((option) => option.value.startsWith('anthropic/'))
    ?? options.find((option) => option.value.startsWith('openai/'))
    ?? options[0];

  return { OPTIONS: options, DEFAULT: preferred.value };
}

export class PiProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const data = await runPiRpcCommand({ type: 'get_available_models' });
      return buildPiDefinition(readPiModels(data));
    } catch {
      return PI_FALLBACK_MODELS;
    }
  }

  /**
   * Reads the model a session last used straight out of its transcript.
   *
   * Pi has no session database, so the transcript is the only record; the
   * newest `model_change` entry or assistant message on the active branch wins.
   */
  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    const trimmedSessionId = sessionId?.trim();
    if (trimmedSessionId) {
      const filePath = await findPiSessionFilePath(trimmedSessionId);
      const sessionFile = filePath ? await readPiSessionFile(filePath) : null;
      if (sessionFile) {
        const model = readPiSessionModel(buildPiActiveBranch(sessionFile.entries));
        if (model) {
          return { model };
        }
      }
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('pi', input);
  }
}
