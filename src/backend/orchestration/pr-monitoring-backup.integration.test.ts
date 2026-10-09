import type { PrismaClient } from '@prisma-gen/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
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
it('round trips every PR, pause and frozen delivery without treating legacy hashes as receipts', async () => {
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
      id: 'w',
      projectId: 'project',
      name: 'Workspace',
      status: 'READY',
      prs: {
        create: [
          { id: 'p1', url: 'https://github.com/org/repo/pull/1' },
          { id: 'p2', url: 'https://github.com/org/repo/pull/2' },
        ],
      },
      prMonitoring: {
        create: {
          enabled: true,
          bindingRevision: 7,
          eventEpoch: 2,
          deliveryPauseReason: 'USER_STOPPED',
        },
      },
    },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 'main',
      workspaceId: 'w',
      workflow: 'implement',
      model: 'sonnet',
      provider: 'CLAUDE',
      providerSessionId: 'existing-conversation',
    },
  });
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: 'w' },
    data: { recipientSessionId: 'main' },
  });
  await db.prisma.workspacePREvent.create({
    data: {
      id: 'event',
      workspaceId: 'w',
      prId: null,
      kind: 'MONITORING_ENABLED',
      deduplicationKey: 'enabled:7',
      payload: {
        kind: 'MONITORING_ENABLED',
        workspaceId: 'w',
        bindingRevision: 7,
        replyToPrComments: true,
      },
      state: 'DISPATCHING',
      attempts: 1,
      deliveryId: 'frozen-id',
      deliverySessionId: 'main',
      deliveryProvider: 'CLAUDE',
      deliveryProviderSessionId: 'existing-conversation',
      deliveryBindingRevision: 7,
      deliveryText: '<!-- factory-factory-pr-event:frozen-id -->\nKeep PRs moving',
    },
  });
  const backup = exportDataSchema.parse(await dataBackupService.exportData('test'));
  expect(backup.meta.schemaVersion).toBe(6);
  await db.prisma.workspace.delete({ where: { id: 'w' } });
  await dataBackupService.importData(backup);
  expect(await db.prisma.workspacePR.findMany({ where: { workspaceId: 'w' } })).toHaveLength(2);
  expect(
    await db.prisma.workspacePRMonitoring.findUnique({ where: { workspaceId: 'w' } })
  ).toMatchObject({
    recipientSessionId: 'main',
    deliveryPauseReason: 'USER_STOPPED',
    bindingRevision: 7,
  });
  expect(await db.prisma.workspacePREvent.findUnique({ where: { id: 'event' } })).toMatchObject({
    state: 'DISPATCHING',
    deliveryId: 'frozen-id',
    deliveryProvider: 'CLAUDE',
    deliveryProviderSessionId: 'existing-conversation',
    deliveryText: '<!-- factory-factory-pr-event:frozen-id -->\nKeep PRs moving',
  });
  expect(await db.prisma.agentSession.findUnique({ where: { id: 'main' } })).toMatchObject({
    providerSessionId: 'existing-conversation',
    providerProcessPid: null,
  });
});
