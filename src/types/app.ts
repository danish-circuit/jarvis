export type LLMProvider = 'claude' | 'cursor' | 'codex' | 'pi';

/** Runtime mirror of {@link LLMProvider}, for validating untrusted values. */
export const LLM_PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'pi'];

/**
 * Narrows an untrusted provider value, falling back to `claude`.
 *
 * `localStorage` outlives any given build, so it can still hold the id of a
 * provider that has since been removed (`opencode`, for example). Feeding that
 * to the backend produces an `UNSUPPORTED_PROVIDER` 400, so every read of a
 * persisted provider id goes through here.
 */
export function sanitizeProvider(value: unknown): LLMProvider {
  return typeof value === 'string' && LLM_PROVIDERS.includes(value as LLMProvider)
    ? value as LLMProvider
    : 'claude';
}

export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
  recordId?: number;
  isCustom?: boolean;
  effort?: {
    default?: string;
    values: {
      value: string;
      description?: string;
    }[];
  };
};

export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
};

export type CustomProviderModelInput = {
  model: string;
  id: string;
};

export type ProviderModelActions = {
  create(provider: LLMProvider, input: CustomProviderModelInput): Promise<void>;
  update(
    provider: LLMProvider,
    existing: ProviderModelOption,
    input: CustomProviderModelInput,
  ): Promise<void>;
  remove(provider: LLMProvider, existing: ProviderModelOption): Promise<void>;
};

export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'tasks' | 'browser' | `plugin:${string}`;

export interface ProjectSession {
  id: string;
  title?: string;
  summary?: string;
  name?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  lastActivity?: string;
  messageCount?: number;
  provider?: LLMProvider;
  __provider?: LLMProvider;
  // Tags the session with the owning project's DB `projectId` so UI handlers
  // (session switching, sidebar focus, etc.) can match against selectedProject.
  __projectId?: string;
  [key: string]: unknown;
}

export interface ProjectSessionMeta {
  total?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}

export interface ProjectTaskmasterInfo {
  hasTaskmaster?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

// After the projectName → projectId migration the backend no longer returns a
// folder-derived `name` string. Projects are now addressed everywhere by the
// DB-assigned `projectId` (primary key in the `projects` table), and the UI
// uses the same identifier for routing, state keys and API calls.
export interface Project {
  projectId: string;
  displayName: string;
  fullPath: string;
  path?: string;
  isStarred?: boolean;
  sessions?: ProjectSession[];
  sessionMeta?: ProjectSessionMeta;
  taskmaster?: ProjectTaskmasterInfo;
  [key: string]: unknown;
}

export interface LoadingProgress {
  kind?: 'loading_progress';
  phase?: string;
  current: number;
  total: number;
  currentProject?: string;
  [key: string]: unknown;
}
