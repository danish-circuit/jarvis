import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolvePiPermissionOptions,
  resolvePiThinkingLevel,
  spawnPi,
} from './pi-runtime.provider.js';
import { PiSessionsProvider } from './pi-sessions.provider.js';

const sessionsProvider = new PiSessionsProvider();

/**
 * Runtime adapters no longer import services directly; the dispatcher injects
 * these lookups. `resolveProviderSessionId` returning the id unchanged mirrors
 * a session whose app id and provider id already agree.
 */
const runtimeContext = {
  resolveProviderSessionId: (sessionId) => sessionId || null,
  resolveResumeModel: async (_sessionId, requestedModel) => requestedModel || undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
  normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
};

const findEnvKey = (name) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

/**
 * Stands in for the real `pi --mode rpc`: records the argv it was launched with,
 * reads newline-delimited commands off stdin, and replies with the same event
 * shapes the CLI emits.
 */
async function createFakePiExecutable(binDir) {
  const scriptPath = path.join(binDir, 'pi.js');
  await writeFile(scriptPath, `
const capturePath = process.env.PI_ARGS_CAPTURE;
const received = [];

const emit = (event) => console.log(JSON.stringify(event));

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    received.push(command);

    if (command.type === 'get_state') {
      emit({
        type: 'response',
        command: 'get_state',
        success: true,
        data: { sessionId: 'pi-live-1', sessionFile: '/tmp/pi-live-1.jsonl', thinkingLevel: 'off', isStreaming: false },
      });
      continue;
    }

    if (command.type === 'prompt') {
      emit({ type: 'agent_start' });
      emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'assistant response' },
      });
      emit({
        type: 'message_end',
        message: { role: 'assistant', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
      });
      emit({ type: 'agent_end' });
    }
  }
});

process.stdin.on('end', () => {
  if (capturePath) {
    require('node:fs').writeFileSync(capturePath, JSON.stringify({
      args: process.argv.slice(2),
      commands: received,
    }));
  }
  process.exit(0);
});
`, 'utf8');

  if (process.platform === 'win32') {
    const commandPath = path.join(binDir, 'pi.cmd');
    await writeFile(commandPath, '@echo off\r\nnode "%~dp0pi.js" %*\r\n', 'utf8');
    return;
  }

  const commandPath = path.join(binDir, 'pi');
  await writeFile(commandPath, '#!/bin/sh\nnode "$(dirname "$0")/pi.js" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

function withFakePi(testBody) {
  return async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'pi-cli-'));
    const pathKey = findEnvKey('PATH');
    const pathExtKey = findEnvKey('PATHEXT');
    const previousPath = process.env[pathKey];
    const previousPathExt = process.env[pathExtKey];
    const previousArgsCapture = process.env.PI_ARGS_CAPTURE;

    try {
      await createFakePiExecutable(tempRoot);
      process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
      if (process.platform === 'win32') {
        process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
          ? previousPathExt
          : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
      }

      await testBody(tempRoot);
    } finally {
      if (previousPath === undefined) {
        delete process.env[pathKey];
      } else {
        process.env[pathKey] = previousPath;
      }

      if (previousPathExt === undefined) {
        delete process.env[pathExtKey];
      } else {
        process.env[pathExtKey] = previousPathExt;
      }

      if (previousArgsCapture === undefined) {
        delete process.env.PI_ARGS_CAPTURE;
      } else {
        process.env.PI_ARGS_CAPTURE = previousArgsCapture;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  };
}

test('spawnPi emits session_created before normalized live messages for new sessions', withFakePi(async (tempRoot) => {
  const argsCapturePath = path.join(tempRoot, 'pi-args.json');
  process.env.PI_ARGS_CAPTURE = argsCapturePath;

  const messages = [];
  const writer = {
    userId: null,
    sessionId: null,
    send(message) {
      messages.push(message);
    },
    setSessionId(sessionId) {
      this.sessionId = sessionId;
    },
  };

  await spawnPi('Hi', { cwd: tempRoot }, writer, runtimeContext);

  const sessionCreatedIndex = messages.findIndex((message) => message.kind === 'session_created');
  const assistantDeltaIndex = messages.findIndex((message) =>
    message.kind === 'stream_delta' && message.content === 'assistant response',
  );
  const streamEnd = messages.find((message) => message.kind === 'stream_end');
  const complete = messages.find((message) => message.kind === 'complete');
  const tokenBudget = messages.find((message) => message.kind === 'status' && message.text === 'token_budget');

  assert.notEqual(sessionCreatedIndex, -1);
  assert.notEqual(assistantDeltaIndex, -1);
  // get_state resolves the id before any assistant output, so the client never
  // renders a message against an unknown session.
  assert.ok(sessionCreatedIndex < assistantDeltaIndex);
  assert.equal(messages[sessionCreatedIndex].newSessionId, 'pi-live-1');
  assert.equal(writer.sessionId, 'pi-live-1');
  assert.equal(streamEnd?.sessionId, 'pi-live-1');
  assert.equal(complete?.sessionId, 'pi-live-1');
  assert.equal(messages.some((message) => message.kind === 'error'), false);

  // Usage is summed off message_end, since Pi keeps no session running total.
  assert.equal(tokenBudget?.tokenBudget.inputTokens, 10);
  assert.equal(tokenBudget?.tokenBudget.outputTokens, 5);
  assert.equal(tokenBudget?.tokenBudget.used, 15);

  const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
  assert.deepEqual(capture.args.slice(0, 2), ['--mode', 'rpc']);
  // A brand-new conversation must not pass --session.
  assert.equal(capture.args.includes('--session'), false);
  // No permission mode requested → no tool allowlist.
  assert.equal(capture.args.includes('--tools'), false);

  // The prompt travels as a JSON command on stdin, never as argv.
  assert.equal(capture.args.includes('Hi'), false);
  const prompt = capture.commands.find((command) => command.type === 'prompt');
  assert.equal(prompt.message, 'Hi');
  assert.equal(capture.commands[0].type, 'get_state');
}));

test('resolvePiPermissionOptions maps UI permission modes onto Pi controls', () => {
  const plan = resolvePiPermissionOptions('plan');
  assert.deepEqual(plan.args.slice(0, 2), ['--tools', 'read,grep,find,ls']);
  assert.equal(plan.args[2], '--append-system-prompt');
  assert.match(plan.args[3], /plan mode/i);

  // Pi has no permission gating, so every other mode is indistinguishable from
  // default and must not invent flags that would silently restrict the agent.
  assert.deepEqual(resolvePiPermissionOptions('default'), { args: [] });
  assert.deepEqual(resolvePiPermissionOptions('bypassPermissions'), { args: [] });
  assert.deepEqual(resolvePiPermissionOptions('acceptEdits'), { args: [] });
  assert.deepEqual(resolvePiPermissionOptions(undefined), { args: [] });
});

test('resolvePiThinkingLevel only accepts levels the selected model advertises', () => {
  const models = {
    OPTIONS: [
      {
        value: 'anthropic/claude-sonnet-4-5',
        label: 'Sonnet',
        effort: { values: [{ value: 'off' }, { value: 'high' }] },
      },
      { value: 'openai/gpt-5.1', label: 'GPT' },
    ],
  };

  assert.equal(resolvePiThinkingLevel('anthropic/claude-sonnet-4-5', 'high', models), 'high');
  // `medium` is not in this model's thinkingLevelMap, so passing it would make
  // Pi exit on an invalid-thinking-level diagnostic.
  assert.equal(resolvePiThinkingLevel('anthropic/claude-sonnet-4-5', 'medium', models), undefined);
  assert.equal(resolvePiThinkingLevel('anthropic/claude-sonnet-4-5', 'default', models), undefined);
  // A model with no effort metadata accepts nothing.
  assert.equal(resolvePiThinkingLevel('openai/gpt-5.1', 'high', models), undefined);
  assert.equal(resolvePiThinkingLevel('unknown/model', 'high', models), undefined);
});

test('spawnPi passes the plan-mode tool allowlist and resumes with --session', withFakePi(async (tempRoot) => {
  const argsCapturePath = path.join(tempRoot, 'pi-args-plan.json');
  process.env.PI_ARGS_CAPTURE = argsCapturePath;

  const writer = {
    userId: null,
    sessionId: null,
    send() {},
    setSessionId(sessionId) {
      this.sessionId = sessionId;
    },
  };

  await spawnPi('Hi', { cwd: tempRoot, sessionId: 'existing-1', permissionMode: 'plan' }, writer, runtimeContext);

  const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
  const toolsIndex = capture.args.indexOf('--tools');
  assert.notEqual(toolsIndex, -1);
  assert.equal(capture.args[toolsIndex + 1], 'read,grep,find,ls');

  const sessionIndex = capture.args.indexOf('--session');
  assert.notEqual(sessionIndex, -1);
  assert.equal(capture.args[sessionIndex + 1], 'existing-1');
}));
