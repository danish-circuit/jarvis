import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  getPiAgentDir,
  readJsonConfig,
  readObjectRecord,
  readStringArray,
  readStringRecord,
  writeJsonConfig,
} from '@/shared/utils.js';

/**
 * MCP facet for Pi, backed by the config files the `pi-mcp-adapter` extension
 * reads. Pi has no built-in MCP support, so these files are only meaningful
 * when the user has installed that extension.
 *
 * Only Pi-owned files are read and written — the user-global
 * `<Pi agent dir>/mcp.json` and the project-local `.pi/mcp.json` — so managing
 * servers here never rewrites the shared configs (`.mcp.json`,
 * `~/.config/mcp/mcp.json`) that other tools also consume. Servers defined in
 * those shared files still work in Pi at runtime; they just aren't listed or
 * editable under Pi's scope here.
 *
 * Consumed by `pi.provider.ts`, which exposes it as the provider's MCP facet.
 */
export class PiMcpProvider extends McpProvider {
  constructor() {
    super('pi', ['user', 'project'], ['stdio', 'http']);
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const config = await readJsonConfig(this.scopedFilePath(scope, workspacePath));
    return readObjectRecord(config.mcpServers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const filePath = this.scopedFilePath(scope, workspacePath);
    const config = await readJsonConfig(filePath);
    config.mcpServers = servers;
    await writeJsonConfig(filePath, config);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }

      return {
        command: input.command,
        args: input.args ?? [],
        env: input.env ?? {},
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      url: input.url,
      headers: input.headers ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    if (!rawConfig || typeof rawConfig !== 'object') {
      return null;
    }

    const config = rawConfig as Record<string, unknown>;
    if (typeof config.command === 'string') {
      return {
        provider: 'pi',
        name,
        scope,
        transport: 'stdio',
        command: config.command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
      };
    }

    if (typeof config.url === 'string') {
      return {
        provider: 'pi',
        name,
        scope,
        transport: 'http',
        url: config.url,
        headers: readStringRecord(config.headers),
      };
    }

    return null;
  }

  private scopedFilePath(scope: McpScope, workspacePath: string): string {
    return scope === 'user'
      ? path.join(getPiAgentDir(), 'mcp.json')
      : path.join(workspacePath, '.pi', 'mcp.json');
  }
}
