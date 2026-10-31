import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
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
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});
beforeEach(async () => {
  await clearIntegrationDatabase(db.prisma);
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
    data: { id: 'workspace', projectId: 'project', name: 'Fix login', status: 'READY' },
  });
});

it('roundtrips generated workspace metadata and its source provenance through a JSON backup', async () => {
  await db.prisma.workspaceMetadata.create({
    data: {
      workspaceId: 'workspace',
      requestId: 'request-2',
      title: 'Fix login',
      branch: 'fix-login',
      summary: 'Testing the login race fix.',
      sidebarSummary: 'Testing login',
      generatedAt: new Date('2026-10-30T15:00:00.000Z'),
      sourceSessionId: 'source-session',
      sourceMessageId: 'source-message',
    },
  });
  const backup = exportDataSchema.parse(
    JSON.parse(JSON.stringify(await dataBackupService.exportData('test')))
  );
  expect(backup.data.workspaces[0]?.conversationMetadata).toEqual({
    requestId: 'request-2',
    title: 'Fix login',
    branch: 'fix-login',
    summary: 'Testing the login race fix.',
    sidebarSummary: 'Testing login',
    generatedAt: '2026-10-30T15:00:00.000Z',
    sourceSessionId: 'source-session',
    sourceMessageId: 'source-message',
  });

  await clearIntegrationDatabase(db.prisma);
  await dataBackupService.importData(backup);
  expect(
    await db.prisma.workspaceMetadata.findUnique({ where: { workspaceId: 'workspace' } })
  ).toEqual({
    workspaceId: 'workspace',
    requestId: 'request-2',
    title: 'Fix login',
    branch: 'fix-login',
    summary: 'Testing the login race fix.',
    sidebarSummary: 'Testing login',
    generatedAt: new Date('2026-10-30T15:00:00.000Z'),
    sourceSessionId: 'source-session',
    sourceMessageId: 'source-message',
  });
});

it('roundtrips pending workspace metadata with nullable generated fields', async () => {
  await db.prisma.workspaceMetadata.create({
    data: { workspaceId: 'workspace', requestId: 'pending-request' },
  });
  const backup = exportDataSchema.parse(await dataBackupService.exportData('test'));
  await clearIntegrationDatabase(db.prisma);
  await dataBackupService.importData(backup);
  expect(
    await db.prisma.workspaceMetadata.findUnique({ where: { workspaceId: 'workspace' } })
  ).toEqual({
    workspaceId: 'workspace',
    requestId: 'pending-request',
    title: null,
    branch: null,
    summary: null,
    sidebarSummary: null,
    generatedAt: null,
    sourceSessionId: null,
    sourceMessageId: null,
  });
});

it.each([4, 5, 6, 7])(
  'imports version %s backups without workspace metadata',
  async (schemaVersion) => {
    const exported = await dataBackupService.exportData('test');
    const backup = exportDataSchema.parse({
      ...exported,
      meta: { ...exported.meta, schemaVersion },
      data: {
        ...exported.data,
        workspaces: exported.data.workspaces.map(
          ({ conversationMetadata: _metadata, ...workspace }) => workspace
        ),
      },
    });
    await clearIntegrationDatabase(db.prisma);
    const result = await dataBackupService.importData(backup);
    expect(result.workspaces).toEqual({ imported: 1, skipped: 0 });
    expect(await db.prisma.workspace.count()).toBe(1);
    expect(await db.prisma.workspaceMetadata.count()).toBe(0);
  }
);
