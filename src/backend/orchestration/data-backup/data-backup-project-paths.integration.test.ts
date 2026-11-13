import { afterAll, beforeAll, expect, it, vi } from 'vitest';
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

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
}, 30_000);
afterAll(async () => {
  vi.restoreAllMocks();
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});

it('imports project paths unchanged when no project root is set', async () => {
  vi.spyOn(configService, 'getProjectRoot').mockReturnValue(null);
  // Not normalized on purpose: import must not resolve or rewrite either path.
  const repoPath = '/Users/someone/Code/My Repo/../my-repo';
  const worktreeBasePath = '/Volumes/External/worktrees/my-repo/';
  await db.prisma.project.create({
    data: { id: 'project', name: 'Project', slug: 'project', repoPath, worktreeBasePath },
  });
  const backup = exportDataSchema.parse(
    JSON.parse(JSON.stringify(await dataBackupService.exportData('test')))
  );

  await clearIntegrationDatabase(db.prisma);
  await dataBackupService.importData(backup);

  expect(await db.prisma.project.findUnique({ where: { id: 'project' } })).toMatchObject({
    repoPath,
    worktreeBasePath,
  });
});
