import { ArrowUpCircle, CheckCircle2, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge, Button } from '../../../../../../../shared/view/ui';
import type { AgentProvider } from '../../../../../types/types';
import { useProviderCliVersion } from '../../hooks/useProviderCliVersion';

type CliVersionSectionProps = {
  agent: AgentProvider;
  textClass: string;
  subtextClass: string;
  buttonClass: string;
};

/**
 * Shows the version of the CLI this server runs for the agent, and upgrades it
 * in place.
 *
 * The version shown is the one the server *resolves and spawns*, which is not
 * necessarily the newest copy installed on the machine — a box can carry both
 * a system install and a user-prefix one. Reporting the resolved binary is
 * what makes "you are up to date" mean your sessions are up to date.
 */
export default function CliVersionSection({
  agent,
  textClass,
  subtextClass,
  buttonClass,
}: CliVersionSectionProps) {
  const { t } = useTranslation('settings');
  const { version, update, refresh, runUpdate } = useProviderCliVersion(agent);

  // Providers without a managed CLI simply do not get this section.
  if (!version.supported) {
    return null;
  }

  const busy = version.loading || update.running;

  const statusLine = (() => {
    if (version.loading) {
      return t('agents.cli.checking', { defaultValue: 'Checking installed version…' });
    }
    if (version.error) {
      return t('agents.cli.error', { defaultValue: 'Could not read version: {{error}}', error: version.error });
    }
    if (!version.currentVersion) {
      return t('agents.cli.notInstalled', { defaultValue: 'CLI not found on this machine' });
    }
    if (version.updateAvailable && version.latestVersion) {
      return t('agents.cli.updateAvailable', {
        defaultValue: 'Version {{current}} installed · {{latest}} available',
        current: version.currentVersion,
        latest: version.latestVersion,
      });
    }
    return t('agents.cli.upToDate', {
      defaultValue: 'Version {{current}} · up to date',
      current: version.currentVersion,
    });
  })();

  const outcomeLine = (() => {
    if (update.running || !update.outcome) {
      return null;
    }
    if (update.outcome === 'updated') {
      return {
        tone: 'text-green-600 dark:text-green-400',
        icon: <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />,
        text: t('agents.cli.updated', { defaultValue: 'Updated {{change}}', change: update.message ?? '' }),
      };
    }
    if (update.outcome === 'failed') {
      return {
        tone: 'text-red-600 dark:text-red-400',
        icon: <TriangleAlert className="h-3.5 w-3.5 flex-shrink-0" />,
        text: t('agents.cli.updateFailed', { defaultValue: 'Update failed: {{error}}', error: update.message ?? '' }),
      };
    }
    // The updater ran but the binary we launch did not move — usually a second
    // install shadowing this one, which no button can safely resolve.
    if (update.message) {
      return {
        tone: 'text-amber-600 dark:text-amber-400',
        icon: <TriangleAlert className="h-3.5 w-3.5 flex-shrink-0" />,
        text: t('agents.cli.updateNoop', {
          defaultValue: 'Updater ran but {{path}} is unchanged ({{state}}) — another install may be shadowing it',
          path: version.executablePath ?? 'the CLI',
          state: update.message,
        }),
      };
    }
    return {
      tone: subtextClass,
      icon: <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />,
      text: t('agents.cli.alreadyCurrent', { defaultValue: 'Already on the latest version' }),
    };
  })();

  return (
    <div className="border-t border-border/50 pt-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className={`flex items-center gap-2 font-medium ${textClass}`}>
            {t('agents.cli.title', { defaultValue: 'CLI version' })}
            {version.updateAvailable && (
              <Badge
                variant="secondary"
                className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
              >
                {t('agents.cli.updateBadge', { defaultValue: 'Update available' })}
              </Badge>
            )}
          </div>
          <div className={`truncate text-sm ${subtextClass}`} title={version.executablePath ?? undefined}>
            {statusLine}
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          <Button
            onClick={() => void refresh()}
            disabled={busy}
            size="sm"
            variant="ghost"
            aria-label={t('agents.cli.recheck', { defaultValue: 'Re-check version' })}
          >
            <RefreshCw className={`h-4 w-4 ${version.loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            onClick={() => void runUpdate()}
            disabled={busy || !version.currentVersion}
            size="sm"
            className={`${buttonClass} text-white`}
          >
            {update.running ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ArrowUpCircle className="mr-2 h-4 w-4" />
            )}
            {update.running
              ? t('agents.cli.updating', { defaultValue: 'Updating…' })
              : t('agents.cli.updateButton', { defaultValue: 'Update CLI' })}
          </Button>
        </div>
      </div>

      {outcomeLine && (
        <div className={`mt-2 flex items-start gap-1.5 text-sm ${outcomeLine.tone}`}>
          {outcomeLine.icon}
          <span className="min-w-0">{outcomeLine.text}</span>
        </div>
      )}
    </div>
  );
}
