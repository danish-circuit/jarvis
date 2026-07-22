import type { MouseEvent } from 'react';
import {
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from 'lucide-react';

import Tooltip from '../../shared/view/ui/Tooltip';
import { cn } from '../../lib/utils';
import type { PullRequestInfo, PullRequestStatus } from '../../hooks/usePullRequest';

interface StatusStyle {
  label: string;
  Icon: typeof GitPullRequest;
  // Tailwind classes for the pill in each state.
  className: string;
}

// Colour map requested: open=green, draft=grey, closed=red,
// mergeQueue=orange, merged=purple. Tints kept subtle for both themes.
const STATUS_STYLES: Record<PullRequestStatus, StatusStyle> = {
  open: {
    label: 'Open',
    Icon: GitPullRequest,
    className:
      'bg-green-500/15 text-green-700 ring-green-500/30 hover:bg-green-500/25 dark:text-green-400',
  },
  draft: {
    label: 'Draft',
    Icon: GitPullRequestDraft,
    className:
      'bg-muted text-muted-foreground ring-border hover:bg-muted-foreground/10',
  },
  closed: {
    label: 'Closed',
    Icon: GitPullRequestClosed,
    className:
      'bg-red-500/15 text-red-700 ring-red-500/30 hover:bg-red-500/25 dark:text-red-400',
  },
  mergeQueue: {
    label: 'In merge queue',
    Icon: GitPullRequestArrow,
    className:
      'bg-orange-500/15 text-orange-700 ring-orange-500/30 hover:bg-orange-500/25 dark:text-orange-400',
  },
  merged: {
    label: 'Merged',
    Icon: GitMerge,
    className:
      'bg-purple-500/15 text-purple-700 ring-purple-500/30 hover:bg-purple-500/25 dark:text-purple-400',
  },
};

interface PullRequestPillProps {
  pullRequest: PullRequestInfo;
  className?: string;
}

/**
 * A small clickable pill showing the current branch's PR number, coloured by
 * status, linking out to the PR on GitHub.
 */
export default function PullRequestPill({ pullRequest, className }: PullRequestPillProps) {
  const style = STATUS_STYLES[pullRequest.status] ?? STATUS_STYLES.open;
  const { Icon } = style;

  const stopPropagation = (event: MouseEvent<HTMLAnchorElement>) => {
    // The pill often sits inside clickable header rows — don't trigger those.
    event.stopPropagation();
  };

  const tooltip = pullRequest.title
    ? `${style.label} · #${pullRequest.number} · ${pullRequest.title}`
    : `${style.label} · #${pullRequest.number}`;

  return (
    <Tooltip content={tooltip} position="top">
      <a
        href={pullRequest.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={stopPropagation}
        aria-label={`Pull request #${pullRequest.number} — ${style.label}`}
        className={cn(
          'inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-[3px] text-xs font-medium leading-none ring-1 ring-inset transition-colors',
          style.className,
          className,
        )}
      >
        <Icon className="h-3.5 w-3.5" />
        <span>#{pullRequest.number}</span>
      </a>
    </Tooltip>
  );
}
