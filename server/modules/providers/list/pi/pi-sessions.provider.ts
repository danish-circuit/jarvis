import {
  buildPiActiveBranch,
  findPiSessionFilePath,
  readPiSessionFile,
  type PiSessionEntry,
} from '@/modules/providers/list/pi/pi-session-file.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  normalizeProviderTimestamp,
  readObjectRecord,
  readOptionalString,
  sliceTailPage,
} from '@/shared/utils.js';

const PROVIDER = 'pi';

/**
 * Renders a tool argument/result payload for display.
 */
const formatToolContent = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

/**
 * Flattens a Pi message `content` field into display text.
 *
 * Content is either a bare string or an array of typed blocks; only `text`
 * blocks contribute to the rendered body. Thinking and tool-call blocks are
 * emitted as their own normalized messages by the caller.
 */
const extractTextContent = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((block) => {
      const record = readObjectRecord(block);
      return record && record.type === 'text' ? readOptionalString(record.text) ?? '' : '';
    })
    .filter(Boolean)
    .join('');
};

/**
 * Collects image blocks so the transcript can re-render user attachments.
 */
const extractImageContent = (content: unknown): unknown[] | undefined => {
  if (!Array.isArray(content)) {
    return undefined;
  }

  const images = content.filter((block) => readObjectRecord(block)?.type === 'image');
  return images.length > 0 ? images : undefined;
};

export class PiSessionsProvider implements IProviderSessions {
  /**
   * Normalizes live `pi --mode rpc` events into frontend messages.
   *
   * Pi streams the agent loop as discrete lifecycle events rather than one
   * message per line, so a single turn produces many `message_update` deltas
   * bracketed by `tool_execution_*` events.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    const type = readOptionalString(raw.type);
    if (!type) {
      return [];
    }

    const timestamp = normalizeProviderTimestamp(raw.timestamp);
    const base = { sessionId: sessionId ?? '', timestamp, provider: PROVIDER } as const;

    /**
     * Surfaces a failed assistant turn.
     *
     * Pi does not fail the process on a provider error — a 401, a rate limit or
     * a context overflow all come back as a normal assistant message carrying
     * `stopReason: 'error'` and an `errorMessage`, and `pi` still exits 0. If
     * this is not translated the user sees an empty turn that reports success.
     */
    const readMessageError = (message: unknown): string | null => {
      const record = readObjectRecord(message);
      if (!record || readOptionalString(record.role) !== 'assistant') {
        return null;
      }

      const stopReason = readOptionalString(record.stopReason);
      if (stopReason !== 'error' && stopReason !== 'aborted') {
        return null;
      }

      return readOptionalString(record.errorMessage)
        ?? (stopReason === 'aborted' ? 'Pi run was aborted' : 'Pi request failed');
    };

    if (type === 'message_end') {
      const errorMessage = readMessageError(raw.message);
      return errorMessage
        ? [createNormalizedMessage({
          ...base,
          id: generateMessageId('pi_error'),
          kind: 'error',
          content: errorMessage,
        })]
        : [];
    }

    if (type === 'message_update') {
      const event = readObjectRecord(raw.assistantMessageEvent);
      const eventType = readOptionalString(event?.type);

      // Streaming can also terminate in an error event carrying the partial
      // assistant message rather than a delta.
      if (eventType === 'error') {
        const errorMessage = readMessageError(event?.error)
          ?? readOptionalString(readObjectRecord(event?.error)?.errorMessage)
          ?? 'Pi request failed';
        return [createNormalizedMessage({
          ...base,
          id: generateMessageId('pi_error'),
          kind: 'error',
          content: errorMessage,
        })];
      }

      const delta = readOptionalString(event?.delta) ?? '';
      if (!delta) {
        return [];
      }

      if (eventType === 'text_delta') {
        return [createNormalizedMessage({
          ...base,
          id: generateMessageId('pi_text'),
          kind: 'stream_delta',
          content: delta,
        })];
      }

      if (eventType === 'thinking_delta') {
        return [createNormalizedMessage({
          ...base,
          id: generateMessageId('pi_thinking'),
          kind: 'thinking',
          content: delta,
        })];
      }

      return [];
    }

    if (type === 'tool_execution_start') {
      const toolCallId = readOptionalString(raw.toolCallId);
      return [createNormalizedMessage({
        ...base,
        // Suffix the id so the start and end of one call cannot collide.
        id: toolCallId ? `${toolCallId}-start` : generateMessageId('pi_tool'),
        kind: 'tool_use',
        toolName: readOptionalString(raw.toolName) ?? 'Tool',
        toolInput: raw.args ?? {},
        toolId: toolCallId ?? undefined,
      })];
    }

    if (type === 'tool_execution_end') {
      const toolCallId = readOptionalString(raw.toolCallId);
      return [createNormalizedMessage({
        ...base,
        id: toolCallId ? `${toolCallId}-end` : generateMessageId('pi_tool_result'),
        kind: 'tool_result',
        toolName: readOptionalString(raw.toolName) ?? 'Tool',
        toolId: toolCallId ?? undefined,
        isError: raw.isError === true,
        // Top-level `content` is the field the chat converter reads; the nested
        // `toolResult` is what the message components render. Both are required
        // — omitting `content` is what made the whole pane throw once.
        content: formatToolContent(raw.result),
        toolResult: {
          content: formatToolContent(raw.result),
          isError: raw.isError === true,
        },
      })];
    }

    if (type === 'agent_end') {
      return [createNormalizedMessage({
        ...base,
        id: generateMessageId('pi_end'),
        kind: 'stream_end',
      })];
    }

    // Pi retries transient provider failures itself; surface the reason so a
    // stalled-looking turn is explainable rather than silent.
    if (type === 'auto_retry_start') {
      const errorMessage = readOptionalString(raw.errorMessage) ?? 'Pi is retrying the request';
      return [createNormalizedMessage({
        ...base,
        id: generateMessageId('pi_retry'),
        kind: 'error',
        content: errorMessage,
      })];
    }

    return [];
  }

  /**
   * Loads Pi history by reading the session transcript from disk.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    // The app session id and the Pi-native id diverge for disk-discovered
    // sessions, so prefer the provider id when the caller supplies one.
    const providerSessionId = options.providerSessionId ?? sessionId;
    const emptyResult: FetchHistoryResult = {
      messages: [],
      total: 0,
      hasMore: false,
      offset: 0,
      limit: null,
    };

    try {
      const filePath = await findPiSessionFilePath(providerSessionId);
      if (!filePath) {
        return emptyResult;
      }

      const sessionFile = await readPiSessionFile(filePath);
      if (!sessionFile) {
        return emptyResult;
      }

      const branch = buildPiActiveBranch(sessionFile.entries);
      const normalized = branch.flatMap((entry) => this.normalizeHistoryEntry(entry, sessionId));

      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = limit === null ? null : Math.max(0, limit);
      const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

      return {
        messages: page,
        total: normalized.length,
        hasMore,
        offset: normalizedOffset,
        limit: normalizedLimit,
        tokenUsage: this.aggregateTokenUsage(branch),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[PiProvider] Failed to load session ${sessionId}:`, message);
      return emptyResult;
    }
  }

  /**
   * Converts one session-tree entry into zero or more transcript messages.
   *
   * Entry ids are 8 hex chars and unique per file, so they seed the message ids;
   * a positional suffix keeps content blocks within one message distinct.
   */
  private normalizeHistoryEntry(entry: PiSessionEntry, sessionId: string): NormalizedMessage[] {
    const timestamp = normalizeProviderTimestamp(entry.timestamp);
    const entryId = entry.id ?? generateMessageId('pi_entry');
    const base = { sessionId, timestamp, provider: PROVIDER } as const;

    if (entry.type === 'compaction') {
      const summary = readOptionalString(entry.summary);
      return summary
        ? [createNormalizedMessage({
          ...base,
          id: `${entryId}-compaction`,
          kind: 'text',
          role: 'assistant',
          content: summary,
          isCompactSummary: true,
        })]
        : [];
    }

    if (entry.type === 'branch_summary') {
      const summary = readOptionalString(entry.summary);
      return summary
        ? [createNormalizedMessage({
          ...base,
          id: `${entryId}-branch`,
          kind: 'text',
          role: 'assistant',
          content: summary,
          isCompactSummary: true,
        })]
        : [];
    }

    if (entry.type === 'custom_message') {
      const content = extractTextContent(entry.content);
      return content.trim()
        ? [createNormalizedMessage({
          ...base,
          id: `${entryId}-custom`,
          kind: 'text',
          role: 'assistant',
          content,
        })]
        : [];
    }

    if (entry.type !== 'message') {
      // `custom` holds extension state, and model_change / thinking_level_change
      // / label / session_info are bookkeeping — none of them are transcript.
      return [];
    }

    const message = readObjectRecord(entry.message);
    const role = readOptionalString(message?.role);
    if (!message || !role) {
      return [];
    }

    if (role === 'user') {
      const content = extractTextContent(message.content);
      const images = extractImageContent(message.content);
      return content.trim() || images
        ? [createNormalizedMessage({
          ...base,
          id: `${entryId}-user`,
          kind: 'text',
          role: 'user',
          content,
          images,
        })]
        : [];
    }

    if (role === 'assistant') {
      return this.normalizeAssistantContent(message.content, entryId, base);
    }

    if (role === 'toolResult') {
      const isError = message.isError === true;
      return [createNormalizedMessage({
        ...base,
        id: `${entryId}-toolresult`,
        kind: 'tool_result',
        toolName: readOptionalString(message.toolName) ?? 'Tool',
        toolId: readOptionalString(message.toolCallId) ?? undefined,
        isError,
        content: extractTextContent(message.content),
        toolResult: { content: extractTextContent(message.content), isError },
      })];
    }

    if (role === 'bashExecution') {
      // Pi's `/bash` command records shell runs the user drove directly. They
      // are not model tool calls, but rendering them as one keeps the transcript
      // honest about what touched the workspace.
      const command = readOptionalString(message.command) ?? '';
      const exitCode = typeof message.exitCode === 'number' ? message.exitCode : null;
      return [createNormalizedMessage({
        ...base,
        id: `${entryId}-bash`,
        kind: 'tool_use',
        toolName: 'bash',
        toolInput: { command },
        toolId: `${entryId}-bash`,
        toolResult: {
          content: readOptionalString(message.output) ?? '',
          isError: exitCode !== null && exitCode !== 0,
        },
      })];
    }

    if (role === 'custom') {
      const content = extractTextContent(message.content);
      return content.trim()
        ? [createNormalizedMessage({
          ...base,
          id: `${entryId}-custommsg`,
          kind: 'text',
          role: 'assistant',
          content,
        })]
        : [];
    }

    return [];
  }

  /**
   * Splits an assistant message's content blocks into separate messages.
   */
  private normalizeAssistantContent(
    content: unknown,
    entryId: string,
    base: { sessionId: string; timestamp: string; provider: 'pi' },
  ): NormalizedMessage[] {
    if (typeof content === 'string') {
      return content.trim()
        ? [createNormalizedMessage({
          ...base,
          id: `${entryId}-text`,
          kind: 'text',
          role: 'assistant',
          content,
        })]
        : [];
    }

    if (!Array.isArray(content)) {
      return [];
    }

    const messages: NormalizedMessage[] = [];
    content.forEach((block, index) => {
      const record = readObjectRecord(block);
      const blockType = readOptionalString(record?.type);
      if (!record || !blockType) {
        return;
      }

      if (blockType === 'text') {
        const text = readOptionalString(record.text) ?? '';
        if (text.trim()) {
          messages.push(createNormalizedMessage({
            ...base,
            id: `${entryId}-text-${index}`,
            kind: 'text',
            role: 'assistant',
            content: text,
          }));
        }
        return;
      }

      if (blockType === 'thinking') {
        const thinking = readOptionalString(record.thinking) ?? '';
        if (thinking.trim()) {
          messages.push(createNormalizedMessage({
            ...base,
            id: `${entryId}-thinking-${index}`,
            kind: 'thinking',
            content: thinking,
          }));
        }
        return;
      }

      if (blockType === 'toolCall') {
        messages.push(createNormalizedMessage({
          ...base,
          id: `${entryId}-tool-${index}`,
          kind: 'tool_use',
          toolName: readOptionalString(record.name) ?? 'Tool',
          toolInput: record.arguments ?? {},
          toolId: readOptionalString(record.id) ?? `${entryId}-tool-${index}`,
        }));
      }
    });

    return messages;
  }

  /**
   * Sums usage across the branch's assistant messages.
   *
   * Pi stamps per-response usage onto each assistant message rather than keeping
   * a session-level running total, so the session total is the sum.
   */
  private aggregateTokenUsage(branch: PiSessionEntry[]): unknown {
    let inputTokens = 0;
    let outputTokens = 0;

    for (const entry of branch) {
      if (entry.type !== 'message') {
        continue;
      }

      const message = readObjectRecord(entry.message);
      if (!message || readOptionalString(message.role) !== 'assistant') {
        continue;
      }

      const usage = readObjectRecord(message.usage);
      if (!usage) {
        continue;
      }

      const input = Number(usage.input ?? 0);
      const cacheRead = Number(usage.cacheRead ?? 0);
      const cacheWrite = Number(usage.cacheWrite ?? 0);
      const output = Number(usage.output ?? 0);

      inputTokens += (Number.isFinite(input) ? input : 0)
        + (Number.isFinite(cacheRead) ? cacheRead : 0)
        + (Number.isFinite(cacheWrite) ? cacheWrite : 0);
      outputTokens += Number.isFinite(output) ? output : 0;
    }

    const used = inputTokens + outputTokens;
    if (used <= 0) {
      return undefined;
    }

    return {
      used,
      inputTokens,
      outputTokens,
      breakdown: { input: inputTokens, output: outputTokens },
    };
  }
}
