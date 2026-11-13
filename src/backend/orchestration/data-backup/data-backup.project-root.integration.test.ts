import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { configService } from '@/backend/services/config.service';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import type { PrismaClient } from '@prisma-gen/client';
import { dataBackupService } from './data-backup.service';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!database.prisma) {
      throw new Error('Missing test database');
    }
    return database.prisma;
  },
}));

// <scratch>/sandbox is the project root; <scratch>/elsewhere lies outside it.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ff-import-root-')));
const sandbox = join(scratch, 'sandbox');
mkdirSync(join(sandbox, 'repo'), { recursive: true });
mkdirSync(join(scratch, 'elsewhere'));
symlinkSync(join(sandbox, 'repo'), join(sandbox, 'alias'));

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
}, 30_000);
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  await clearIntegrationDatabase(db.prisma);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A real backup of one project and one workspace with the given paths. */
async function backupWith(paths: { repoPath: string; worktreePath: string }) {
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: paths.repoPath,
      worktreeBasePath: join(sandbox, 'worktrees'),
    },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'workspace',
      projectId: 'project',
      name: 'Fix login',
      status: 'READY',
      worktreePath: paths.worktreePath,
    },
  });
  const backup = exportDataSchema.parse(await dataBackupService.exportData('test'));
  await clearIntegrationDatabase(db.prisma);
  return backup;
}

it('refuses a whole import whose workspace worktree lies outside the project root', async () => {
  const outside = join(scratch, 'elsewhere', 'worktree');
  const backup = await backupWith({ repoPath: join(sandbox, 'repo'), worktreePath: outside });
  vi.spyOn(configService, 'getProjectRoot').mockReturnValue(sandbox);

  await expect(dataBackupService.importData(backup)).rejects.toThrow(
    `Backup workspace "Fix login" (workspace) cannot be imported: Path ${outside} is outside the project root ${sandbox}`
  );
  expect(await db.prisma.project.count()).toBe(0);
  expect(await db.prisma.workspace.count()).toBe(0);
});

it('stores the real project paths it checked when a project root is set', async () => {
  const backup = await backupWith({
    repoPath: join(sandbox, 'alias'),
    worktreePath: join(sandbox, 'worktrees', 'project', 'fix-login'),
  });
  vi.spyOn(configService, 'getProjectRoot').mockReturnValue(sandbox);

  await dataBackupService.importData(backup);
  expect(await db.prisma.project.findUniqueOrThrow({ where: { id: 'project' } })).toMatchObject({
    repoPath: join(sandbox, 'repo'),
    worktreeBasePath: join(sandbox, 'worktrees'),
  });
});

it('imports every path as given when no project root is set', async () => {
  const outside = join(scratch, 'elsewhere', 'worktree');
  const backup = await backupWith({ repoPath: join(sandbox, 'alias'), worktreePath: outside });
  vi.spyOn(configService, 'getProjectRoot').mockReturnValue(null);

  await dataBackupService.importData(backup);
  expect(await db.prisma.project.findUniqueOrThrow({ where: { id: 'project' } })).toMatchObject({
    repoPath: join(sandbox, 'alias'),
  });
  expect(await db.prisma.workspace.findUniqueOrThrow({ where: { id: 'workspace' } })).toMatchObject(
    { worktreePath: outside }
  );
});
