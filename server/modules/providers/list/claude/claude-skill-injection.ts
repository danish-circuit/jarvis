import type { AnyRecord } from '@/shared/types.js';

/**
 * Restores the `sourceToolUseID` link on a live skill load.
 *
 * Loading a skill injects its SKILL.md into the conversation as a synthetic
 * `role: "user"` message. The *persisted* transcript tags that message with
 * `sourceToolUseID` (the id of the `Skill` tool call) plus `isMeta`, which is
 * how the sessions provider recognizes it as skill content and the UI folds it
 * into a collapsed "Skill: <name>" block. The live SDK stream carries neither
 * field — the injected body arrives as a bare synthetic user message — so
 * without help it renders mid-transcript as if the human had pasted the whole
 * SKILL.md, while the same session reloaded from history renders the block.
 *
 * The link is recoverable from stream order, which is deterministic:
 *   1. assistant `tool_use` — name `Skill`, id X
 *   2. user `tool_result` for X — "Launching skill: <name>"
 *   3. user text — the SKILL.md body
 * So remember each `Skill` tool call, arm on its result, and attach the id to
 * the injected text that follows. Deliberately does not match on the body's
 * text: the injected preamble has changed between Claude Code versions, while
 * this ordering has not.
 *
 * Returns a stateful annotator — one per query run, since the state is per
 * stream.
 */
export function createSkillInjectionAnnotator(): (message: unknown) => unknown {
  const skillToolUseIds = new Set<string>();
  let awaitingBodyFor: string | null = null;

  return function annotateSkillInjection(message: unknown): unknown {
    const event = (message ?? {}) as AnyRecord;

    if (event.type === 'assistant') {
      const parts: AnyRecord[] = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const part of parts) {
        if (part?.type === 'tool_use' && part.name === 'Skill' && typeof part.id === 'string') {
          skillToolUseIds.add(part.id);
        }
      }
      // The model produced new output, so a skill body we were waiting for is
      // no longer coming — don't misattribute a later user message to it.
      awaitingBodyFor = null;
      return message;
    }

    if (event.type !== 'user') {
      return message;
    }

    const content = event.message?.content;
    const parts: AnyRecord[] = Array.isArray(content) ? content : [];

    // "Launching skill: <name>" — the tool result that precedes the body.
    const launchedSkillId = parts.find(
      (part) => part?.type === 'tool_result' && skillToolUseIds.has(String(part.tool_use_id)),
    )?.tool_use_id;
    if (typeof launchedSkillId === 'string') {
      awaitingBodyFor = launchedSkillId;
      return message;
    }

    if (!awaitingBodyFor || parts.some((part) => part?.type === 'tool_result')) {
      return message;
    }

    const hasText =
      typeof content === 'string'
        ? Boolean(content.trim())
        : parts.some((part) => part?.type === 'text' && String(part.text || '').trim());
    if (!hasText) {
      return message;
    }

    const sourceToolUseID = awaitingBodyFor;
    awaitingBodyFor = null;
    return { ...event, sourceToolUseID };
  };
}
