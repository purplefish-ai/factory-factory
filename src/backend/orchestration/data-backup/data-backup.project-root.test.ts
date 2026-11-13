import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@/backend/services/config.service';
import type { ExportData } from '@/shared/schemas/export-data.schema';

// Every database access is recorded and fails, so a test sees whether the
// import reached the database at all.
const touched = vi.hoisted(() => [] as string[]);
vi.mock('@/backend/db', () => ({
  prisma: new Proxy(
    {},
    {
      get: (_target, property) => {
        touched.push(String(property));
        return () => {
          throw new Error('database reached');
        };
      },
    }
  ),
}));

import { dataBackupService } from './data-backup.service';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ff-import-root-')));
mkdirSync(join(root, 'repo'));
mkdirSync(join(root, 'outside-target'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sandbox = join(root, 'sandbox');
mkdirSync(join(sandbox, 'repo'), { recursive: true });
symlinkSync(join(root, 'outside-target'), join(sandbox, 'link'));

function project(id: string, repoPath: string, worktreeBasePath: string) {
  return {
    id,
    name: `Project ${id}`,
    slug: id,
    repoPath,
    worktreeBasePath,
    defaultBranch: 'main',
    githubOwner: null,
    githubRepo: null,
    issueProvider: 'GITHUB' as const,
    issueTrackerConfig: null,
    isArchived: false,
    startupScriptCommand: null,
    startupScriptPath: null,
    startupScriptTimeout: 300,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function backup(projects: ReturnType<typeof project>[]): ExportData {
  return {
    meta: { exportedAt: '2026-01-01T00:00:00.000Z', version: '1.0.0', schemaVersion: 7 },
    data: {
      projects,
      workspaces: [],
      agentSessions: [],
      codexAccounts: [],
      terminalSessions: [],
      userSettings: null,
    },
  };
}

const inside = project('inside', join(sandbox, 'repo'), join(sandbox, 'worktrees', 'inside'));

beforeEach(() => {
  touched.length = 0;
  vi.restoreAllMocks();
});

describe('backup import with a project root', () => {
  it('refuses the whole import, before any write, naming the first project outside', async () => {
    vi.spyOn(configService, 'getProjectRoot').mockReturnValue(sandbox);
    const repoOutside = project('repo-out', join(root, 'repo'), join(sandbox, 'worktrees', 'a'));
    const worktreesOutside = project('worktrees-out', join(sandbox, 'repo'), join(root, 'wt'));

    await expect(
      dataBackupService.importData(backup([inside, repoOutside, worktreesOutside]))
    ).rejects.toThrow(
      `Backup project "Project repo-out" (repo-out) cannot be imported: Path ${join(root, 'repo')} is outside the project root ${sandbox}`
    );
    expect(touched).toEqual([]);

    // A worktree base path that escapes through a link inside the root.
    const escaping = project('escaping', join(sandbox, 'repo'), `${sandbox}/link/../wt`);
    await expect(dataBackupService.importData(backup([inside, escaping]))).rejects.toThrow(
      `Backup project "Project escaping" (escaping) cannot be imported: Path ${sandbox}/link/../wt is outside the project root ${sandbox}`
    );
    expect(touched).toEqual([]);
  });

  it('lets an import whose projects are all inside the root proceed', async () => {
    vi.spyOn(configService, 'getProjectRoot').mockReturnValue(sandbox);
    await expect(dataBackupService.importData(backup([inside]))).rejects.toThrow(
      'database reached'
    );
    expect(touched).not.toEqual([]);
  });

  it('checks nothing when no root is configured', async () => {
    vi.spyOn(configService, 'getProjectRoot').mockReturnValue(null);
    const elsewhere = project('elsewhere', '/elsewhere/repo', '/elsewhere/worktrees');
    await expect(dataBackupService.importData(backup([elsewhere]))).rejects.toThrow(
      'database reached'
    );
    expect(touched).not.toEqual([]);
  });
});
