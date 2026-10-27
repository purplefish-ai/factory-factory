import { expect, it, vi } from 'vitest';
import {
  updateProjectSettings,
  type ProjectSettingsPorts,
} from '@/backend/orchestration/project-settings.orchestrator';
import type { Project } from '@prisma-gen/client';

it('rejects opposite startup writes when both readers observe the same pair', async () => {
  const project: Project = {
    id: 'p1',
    name: 'Demo',
    slug: 'demo',
    repoPath: '/repo',
    worktreeBasePath: '/worktrees',
    defaultBranch: 'main',
    githubOwner: null,
    githubRepo: null,
    isArchived: false,
    startupScriptCommand: null,
    startupScriptPath: null,
    startupScriptTimeout: 300,
    issueProvider: 'GITHUB',
    issueTrackerConfig: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  let state = {
    startupScriptCommand: project.startupScriptCommand,
    startupScriptPath: project.startupScriptPath,
  };
  let reads = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  function write(updates: Parameters<ProjectSettingsPorts['update']>[1]) {
    state = {
      startupScriptCommand:
        updates.startupScriptCommand !== undefined
          ? updates.startupScriptCommand
          : state.startupScriptCommand,
      startupScriptPath:
        updates.startupScriptPath !== undefined
          ? updates.startupScriptPath
          : state.startupScriptPath,
    };
    return { ...project, ...state };
  }
  const ports: ProjectSettingsPorts = {
    validateRepoPath: vi.fn().mockResolvedValue({ valid: true }),
    findById: async () => {
      const snapshot = { ...state };
      if (++reads <= 2) {
        if (reads === 2) {
          release();
        }
        await bothRead;
      }
      return snapshot;
    },
    update: async (_id, updates) => write(updates),
    updateIfStartupUnchanged: async (_id, expected, updates) =>
      expected.startupScriptCommand === state.startupScriptCommand &&
      expected.startupScriptPath === state.startupScriptPath
        ? write(updates)
        : null,
    encrypt: vi.fn((key: string) => `encrypted:${key}`),
  };
  const results = await Promise.allSettled([
    updateProjectSettings({ id: project.id, startupScriptCommand: 'pnpm dev' }, ports),
    updateProjectSettings({ id: project.id, startupScriptPath: 'scripts/start.sh' }, ports),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(Boolean(state.startupScriptCommand && state.startupScriptPath)).toBe(false);
});
