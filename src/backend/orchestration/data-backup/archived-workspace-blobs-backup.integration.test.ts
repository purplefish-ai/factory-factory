import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { archivedWorkspaceBlobRetentionService } from '@/backend/services/workspace';
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
const attachment = { id: 'a1', name: 'shot.png', type: 'image/png', size: 4, data: 'iVBORw0K' };
const prompt = { initialPrompt: 'Fix the login race' };
const withAttachments = { ...prompt, initialAttachments: [attachment] };

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
  for (const [id, status] of [
    ['archived', 'ARCHIVED'],
    ['failed', 'FAILED'],
  ] as const) {
    await db.prisma.workspace.create({
      data: {
        id,
        projectId: 'project',
        name: id,
        status,
        creationMetadata: withAttachments,
        initOutput: 'setup log\n',
      },
    });
  }
});

async function exportBackup() {
  return exportDataSchema.parse(
    JSON.parse(JSON.stringify(await dataBackupService.exportData('test')))
  );
}

async function metadataById() {
  const rows = await db.prisma.workspace.findMany({
    select: { id: true, creationMetadata: true, initOutput: true },
    orderBy: { id: 'asc' },
  });
  return Object.fromEntries(rows.map(({ id, ...row }) => [id, row]));
}

it('roundtrips an archived workspace whose attachments and setup log were released', async () => {
  await archivedWorkspaceBlobRetentionService.releaseBacklog();
  const backup = await exportBackup();
  expect(backup.data.workspaces.find((row) => row.id === 'archived')).toMatchObject({
    creationMetadata: prompt,
    initOutput: null,
  });

  await clearIntegrationDatabase(db.prisma);
  await dataBackupService.importData(backup);

  expect(await metadataById()).toEqual({
    archived: { creationMetadata: prompt, initOutput: null },
    failed: { creationMetadata: withAttachments, initOutput: 'setup log\n' },
  });
});

it('imports an older backup that still carries attachments, then releases the archived rows', async () => {
  const olderBackup = await exportBackup();
  expect(olderBackup.data.workspaces.map((row) => row.creationMetadata)).toEqual([
    withAttachments,
    withAttachments,
  ]);

  await clearIntegrationDatabase(db.prisma);
  await dataBackupService.importData(olderBackup);
  expect((await metadataById()).archived?.creationMetadata).toEqual(withAttachments);

  expect(await archivedWorkspaceBlobRetentionService.releaseBacklog()).toMatchObject({
    released: 1,
    complete: true,
  });
  expect(await metadataById()).toEqual({
    archived: { creationMetadata: prompt, initOutput: null },
    failed: { creationMetadata: withAttachments, initOutput: 'setup log\n' },
  });
});
