import { sessionsDb } from '@/modules/database/index.js';
import {
  buildPiActiveBranch,
  readPiSessionFile,
  type PiSessionEntry,
  type PiSessionFile,
} from '@/modules/providers/list/pi/pi-session-file.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import {
  findFilesRecursivelyCreatedAfter,
  getPiSessionsDir,
  normalizeSessionName,
  readFileTimestamps,
  readObjectRecord,
  readOptionalString,
  readPiSessionIdFromFilename,
} from '@/shared/utils.js';

const FALLBACK_TITLE = 'Untitled Pi Session';

type ParsedPiSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

/**
 * Session indexer for Pi transcript artifacts.
 *
 * Pi writes one JSONL file per session under a per-cwd folder, which puts it in
 * the same family as the Claude and Codex synchronizers: scan for `.jsonl`,
 * read metadata off the file, upsert. The transcript path is stored on the row,
 * so deleting an app session deletes exactly that session's transcript.
 */
export class PiSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'pi' as const;

  /**
   * Scans Pi's sessions tree and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const files = await findFilesRecursivelyCreatedAfter(getPiSessionsDir(), '.jsonl', since ?? null);

    let processed = 0;
    for (const filePath of files) {
      const upserted = await this.upsertSessionFile(filePath);
      if (upserted) {
        processed += 1;
      }
    }

    return processed;
  }

  /**
   * Parses and upserts one Pi session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    return this.upsertSessionFile(filePath);
  }

  private async upsertSessionFile(filePath: string): Promise<string | null> {
    const sessionFile = await readPiSessionFile(filePath);
    if (!sessionFile) {
      return null;
    }

    const parsed = this.parseSession(filePath, sessionFile);
    if (!parsed) {
      return null;
    }

    const pendingAppSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId)
      ?? sessionsDb.findLatestPendingAppSession(this.provider, parsed.projectPath);
    if (pendingAppSession && !pendingAppSession.provider_session_id) {
      // Pi creates its transcript as soon as the process starts, so the file
      // watcher can index it before the runtime has reported the session id back
      // over the websocket. Bind the id to the waiting app row first so the
      // watcher does not spawn a duplicate sidebar entry for the same session.
      sessionsDb.assignProviderSessionId(pendingAppSession.session_id, parsed.sessionId);
    }

    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingName = existingSession?.custom_name;
    const sessionName = existingName && existingName !== FALLBACK_TITLE
      ? existingName
      : parsed.sessionName;

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      normalizeSessionName(sessionName, FALLBACK_TITLE),
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath,
    );
  }

  /**
   * Extracts session metadata from one parsed Pi transcript.
   *
   * The workspace comes from the header's `cwd` rather than by decoding the
   * folder name — Pi's folder encoding is lossy (every separator collapses to a
   * hyphen), so it cannot be reversed reliably.
   */
  private parseSession(filePath: string, sessionFile: PiSessionFile): ParsedPiSession | null {
    const headerSessionId = readOptionalString(sessionFile.header?.id);
    const sessionId = headerSessionId ?? readPiSessionIdFromFilename(filePath);
    const projectPath = readOptionalString(sessionFile.header?.cwd);
    if (!sessionId || !projectPath) {
      return null;
    }

    return {
      sessionId,
      projectPath,
      sessionName: this.readSessionName(sessionFile.entries),
    };
  }

  /**
   * Derives a display title for one session.
   *
   * A `session_info` entry means the user named the session explicitly (`/name`
   * or `--name`), so it always wins. Otherwise the first user prompt on the
   * active branch stands in, matching how the other providers title sessions.
   */
  private readSessionName(entries: PiSessionEntry[]): string | undefined {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.type === 'session_info') {
        const name = readOptionalString(entry.name);
        if (name?.trim()) {
          return name;
        }
      }
    }

    for (const entry of buildPiActiveBranch(entries)) {
      if (entry.type !== 'message') {
        continue;
      }

      const message = readObjectRecord(entry.message);
      if (!message || readOptionalString(message.role) !== 'user') {
        continue;
      }

      const text = this.readUserText(message.content);
      if (text?.trim()) {
        return text;
      }
    }

    return undefined;
  }

  private readUserText(content: unknown): string | undefined {
    if (typeof content === 'string') {
      return content;
    }

    if (!Array.isArray(content)) {
      return undefined;
    }

    for (const block of content) {
      const record = readObjectRecord(block);
      if (record?.type === 'text') {
        const text = readOptionalString(record.text);
        if (text?.trim()) {
          return text;
        }
      }
    }

    return undefined;
  }
}
