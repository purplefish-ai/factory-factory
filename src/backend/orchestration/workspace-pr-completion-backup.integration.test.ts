import { afterAll, beforeAll, expect, it, vi } from 'vitest';
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
afterAll(async () => destroyIntegrationDatabase(db));

it('preserves dismissed terminal completion and its first observation through export and import', async () => {
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: '/tmp/repo',
      worktreeBasePath: '/tmp/worktrees',
    },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'workspace',
      projectId: 'project',
      name: 'Workspace',
      status: 'READY',
      prs: {
        create: {
          id: 'merged-pr',
          url: 'https://github.com/org/repo/pull/42',
          number: 42,
          state: 'MERGED',
          completionDismissed: true,
          terminalObservedAt: new Date('2026-11-04T12:00:00.000Z'),
          syncedAt: new Date('2026-11-04T12:02:00.000Z'),
          revision: 7,
        },
      },
    },
  });

  const backup = exportDataSchema.parse(
    JSON.parse(JSON.stringify(await dataBackupService.exportData('test')))
  );
  expect(backup.data.workspaces[0]?.prs[0]).toMatchObject({
    id: 'merged-pr',
    state: 'MERGED',
    completionDismissed: true,
    terminalObservedAt: '2026-11-04T12:00:00.000Z',
    syncedAt: '2026-11-04T12:02:00.000Z',
    revision: 7,
  });

  await clearIntegrationDatabase(db.prisma);
  expect(await dataBackupService.importData(backup)).toMatchObject({
    workspaces: { imported: 1, skipped: 0 },
  });
  expect(
    await db.prisma.workspacePR.findUniqueOrThrow({ where: { id: 'merged-pr' } })
  ).toMatchObject({
    workspaceId: 'workspace',
    state: 'MERGED',
    completionDismissed: true,
    terminalObservedAt: new Date('2026-11-04T12:00:00.000Z'),
    syncedAt: new Date('2026-11-04T12:02:00.000Z'),
    revision: 7,
  });
});
