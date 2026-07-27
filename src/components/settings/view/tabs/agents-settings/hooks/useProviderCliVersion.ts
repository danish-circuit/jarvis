import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../../../../utils/api';
import type { AgentProvider } from '../../../../types/types';

export type ProviderCliVersionState = {
  /** Absolute path (or bare command) of the binary the server actually spawns. */
  executablePath: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** False for providers whose CLI this server does not manage. */
  supported: boolean;
  loading: boolean;
  error: string | null;
};

export type ProviderCliUpdateState = {
  running: boolean;
  /** Set once an update finishes; describes what actually happened. */
  outcome: 'updated' | 'unchanged' | 'failed' | null;
  message: string | null;
};

const INITIAL_VERSION: ProviderCliVersionState = {
  executablePath: null,
  currentVersion: null,
  latestVersion: null,
  updateAvailable: false,
  supported: true,
  loading: true,
  error: null,
};

const INITIAL_UPDATE: ProviderCliUpdateState = { running: false, outcome: null, message: null };

type CliVersionPayload = {
  executablePath?: string | null;
  currentVersion?: string | null;
  latestVersion?: string | null;
  updateAvailable?: boolean;
};

type CliUpdatePayload = {
  previousVersion?: string | null;
  currentVersion?: string | null;
  changed?: boolean;
  unchangedDespiteSuccess?: boolean;
  error?: string | null;
  output?: string | null;
};

type ApiResponse<T> = { success?: boolean; data?: T; error?: string };

const toMessage = (error: unknown): string => (
  error instanceof Error ? error.message : 'Unknown error'
);

/**
 * Reads (and can upgrade) the provider CLI backing this agent.
 *
 * The update result is deliberately reported from the server's before/after
 * reading of the resolved binary rather than the updater's exit status: an
 * updater can install into a prefix the server never runs, which looks like
 * success but changes nothing for the user.
 */
export function useProviderCliVersion(agent: AgentProvider) {
  const [version, setVersion] = useState<ProviderCliVersionState>(INITIAL_VERSION);
  const [update, setUpdate] = useState<ProviderCliUpdateState>(INITIAL_UPDATE);

  const refresh = useCallback(async () => {
    setVersion((previous) => ({ ...previous, loading: true, error: null }));

    try {
      const response = await authenticatedFetch(`/api/providers/${agent}/cli-version`);
      const payload = (await response.json()) as ApiResponse<CliVersionPayload>;

      if (!response.ok) {
        // 400 is the "this provider has no managed CLI" case — not an error
        // worth showing, just a section that does not apply.
        setVersion({
          ...INITIAL_VERSION,
          loading: false,
          supported: response.status !== 400,
          error: response.status === 400 ? null : (payload.error || 'Failed to read CLI version'),
        });
        return;
      }

      const data = payload.data ?? {};
      setVersion({
        executablePath: data.executablePath ?? null,
        currentVersion: data.currentVersion ?? null,
        latestVersion: data.latestVersion ?? null,
        updateAvailable: Boolean(data.updateAvailable),
        supported: true,
        loading: false,
        error: null,
      });
    } catch (caughtError) {
      setVersion({ ...INITIAL_VERSION, loading: false, error: toMessage(caughtError) });
    }
  }, [agent]);

  const runUpdate = useCallback(async () => {
    setUpdate({ running: true, outcome: null, message: null });

    try {
      const response = await authenticatedFetch(`/api/providers/${agent}/cli-version/update`, {
        method: 'POST',
      });
      const payload = (await response.json()) as ApiResponse<CliUpdatePayload>;
      const data = payload.data ?? {};

      if (!response.ok || data.error) {
        setUpdate({
          running: false,
          outcome: 'failed',
          message: data.error || payload.error || 'Update failed',
        });
      } else if (data.changed) {
        setUpdate({
          running: false,
          outcome: 'updated',
          message: `${data.previousVersion ?? 'unknown'} → ${data.currentVersion ?? 'unknown'}`,
        });
      } else {
        setUpdate({
          running: false,
          outcome: 'unchanged',
          // Distinguish "already current" from "the updater ran but the binary
          // we launch is untouched" — the latter needs a human to look.
          message: data.unchangedDespiteSuccess && data.currentVersion
            ? `Still ${data.currentVersion}`
            : null,
        });
      }
    } catch (caughtError) {
      setUpdate({ running: false, outcome: 'failed', message: toMessage(caughtError) });
    }

    await refresh();
  }, [agent, refresh]);

  useEffect(() => {
    setUpdate(INITIAL_UPDATE);
    void refresh();
  }, [refresh]);

  return { version, update, refresh, runUpdate };
}
