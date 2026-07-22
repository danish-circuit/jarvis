import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../utils/api';

export type PullRequestStatus = 'open' | 'draft' | 'closed' | 'mergeQueue' | 'merged';

export interface PullRequestInfo {
  number: number;
  title?: string;
  url: string;
  status: PullRequestStatus;
}

interface PullRequestResponse {
  branch?: string;
  pullRequest: PullRequestInfo | null;
  unavailable?: boolean;
  error?: string;
}

const POLL_INTERVAL_MS = 60_000;

/**
 * Looks up the PR associated with the current branch of `projectId` via the
 * server's `gh`-backed `/api/git/pull-request` endpoint. Polls periodically and
 * refetches on window focus. Returns `null` when the branch has no PR (or when
 * `gh` is unavailable), so callers can simply hide the pill.
 */
export function usePullRequest(projectId: string | null | undefined): {
  pullRequest: PullRequestInfo | null;
  refresh: () => void;
} {
  const [pullRequest, setPullRequest] = useState<PullRequestInfo | null>(null);
  const projectIdRef = useRef<string | null | undefined>(projectId);

  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  const fetchPullRequest = useCallback(async (signal?: AbortSignal) => {
    const id = projectIdRef.current;
    if (!id) {
      setPullRequest(null);
      return;
    }

    try {
      const response = await authenticatedFetch(
        `/api/git/pull-request?project=${encodeURIComponent(id)}`,
        { signal },
      );
      const data = (await response.json()) as PullRequestResponse;

      // Ignore responses for a project the user has since navigated away from.
      if (signal?.aborted || projectIdRef.current !== id) {
        return;
      }

      setPullRequest(data.pullRequest ?? null);
    } catch (error) {
      if (signal?.aborted) {
        return;
      }
      // Network/parse failure -> treat as "no PR" so the pill just hides.
      setPullRequest(null);
    }
  }, []);

  useEffect(() => {
    if (!projectId) {
      setPullRequest(null);
      return;
    }

    const controller = new AbortController();
    void fetchPullRequest(controller.signal);

    const interval = setInterval(() => {
      void fetchPullRequest();
    }, POLL_INTERVAL_MS);

    const onFocus = () => void fetchPullRequest();
    window.addEventListener('focus', onFocus);

    return () => {
      controller.abort();
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [projectId, fetchPullRequest]);

  const refresh = useCallback(() => void fetchPullRequest(), [fetchPullRequest]);

  return { pullRequest, refresh };
}
