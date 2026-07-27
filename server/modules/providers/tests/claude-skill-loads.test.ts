import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { createSkillInjectionAnnotator } from '@/modules/providers/list/claude/claude-skill-injection.js';
import type { AnyRecord } from '@/shared/types.js';

const SESSION_ID = 'session-1';
const SKILL_TOOL_USE_ID = 'toolu_skill_1';
const SKILL_BODY = 'Base directory for this skill: /repo/.claude/skills/run-benchmark\n\n# Run benchmark';

/** The `Skill` tool call, identical on the live stream and in the transcript. */
function skillToolUseEvent(id = SKILL_TOOL_USE_ID): AnyRecord {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: 'run-benchmark' } }],
    },
  };
}

/** The "Launching skill: <name>" tool result that follows it. */
function skillLaunchResultEvent(id = SKILL_TOOL_USE_ID): AnyRecord {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Launching skill: run-benchmark' }] },
  };
}

/**
 * The injected SKILL.md as the live SDK emits it: a synthetic user message with
 * no `sourceToolUseID` and no `isMeta` (unlike the persisted transcript row).
 */
function skillBodyEvent(text = SKILL_BODY): AnyRecord {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    isSynthetic: true,
  };
}

// ------------------------------------------------- live stream annotation

test('live stream: the injected skill body is linked back to its Skill tool call', () => {
  const annotate = createSkillInjectionAnnotator();

  annotate(skillToolUseEvent());
  annotate(skillLaunchResultEvent());
  const annotated = annotate(skillBodyEvent()) as AnyRecord;

  assert.equal(annotated.sourceToolUseID, SKILL_TOOL_USE_ID);
});

test('live stream: a real user message is never mistaken for a skill body', () => {
  const annotate = createSkillInjectionAnnotator();

  const typed = annotate({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'run the benchmark again' }] },
  }) as AnyRecord;

  assert.equal(typed.sourceToolUseID, undefined);
});

test('live stream: a user turn after the skill body is left alone', () => {
  const annotate = createSkillInjectionAnnotator();

  annotate(skillToolUseEvent());
  annotate(skillLaunchResultEvent());
  annotate(skillBodyEvent());
  const followUp = annotate({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'now summarize the results' }] },
  }) as AnyRecord;

  assert.equal(followUp.sourceToolUseID, undefined);
});

test('live stream: an assistant turn in between disarms the annotator', () => {
  const annotate = createSkillInjectionAnnotator();

  annotate(skillToolUseEvent());
  annotate(skillLaunchResultEvent());
  annotate({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] } });
  const later = annotate(skillBodyEvent()) as AnyRecord;

  assert.equal(later.sourceToolUseID, undefined);
});

test('live stream: non-Skill tool results do not arm the annotator', () => {
  const annotate = createSkillInjectionAnnotator();

  annotate({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash_1', name: 'Bash', input: { command: 'ls' } }] },
  });
  annotate({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash_1', content: 'a.txt' }] },
  });
  const next = annotate(skillBodyEvent()) as AnyRecord;

  assert.equal(next.sourceToolUseID, undefined);
});

// ------------------------------------------------- normalization (both paths)

test('live stream: annotated skill body normalizes to a collapsible skill block', () => {
  const provider = new ClaudeSessionsProvider();
  const annotate = createSkillInjectionAnnotator();

  annotate(skillToolUseEvent());
  annotate(skillLaunchResultEvent());
  const annotated = annotate(skillBodyEvent());

  const messages = provider.normalizeMessage(annotated, SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].isSkillContent, true);
  assert.equal(messages[0].toolId, SKILL_TOOL_USE_ID);
  assert.match(String(messages[0].content), /# Run benchmark/);
});

test('history: the persisted isMeta skill row normalizes to the same skill block', () => {
  const provider = new ClaudeSessionsProvider();

  const messages = provider.normalizeMessage(
    {
      uuid: 'u1',
      timestamp: '2026-07-27T16:07:49.539Z',
      type: 'user',
      isMeta: true,
      sourceToolUseID: SKILL_TOOL_USE_ID,
      message: { role: 'user', content: [{ type: 'text', text: SKILL_BODY }] },
    },
    SESSION_ID,
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].isSkillContent, true);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].toolId, SKILL_TOOL_USE_ID);
});

test('an uncorrelated skill body is still recognized by its base-directory preamble', () => {
  const provider = new ClaudeSessionsProvider();

  const messages = provider.normalizeMessage(skillBodyEvent(), SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].isSkillContent, true);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].toolId, undefined);
});

test('an ordinary user message still normalizes to a user bubble', () => {
  const provider = new ClaudeSessionsProvider();

  const messages = provider.normalizeMessage(
    {
      uuid: 'u2',
      timestamp: '2026-07-27T16:07:46.022Z',
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'read the /run-benchmark skill' }] },
    },
    SESSION_ID,
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].isSkillContent, undefined);
  assert.equal(messages[0].content, 'read the /run-benchmark skill');
});
