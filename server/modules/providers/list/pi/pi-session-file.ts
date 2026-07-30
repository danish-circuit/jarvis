import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { getPiSessionsDir, readObjectRecord, readOptionalString } from '@/shared/utils.js';

/**
 * One parsed line of a Pi session transcript.
 *
 * Pi session files are JSONL where line 1 is a header and every later line is a
 * tree node carrying its own `id` and a `parentId` link. Field names mirror Pi's
 * `SessionEntry` union (see its `core/session-manager.js`); everything is kept
 * `unknown`-ish because these files are user-writable and may come from an older
 * schema version.
 */
export type PiSessionEntry = {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  [key: string]: unknown;
};

export type PiSessionHeader = {
  type: 'session';
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
};

export type PiSessionFile = {
  filePath: string;
  header: PiSessionHeader | null;
  /** Every entry in the file, in write order, header excluded. */
  entries: PiSessionEntry[];
};

/**
 * Pi session ids are uuids; anything else is rejected before it reaches a path.
 *
 * Session ids arrive from HTTP callers, so this guard is what stops
 * `../../etc/passwd` style values from being pasted into a directory scan.
 */
const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidPiSessionId(sessionId: string): boolean {
  return PI_SESSION_ID_PATTERN.test(sessionId);
}

/**
 * Parses one Pi session transcript.
 *
 * Malformed lines are skipped rather than thrown on: a transcript being written
 * concurrently by a live `pi` process routinely ends in a partial line.
 */
export function parsePiSessionContent(filePath: string, content: string): PiSessionFile {
  const entries: PiSessionEntry[] = [];
  let header: PiSessionHeader | null = null;

  for (const line of content.split(/\r?\n/)) {
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
    if (!record) {
      continue;
    }

    const type = readOptionalString(record.type);
    if (!type) {
      continue;
    }

    if (type === 'session' && !header) {
      header = record as PiSessionHeader;
      continue;
    }

    entries.push(record as PiSessionEntry);
  }

  return { filePath, header, entries };
}

export async function readPiSessionFile(filePath: string): Promise<PiSessionFile | null> {
  try {
    return parsePiSessionContent(filePath, await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolves the active leaf-to-root branch of a Pi session.
 *
 * Ported from `buildSessionPath` in Pi's `core/session-manager.js`: the leaf is
 * the last entry written to the file (Pi appends the current leaf last), and the
 * branch is found by following `parentId` up to the root and reversing.
 *
 * This is the one place Pi differs structurally from every other provider in
 * this repo — the others store a flat append-only log, so reading the whole file
 * is the conversation. For Pi, reading the whole file would interleave abandoned
 * branches created by `/fork`, `/clone` or a rewind.
 *
 * Note this is deliberately *not* Pi's `buildContextEntries`, which additionally
 * drops entries summarized away by a compaction. That trimming exists to build
 * the LLM's context window; the transcript UI should still show the full branch.
 */
export function buildPiActiveBranch(entries: PiSessionEntry[]): PiSessionEntry[] {
  if (entries.length === 0) {
    return [];
  }

  const byId = new Map<string, PiSessionEntry>();
  for (const entry of entries) {
    if (entry.id) {
      byId.set(entry.id, entry);
    }
  }

  const branch: PiSessionEntry[] = [];
  const visited = new Set<string>();
  let current: PiSessionEntry | undefined = entries[entries.length - 1];

  while (current) {
    // A hand-edited or truncated file can contain a parent cycle; bail rather
    // than spin forever.
    if (current.id) {
      if (visited.has(current.id)) {
        break;
      }
      visited.add(current.id);
    }

    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  branch.reverse();
  return branch;
}

/**
 * Finds the transcript file for one Pi session id.
 *
 * Files are named `<timestamp>_<sessionId>.jsonl`, so a session id alone does
 * not imply a path. Two layouts have to be handled, verified against pi 0.82.1:
 *
 * - Default: sharded into per-cwd folders,
 *   `~/.pi/agent/sessions/--<cwd-slug>--/<ts>_<id>.jsonl`.
 * - When `--session-dir` / `PI_CODING_AGENT_SESSION_DIR` is set, Pi treats that
 *   path as *the* session directory and writes transcripts **flat** into it,
 *   with no per-cwd folder at all.
 *
 * So both the root and one level of subdirectories are searched.
 */
export async function findPiSessionFilePath(sessionId: string): Promise<string | null> {
  if (!isValidPiSessionId(sessionId)) {
    return null;
  }

  const sessionsDir = getPiSessionsDir();
  const suffix = `_${sessionId}.jsonl`;

  let rootEntries: Dirent[];
  try {
    rootEntries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const flatMatch = rootEntries.find((entry) => entry.isFile() && entry.name.endsWith(suffix));
  if (flatMatch) {
    return path.join(sessionsDir, flatMatch.name);
  }

  for (const entry of rootEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const absoluteDir = path.join(sessionsDir, entry.name);
    let files: string[];
    try {
      files = await readdir(absoluteDir);
    } catch {
      continue;
    }

    const match = files.find((file) => file.endsWith(suffix));
    if (match) {
      return path.join(absoluteDir, match);
    }
  }

  return null;
}

/**
 * Reads the model that a session was last using.
 *
 * Pi records model switches as `model_change` entries and also stamps
 * `provider`/`model` onto every assistant message, so the newest of either on
 * the active branch is the answer.
 */
export function readPiSessionModel(branch: PiSessionEntry[]): string | null {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];

    if (entry.type === 'model_change') {
      const provider = readOptionalString(entry.provider);
      const modelId = readOptionalString(entry.modelId);
      if (provider && modelId) {
        return `${provider}/${modelId}`;
      }
    }

    if (entry.type === 'message') {
      const message = readObjectRecord(entry.message);
      if (message && readOptionalString(message.role) === 'assistant') {
        const provider = readOptionalString(message.provider);
        const modelId = readOptionalString(message.model);
        if (provider && modelId) {
          return `${provider}/${modelId}`;
        }
      }
    }
  }

  return null;
}
