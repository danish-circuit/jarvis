import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PiSessionsProvider } from '@/modules/providers/list/pi/pi-sessions.provider.js';
import {
  buildPiActiveBranch,
  parsePiSessionContent,
} from '@/modules/providers/list/pi/pi-session-file.js';
import { encodePiSessionDirName, readPiSessionIdFromFilename } from '@/shared/utils.js';

const provider = new PiSessionsProvider();

const header = (cwd: string) =>
  JSON.stringify({ type: 'session', version: 3, id: 'sess-1', timestamp: '2026-01-01T00:00:00.000Z', cwd });

const userEntry = (id: string, parentId: string | null, text: string) =>
  JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'user', content: text },
  });

const assistantEntry = (id: string, parentId: string | null, text: string, usage?: Record<string, number>) =>
  JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:02.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      ...(usage ? { usage } : {}),
    },
  });

/**
 * Writes one transcript into a Pi-shaped sessions tree and points the provider
 * at it via PI_CODING_AGENT_SESSION_DIR.
 */
async function withPiSession(
  lines: string[],
  sessionId: string,
  run: (cwd: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'pi-sessions-'));
  const cwd = path.join(tempRoot, 'workspace');
  const sessionsDir = path.join(tempRoot, 'sessions');
  const workspaceDir = path.join(sessionsDir, encodePiSessionDirName(cwd));
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, `2026-01-01T00-00-00_${sessionId}.jsonl`),
    `${lines.join('\n')}\n`,
    'utf8',
  );

  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionsDir;
  try {
    await run(cwd);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
    } else {
      process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/**
 * The core structural difference between Pi and every other provider: sessions
 * are a tree, not a flat log. A `/fork` leaves the abandoned branch's entries in
 * the same file, so reading the file top-to-bottom would interleave two
 * conversations that never happened together.
 */
test('fetchHistory returns only the active leaf-to-root branch', async () => {
  const lines = [
    header('/workspace'),
    userEntry('aaaa1111', null, 'first question'),
    assistantEntry('bbbb2222', 'aaaa1111', 'first answer'),
    // Abandoned branch: forked off the first user message, then written to.
    userEntry('cccc3333', 'aaaa1111', 'abandoned question'),
    assistantEntry('dddd4444', 'cccc3333', 'abandoned answer'),
    // Active branch continues from the first answer. Written last, so it is the leaf.
    userEntry('eeee5555', 'bbbb2222', 'second question'),
    assistantEntry('ffff6666', 'eeee5555', 'second answer'),
  ];

  await withPiSession(lines, 'sess-1', async () => {
    const result = await provider.fetchHistory('sess-1');
    const contents = result.messages.map((message) => message.content);

    assert.deepEqual(contents, [
      'first question',
      'first answer',
      'second question',
      'second answer',
    ]);
    assert.equal(result.total, 4);
    assert.equal(result.hasMore, false);
    // The abandoned branch stays out entirely.
    assert.equal(contents.some((content) => content?.includes('abandoned')), false);
  });
});

/**
 * Compaction summarizes older entries away for the *model*, but the transcript
 * UI should still show what actually happened, so the pre-compaction entries
 * stay and the summary is rendered alongside them.
 */
test('fetchHistory keeps pre-compaction entries and renders the summary', async () => {
  const lines = [
    header('/workspace'),
    userEntry('aaaa1111', null, 'early question'),
    assistantEntry('bbbb2222', 'aaaa1111', 'early answer'),
    JSON.stringify({
      type: 'compaction',
      id: 'cccc3333',
      parentId: 'bbbb2222',
      timestamp: '2026-01-01T00:00:03.000Z',
      summary: 'Earlier conversation summarized.',
      tokensBefore: 50000,
      firstKeptEntryId: 'bbbb2222',
    }),
    userEntry('dddd4444', 'cccc3333', 'later question'),
  ];

  await withPiSession(lines, 'sess-1', async () => {
    const result = await provider.fetchHistory('sess-1');
    const contents = result.messages.map((message) => message.content);

    assert.deepEqual(contents, [
      'early question',
      'early answer',
      'Earlier conversation summarized.',
      'later question',
    ]);
    assert.equal(
      result.messages.find((message) => message.isCompactSummary)?.content,
      'Earlier conversation summarized.',
    );
  });
});

test('fetchHistory splits assistant content blocks and sums usage', async () => {
  const lines = [
    header('/workspace'),
    userEntry('aaaa1111', null, 'do a thing'),
    JSON.stringify({
      type: 'message',
      id: 'bbbb2222',
      parentId: 'aaaa1111',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
        content: [
          { type: 'thinking', thinking: 'considering' },
          { type: 'text', text: 'here goes' },
          { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'cccc3333',
      parentId: 'bbbb2222',
      timestamp: '2026-01-01T00:00:03.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'file.txt' }],
        isError: false,
      },
    }),
  ];

  await withPiSession(lines, 'sess-1', async () => {
    const result = await provider.fetchHistory('sess-1');
    const kinds = result.messages.map((message) => message.kind);
    assert.deepEqual(kinds, ['text', 'thinking', 'text', 'tool_use', 'tool_result']);

    // Ids must stay unique even though three of these came from one entry.
    const ids = result.messages.map((message) => message.id);
    assert.equal(new Set(ids).size, ids.length);

    const usage = result.tokenUsage as { used: number; inputTokens: number; outputTokens: number };
    assert.equal(usage.inputTokens, 115);
    assert.equal(usage.outputTokens, 50);
    assert.equal(usage.used, 165);
  });
});

test('fetchHistory skips extension state entries and bookkeeping', async () => {
  const lines = [
    header('/workspace'),
    userEntry('aaaa1111', null, 'question'),
    JSON.stringify({
      type: 'custom',
      id: 'bbbb2222',
      parentId: 'aaaa1111',
      timestamp: '2026-01-01T00:00:02.000Z',
      customType: 'my-extension',
      data: { count: 42 },
    }),
    JSON.stringify({
      type: 'model_change',
      id: 'cccc3333',
      parentId: 'bbbb2222',
      timestamp: '2026-01-01T00:00:03.000Z',
      provider: 'openai',
      modelId: 'gpt-5.1',
    }),
    assistantEntry('dddd4444', 'cccc3333', 'answer'),
  ];

  await withPiSession(lines, 'sess-1', async () => {
    const result = await provider.fetchHistory('sess-1');
    assert.deepEqual(result.messages.map((message) => message.content), ['question', 'answer']);
  });
});

test('fetchHistory paginates from the tail', async () => {
  const lines = [
    header('/workspace'),
    userEntry('aaaa1111', null, 'one'),
    assistantEntry('bbbb2222', 'aaaa1111', 'two'),
    userEntry('cccc3333', 'bbbb2222', 'three'),
    assistantEntry('dddd4444', 'cccc3333', 'four'),
  ];

  await withPiSession(lines, 'sess-1', async () => {
    const page = await provider.fetchHistory('sess-1', { limit: 2 });
    assert.deepEqual(page.messages.map((message) => message.content), ['three', 'four']);
    assert.equal(page.total, 4);
    assert.equal(page.hasMore, true);

    // limit 0 is an empty page, not unbounded history.
    const empty = await provider.fetchHistory('sess-1', { limit: 0 });
    assert.equal(empty.messages.length, 0);
    assert.equal(empty.total, 4);
  });
});

/**
 * Verified against pi 0.82.1: setting `--session-dir` /
 * `PI_CODING_AGENT_SESSION_DIR` makes Pi treat that path as *the* session
 * directory and write transcripts flat into it, with no per-cwd folder. A
 * lookup that only walks subdirectories finds nothing in that layout.
 */
test('fetchHistory finds a transcript written flat into an overridden session dir', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'pi-sessions-flat-'));
  const sessionsDir = path.join(tempRoot, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    path.join(sessionsDir, '2026-01-01T00-00-00_flat-1.jsonl'),
    `${[header('/workspace'), userEntry('aaaa1111', null, 'flat question')].join('\n')}\n`,
    'utf8',
  );

  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionsDir;
  try {
    const result = await provider.fetchHistory('flat-1');
    assert.deepEqual(result.messages.map((message) => message.content), ['flat question']);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
    } else {
      process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('fetchHistory returns empty for an unknown or unsafe session id', async () => {
  await withPiSession([header('/workspace'), userEntry('aaaa1111', null, 'hi')], 'sess-1', async () => {
    assert.equal((await provider.fetchHistory('does-not-exist')).messages.length, 0);
    // Path traversal must never reach a readdir/join.
    assert.equal((await provider.fetchHistory('../../etc/passwd')).messages.length, 0);
  });
});

test('buildPiActiveBranch survives a parent cycle without hanging', () => {
  const parsed = parsePiSessionContent('/tmp/x.jsonl', [
    header('/workspace'),
    JSON.stringify({ type: 'message', id: 'a', parentId: 'b', message: { role: 'user', content: 'a' } }),
    JSON.stringify({ type: 'message', id: 'b', parentId: 'a', message: { role: 'user', content: 'b' } }),
  ].join('\n'));

  const branch = buildPiActiveBranch(parsed.entries);
  assert.equal(branch.length, 2);
});

test('parsePiSessionContent tolerates a truncated trailing line', () => {
  const parsed = parsePiSessionContent('/tmp/x.jsonl', [
    header('/workspace'),
    userEntry('aaaa1111', null, 'complete'),
    '{"type":"message","id":"bbbb2222","parent',
  ].join('\n'));

  assert.equal(parsed.header?.cwd, '/workspace');
  assert.equal(parsed.entries.length, 1);
});

test('normalizeMessage maps live RPC events', () => {
  const textDelta = provider.normalizeMessage(
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } },
    'sess-1',
  );
  assert.equal(textDelta[0].kind, 'stream_delta');
  assert.equal(textDelta[0].content, 'hello');

  const thinkingDelta = provider.normalizeMessage(
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } },
    'sess-1',
  );
  assert.equal(thinkingDelta[0].kind, 'thinking');

  const toolStart = provider.normalizeMessage(
    { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: 'ls' } },
    'sess-1',
  );
  assert.equal(toolStart[0].kind, 'tool_use');
  assert.equal(toolStart[0].toolId, 'call_1');

  const toolEnd = provider.normalizeMessage(
    { type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash', result: 'out', isError: false },
    'sess-1',
  );
  assert.equal(toolEnd[0].kind, 'tool_result');
  // Start and end of one call must not collide on id.
  assert.notEqual(toolStart[0].id, toolEnd[0].id);

  assert.equal(provider.normalizeMessage({ type: 'agent_end' }, 'sess-1')[0].kind, 'stream_end');

  // A successful turn's message_end must not produce a bubble of its own.
  assert.deepEqual(
    provider.normalizeMessage(
      { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } },
      'sess-1',
    ),
    [],
  );
  // Unknown/irrelevant events produce nothing rather than empty bubbles.
  assert.deepEqual(provider.normalizeMessage({ type: 'turn_start' }, 'sess-1'), []);
  assert.deepEqual(
    provider.normalizeMessage({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '' } }, 'sess-1'),
    [],
  );
});

/**
 * Regression guard, verified against pi 0.82.1: a provider failure (401, rate
 * limit, context overflow) is delivered as an ordinary assistant `message_end`
 * carrying `stopReason: 'error'`, and the CLI still exits 0. Without this
 * mapping the user gets an empty turn that reports success.
 */
test('normalizeMessage surfaces a failed turn as an error', () => {
  const failed = provider.normalizeMessage(
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '401 {"type":"error","error":{"type":"authentication_error"}}',
        content: [],
      },
    },
    'sess-1',
  );

  assert.equal(failed.length, 1);
  assert.equal(failed[0].kind, 'error');
  assert.match(failed[0].content ?? '', /authentication_error/);

  const aborted = provider.normalizeMessage(
    { type: 'message_end', message: { role: 'assistant', stopReason: 'aborted', content: [] } },
    'sess-1',
  );
  assert.equal(aborted[0].kind, 'error');
  assert.match(aborted[0].content ?? '', /aborted/i);

  // The streaming error variant carries the partial message instead of a delta.
  const streamingError = provider.normalizeMessage(
    {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'error',
        reason: 'error',
        error: { role: 'assistant', stopReason: 'error', errorMessage: 'rate limited' },
      },
    },
    'sess-1',
  );
  assert.equal(streamingError[0].kind, 'error');
  assert.equal(streamingError[0].content, 'rate limited');
});

/**
 * Pins the two filename/path conventions ported from Pi's session-manager, so a
 * change upstream shows up here rather than as an empty sidebar.
 */
test('pi session path helpers match the CLI conventions', () => {
  assert.equal(encodePiSessionDirName('/Users/me/repos/app'), '--Users-me-repos-app--');
  assert.equal(
    readPiSessionIdFromFilename('/x/--Users-me--/2026-01-01T00-00-00_abc-123.jsonl'),
    'abc-123',
  );
  assert.equal(readPiSessionIdFromFilename('/x/notasession.txt'), null);
  assert.equal(readPiSessionIdFromFilename('/x/nounderscore.jsonl'), null);
});
