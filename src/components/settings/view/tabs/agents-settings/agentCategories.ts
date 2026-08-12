import type { AgentCategory, AgentProvider } from '../../../types/types';

/**
 * Settings categories each agent actually has something to show.
 *
 * Single source of truth for both the tab strip and the content pane, so a
 * provider can never render a panel that its tab does not offer (or vice
 * versa). Previously each site carried its own `selectedAgent !== '...'` check
 * and they had to be kept in sync by hand.
 *
 * Pi has no built-in MCP support; its MCP tab manages the config files the
 * `pi-mcp-adapter` extension reads, so the category only does something when
 * that extension is installed.
 */
const AGENT_CATEGORY_OVERRIDES: Partial<Record<AgentProvider, AgentCategory[]>> = {
  pi: ['account', 'permissions', 'mcp', 'skills'],
};

const DEFAULT_AGENT_CATEGORIES: AgentCategory[] = ['account', 'permissions', 'mcp', 'skills'];

export function getVisibleAgentCategories(agent: AgentProvider): AgentCategory[] {
  return AGENT_CATEGORY_OVERRIDES[agent] ?? DEFAULT_AGENT_CATEGORIES;
}

export function isAgentCategoryVisible(agent: AgentProvider, category: AgentCategory): boolean {
  return getVisibleAgentCategories(agent).includes(category);
}
