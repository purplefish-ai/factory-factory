import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { prFactPayloadSchema } from '@/shared/schemas/pr-event.schema';
import type { PrismaClient } from '@prisma-gen/client';
import { workspacePRMonitoringService } from './workspace-pr-monitoring.service';

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
      name: 'w',
      status: 'READY',
      prs: { create: { id: 'p', url: redObservation.url } },
    },
  });
}, 30_000);
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});

const review = {
  identity: 'r1',
  contentHash: 'r1-hash',
  author: 'reviewer',
  body: 'Please fix this',
  path: 'a.ts',
  line: 1,
  url: redObservation.url,
  activityAt: redObservation.observedAt,
};

it('scans the ledger again after a backup restore brings back review lists', async () => {
  // The process's pass reaches the end of the ledger and then reads nothing.
  expect((await workspacePRMonitoringService.runEventRetention()).reviewLists).toMatchObject({
    complete: true,
  });
  expect((await workspacePRMonitoringService.runEventRetention()).reviewLists).toEqual({
    slimmed: 0,
    batches: 0,
    complete: true,
  });

  await db.prisma.$transaction((tx) =>
    workspacePRMonitoringService.restoreEventsBackup(tx, 'w', [
      {
        id: 'restored',
        workspaceId: 'w',
        prId: 'p',
        kind: 'CI_FAILED',
        deduplicationKey: 'p:epoch:1:restored',
        payload: {
          kind: 'CI_FAILED',
          target: { workspaceId: 'w', prId: 'p' },
          observation: { ...redObservation, actionableReviews: [review] },
        },
        state: 'DELIVERED',
        attempts: 0,
        deliveryId: null,
        deliverySessionId: null,
        deliveryBindingRevision: null,
        deliveryText: null,
        claimedAt: null,
        deliveredAt: null,
        createdAt: new Date().toISOString(),
      },
    ])
  );

  expect((await workspacePRMonitoringService.runEventRetention()).reviewLists).toEqual({
    slimmed: 1,
    batches: 1,
    complete: true,
  });
  const row = await db.prisma.workspacePREvent.findUniqueOrThrow({ where: { id: 'restored' } });
  expect(prFactPayloadSchema.parse(row.payload).observation.actionableReviews).toEqual([]);
});
