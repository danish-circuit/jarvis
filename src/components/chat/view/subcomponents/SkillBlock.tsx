import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Sparkles } from 'lucide-react';

import { Markdown } from './Markdown';

/**
 * Renders a skill load as a collapsed block instead of a user-message dump.
 * When the agent invokes the `Skill` tool, Claude Code injects the skill's
 * SKILL.md as a synthetic user turn; this folds it behind a "Skill: <name>"
 * toggle, expandable to show the loaded instructions.
 */
export default function SkillBlock({ name, content }: { name?: string; content: string }) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);

  const label = name
    ? t('skill.titleNamed', { defaultValue: 'Skill: {{name}}', name })
    : t('skill.title', { defaultValue: 'Skill loaded' });

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
        <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-amber-500 dark:text-amber-400" />
        <span className="font-medium">{label}</span>
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
