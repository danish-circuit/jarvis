import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';

/**
 * MCP facet for Pi — deliberately empty, because Pi has no MCP support.
 *
 * Pi's docs are explicit that MCP is not built in and suggest extensions or
 * CLI-tools-with-READMEs instead. Declaring zero supported scopes makes the
 * shared base class do the right thing without any provider-specific branching
 * in the services above it: `listServers` yields an all-empty record,
 * `listServersForScope` returns `[]`, and `upsertServer`/`removeServer` reject
 * with `MCP_SCOPE_NOT_SUPPORTED` (400).
 *
 * The Settings UI hides the MCP tab for Pi (see `visibleCategories` in
 * `AgentsSettingsTab.tsx`), so those 400s are a backstop for direct API callers
 * rather than something a user can trigger by clicking.
 */
export class PiMcpProvider extends McpProvider {
  constructor() {
    super('pi', [], []);
  }

  protected async readScopedServers(): Promise<Record<string, unknown>> {
    return {};
  }

  protected async writeScopedServers(): Promise<void> {
    // Unreachable: assertScope rejects every scope before a write is attempted.
  }

  protected buildServerConfig(_input: UpsertProviderMcpServerInput): Record<string, unknown> {
    // Unreachable: assertScopeAndTransport rejects before a config is built.
    return {};
  }

  protected normalizeServerConfig(
    _scope: McpScope,
    _name: string,
    _rawConfig: unknown,
  ): ProviderMcpServer | null {
    return null;
  }
}
