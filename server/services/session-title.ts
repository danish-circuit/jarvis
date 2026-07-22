import { sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';

/**
 * Auto-titles brand-new chat sessions.
 *
 * Jarvis drives Claude through the headless Agent SDK, which — unlike the
 * interactive CLI — never writes the `ai-title`/`last-prompt` metadata the
 * session synchronizer scrapes for names. So UI-created sessions used to stay
 * "New Session" forever. This module fills that gap: on the first user turn we
 * ask Claude Haiku for a short title derived from the prompt, persist it into
 * `sessions.custom_name`, and broadcast a live update.
 *
 * The synchronizer preserves any `custom_name` other than the literal
 * "Untitled Claude Session", so a generated title is not later clobbered.
 */

const TITLE_MODEL = 'claude-haiku-4-5-20251001';
const MAX_PROMPT_CHARS = 2000;
const MAX_TITLE_CHARS = 60;

// Guard against firing twice for the same session before the first call
// persists a name (a fast second message would otherwise double-generate).
const inFlight = new Set<string>();

// Names we treat as "no real title yet" and are allowed to overwrite.
const PLACEHOLDER_TITLES = new Set([
  '',
  'new session',
  'untitled session',
  'untitled chat session',
  'untitled claude session',
]);

function isUntitled(name: string | null | undefined): boolean {
  return PLACEHOLDER_TITLES.has((name ?? '').trim().toLowerCase());
}

function sanitizeTitle(raw: string): string {
  let title = (raw || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.\s]+$/, '')
    .trim();
  if (title.length > MAX_TITLE_CHARS) {
    title = title.slice(0, MAX_TITLE_CHARS).trim();
  }
  return title;
}

async function requestTitle(prompt: string, apiKey: string): Promise<string | null> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: TITLE_MODEL,
      max_tokens: 24,
      system:
        'You generate a short, specific title (3-6 words, Title Case, no quotes, ' +
        "no trailing punctuation) for a coding chat session based on the user's " +
        'first message. Reply with ONLY the title.',
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`[session-title] Anthropic API ${response.status}: ${body.slice(0, 300)}`);
    return null;
  }

  const data = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = Array.isArray(data.content)
    ? data.content.map((block) => block?.text ?? '').join('')
    : '';
  const title = sanitizeTitle(text);
  return title || null;
}

/**
 * Generate and persist a title for `sessionId` if it doesn't have one yet.
 * Safe to call on every message — it no-ops once a real title exists. Never
 * throws; all failures are logged and swallowed so chat flow is unaffected.
 */
export async function maybeGenerateSessionTitle(input: {
  sessionId: string;
  command: string;
}): Promise<void> {
  const { sessionId, command } = input;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !command || !command.trim() || inFlight.has(sessionId)) {
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session || !isUntitled(session.custom_name)) {
    return;
  }

  inFlight.add(sessionId);
  try {
    const title = await requestTitle(command.trim().slice(0, MAX_PROMPT_CHARS), apiKey);
    if (!title) {
      return;
    }

    // Re-check: the user may have manually renamed the session while the API
    // call was in flight — never stomp a real, user-chosen name.
    const fresh = sessionsDb.getSessionById(sessionId);
    if (!fresh || !isUntitled(fresh.custom_name)) {
      return;
    }

    sessionsDb.updateSessionCustomName(sessionId, title);
    chatRunRegistry.broadcastSessionUpsert(sessionId);
  } catch (error) {
    console.error('[session-title] Failed to generate session title:', error);
  } finally {
    inFlight.delete(sessionId);
  }
}
