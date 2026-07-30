import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import {
  addUniqueProviderSkillSource,
  findTopmostGitRoot,
  getPiAgentDir,
} from '@/shared/utils.js';

/**
 * Pi invokes skills as `/skill:<name>` rather than the bare `/<name>` used by
 * Claude and Cursor, so it needs the `commandForSkill` escape hatch instead of
 * the simple `commandPrefix` the other providers use.
 */
const buildPiSkillCommand = (skillName: string): string => `/skill:${skillName}`;

const PI_PROJECT_SKILL_DIRS = [
  ['.pi', 'skills'],
  ['.agents', 'skills'],
];

export class PiSkillsProvider extends SkillsProvider {
  constructor() {
    super('pi');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);

    for (const projectRoot of this.getProjectSearchRoots(workspacePath, repoRoot)) {
      for (const skillDir of PI_PROJECT_SKILL_DIRS) {
        // Pi reads `.agents/skills` alongside its own folder so a skill library
        // can be shared with other compatible coding agents.
        addUniqueProviderSkillSource(sources, seenRootDirs, {
          scope: 'project',
          rootDir: path.join(projectRoot, ...skillDir),
          commandForSkill: buildPiSkillCommand,
        });
      }
    }

    // The user-scoped skills folder lives under Pi's agent dir, which
    // PI_CODING_AGENT_DIR can relocate, so resolve it rather than assuming ~/.pi.
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: path.join(getPiAgentDir(), 'skills'),
      commandForSkill: buildPiSkillCommand,
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.agents', 'skills'),
      commandForSkill: buildPiSkillCommand,
    });

    return sources;
  }

  /**
   * Pi owns a writable user skills folder, so managed skill install/remove works
   * (unlike OpenCode, which only ever borrowed other providers' folders).
   */
  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(getPiAgentDir(), 'skills'),
      commandForSkill: buildPiSkillCommand,
    };
  }

  private getProjectSearchRoots(workspacePath: string, repoRoot: string | null): string[] {
    const roots: string[] = [];
    const normalizedWorkspacePath = path.resolve(workspacePath);
    const normalizedRepoRoot = repoRoot ? path.resolve(repoRoot) : null;
    let currentPath = normalizedWorkspacePath;

    while (true) {
      roots.push(currentPath);
      if (!normalizedRepoRoot || currentPath === normalizedRepoRoot) {
        break;
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        break;
      }

      currentPath = parentPath;
    }

    return roots;
  }
}
