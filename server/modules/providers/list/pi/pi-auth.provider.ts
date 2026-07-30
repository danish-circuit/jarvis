import { readFile } from 'node:fs/promises';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { getPiAgentDir, readObjectRecord, readOptionalString } from '@/shared/utils.js';

type PiCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

/**
 * Provider API keys Pi picks up straight from the environment, in display
 * priority order — the first one that is set is what the auth status reports.
 * Each name is the env var Pi's own provider catalog reads, so a key listed
 * here also makes that provider's models show up in `pi --list-models`.
 *
 * Fireworks leads because that is the provider this deployment runs on; the box
 * also carries an `ANTHROPIC_API_KEY` for Claude Code, which would otherwise
 * mask it.
 */
const PI_ENV_CREDENTIAL_KEYS = [
  'FIREWORKS_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'CEREBRAS_API_KEY',
  'TOGETHER_API_KEY',
];

export class PiProviderAuth implements IProviderAuth {
  /**
   * Checks whether the Pi CLI is available to the server process.
   */
  private checkInstalled(): boolean {
    try {
      const result = spawn.sync('pi', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return !result.error && result.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Returns Pi CLI installation and credential status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'pi',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads Pi's auth store or falls back to provider API key environment variables.
   *
   * `auth.json` is a `Record<providerId, Credential>` holding either API keys or
   * OAuth tokens (Pi writes it with mode 0600). Any provider entry carrying a
   * value counts as authenticated — resolving which model that unlocks is the
   * models provider's job, not this one's.
   */
  private async checkCredentials(): Promise<PiCredentialsStatus> {
    try {
      const authPath = path.join(getPiAgentDir(), 'auth.json');
      const content = await readFile(authPath, 'utf8');
      const auth = readObjectRecord(JSON.parse(content)) ?? {};

      for (const [providerId, providerAuth] of Object.entries(auth)) {
        const hasCredential = readOptionalString(providerAuth) !== undefined
          || Object.values(readObjectRecord(providerAuth) ?? {}).some(
            (value) => readOptionalString(value) !== undefined || Boolean(readObjectRecord(value)),
          );
        if (hasCredential) {
          return {
            authenticated: true,
            email: `${providerId} credentials`,
            method: 'credentials_file',
          };
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        return {
          authenticated: false,
          email: null,
          method: null,
          error: error instanceof Error ? error.message : 'Failed to read Pi auth',
        };
      }
    }

    const envCredential = PI_ENV_CREDENTIAL_KEYS.find((key) => process.env[key]?.trim());
    if (envCredential) {
      return {
        authenticated: true,
        email: envCredential,
        method: 'environment',
      };
    }

    return {
      authenticated: false,
      email: null,
      method: null,
      error: 'Pi not configured',
    };
  }
}
