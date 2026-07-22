import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Archive } from 'lucide-react';

import { Markdown } from './Markdown';

/**
 * Renders a compaction continuation ("This session is being continued…") as a
 * collapsed divider instead of a giant markdown dump. Claude Code injects this
 * as a synthetic user turn when it auto-compacts; it summarizes the truncated
 * history (and embeds prior tool commands), so collapsing it keeps the
 * transcript readable while leaving the recap one click away.
 */
export default function CompactSummaryBlock({ content }: { content: string }) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="w-full py-1">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <Archive className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="font-medium">
          {t('compactSummary.title', { defaultValue: 'Context compacted' })}
        </span>
        <span className="flex-1 border-t border-dashed border-border/60" aria-hidden="true" />
      </button>

      {expanded && (
        <div className="mt-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
          <Markdown className="prose prose-sm max-w-none font-serif dark:prose-invert">
            {content}
          </Markdown>
        </div>
      )}
    </div>
  );
}
