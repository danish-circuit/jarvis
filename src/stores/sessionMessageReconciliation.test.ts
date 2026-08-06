import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from './useSessionStore';
import {
  isAssistantTextEchoedInSameTurnOnServer,
  removeOptimisticUserEchoes,
} from './sessionMessageReconciliation';

const createUserMessage = (
  id: string,
  timestamp: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp,
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content: '',
  ...overrides,
});

test('replaces an optimistic image-only turn with its persisted Claude copy', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png', name: 'image.png' }],
  });
  const persisted = createUserMessage('claude_image', '2026-07-28T20:30:26.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('does not collapse an attachment-only turn into a server row without attachments', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png' }],
  });
  const persisted = createUserMessage('claude_empty', '2026-07-28T20:30:22.000Z');

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), [local]);
});

const createAssistantMessage = (
  id: string,
  timestamp: string,
  content: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp,
  provider: 'pi',
  kind: 'text',
  role: 'assistant',
  content,
  ...overrides,
});

test('fragment mode matches a zombie stream slice that exact mode misses', () => {
  // The pre-fix shattered stream finalized each word into its own realtime
  // row; the persisted turn holds the whole sentence as one server row.
  const server = [
    createUserMessage('user_1', '2026-08-06T07:50:00.000Z', { content: 'redo the stack' }),
    createAssistantMessage('srv_1', '2026-08-06T07:53:05.000Z', 'recreate the stack, wait for services'),
  ];
  const zombie = createAssistantMessage('text_zombie', '2026-08-06T07:53:01.000Z', 'recreate');

  assert.equal(isAssistantTextEchoedInSameTurnOnServer(zombie, server, [zombie], 'exact'), false);
  assert.equal(isAssistantTextEchoedInSameTurnOnServer(zombie, server, [zombie], 'fragment'), true);
});

test('fragment mode keeps a row the server does not have yet', () => {
  // The gap-covering case: the turn finished locally but the JSONL row is not
  // indexed yet. No server text contains the row, so it must survive.
  const server = [
    createUserMessage('user_1', '2026-08-06T07:50:00.000Z', { content: 'redo the stack' }),
  ];
  const fresh = createAssistantMessage('text_fresh', '2026-08-06T07:53:01.000Z', 'recreate the stack');

  assert.equal(isAssistantTextEchoedInSameTurnOnServer(fresh, server, [fresh], 'fragment'), false);
});

test('fragment mode does not reach across user turns', () => {
  const server = [
    createUserMessage('user_1', '2026-08-06T07:50:00.000Z', { content: 'first' }),
    createAssistantMessage('srv_1', '2026-08-06T07:51:00.000Z', 'hello world'),
    createUserMessage('user_2', '2026-08-06T07:52:00.000Z', { content: 'second' }),
    createAssistantMessage('srv_2', '2026-08-06T07:53:05.000Z', 'recreate the stack'),
  ];
  // "hello" is contained in the first turn's server row, but this row belongs
  // to the second turn and must not be claimed by it.
  const row = createAssistantMessage('text_row', '2026-08-06T07:53:01.000Z', 'hello');

  assert.equal(isAssistantTextEchoedInSameTurnOnServer(row, server, [row], 'fragment'), false);
});

test('matches optimistic attachment turns to persisted turns one-to-one', () => {
  const firstLocal = createUserMessage('local_first', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/first.png' }],
  });
  const secondLocal = createUserMessage('local_second', '2026-07-28T20:30:25.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/second.png' }],
  });
  const firstPersisted = createUserMessage('claude_first', '2026-07-28T20:30:22.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    [firstPersisted],
    [firstLocal, secondLocal],
  );

  assert.deepEqual(remainingRealtime.map((message) => message.id), ['local_second']);
});

test('keeps the existing optimistic text reconciliation behavior', () => {
  const local = createUserMessage('local_text', '2026-07-28T20:30:21.000Z', {
    content: 'hello',
  });
  const persisted = createUserMessage('claude_text', '2026-07-28T20:30:26.000Z', {
    content: 'hello',
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});
