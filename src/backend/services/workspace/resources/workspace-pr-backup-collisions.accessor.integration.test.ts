import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { prEventBackupSchema } from '@/shared/schemas/pr-monitoring-backup.schema';
import type { PrismaClient } from '@prisma-gen/client';
import { workspacePrEventAccessor } from './workspace-pr-event.accessor';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return state.prisma;
  },
}));
let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
}, 30_000);
beforeEach(async () => {
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await db.prisma.project.create({
    data: { id: 'p', slug: 'p', name: 'P', repoPath: '/p', worktreeBasePath: '/w' },
  });
  await db.prisma.workspace.create({ data: { id: 'w', projectId: 'p', name: 'W' } });
});
afterAll(async () => destroyIntegrationDatabase(db));
function event(id: string, deliveryId: string | null) {
  return prEventBackupSchema.parse({
    id,
    workspaceId: 'w',
    prId: null,
    kind: 'MONITORING_ENABLED',
    deduplicationKey: id,
    payload: {
      kind: 'MONITORING_ENABLED',
      workspaceId: 'w',
      bindingRevision: 0,
      replyToPrComments: false,
    },
    state: 'PENDING',
    attempts: 1,
    deliveryId,
    deliverySessionId: 'missing-historical-session',
    deliveryProvider: 'CLAUDE',
    deliveryProviderSessionId: 'provider',
    deliveryBindingRevision: 0,
    deliveryText: 'imported proof',
    claimedAt: '2026-01-01T00:00:00.000Z',
    deliveredAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}
it.each(['raw-only', 'normalized', 'batch-only', 'event', 'dedup'] as const)(
  'rejects a whole incoming list before its first insert on %s evidence without depending on transaction rollback',
  async (kind) => {
    if (kind === 'normalized' || kind === 'batch-only') {
      await db.prisma.workspacePRDelivery.create({
        data: { id: 'collision', workspaceId: 'w', state: 'BLOCKED', eventIds: [] },
      });
    }
    if (kind !== 'normalized') {
      await db.prisma.workspacePREvent.create({
        data: {
          id: kind === 'event' ? 'incoming-second' : 'retained',
          workspaceId: 'w',
          kind: 'MONITORING_ENABLED',
          payload: { kind: 'MONITORING_ENABLED' },
          deduplicationKey: kind === 'dedup' ? 'incoming-second' : 'local',
          deliveryId: kind === 'raw-only' ? 'collision' : null,
          batchId: kind === 'batch-only' ? 'collision' : null,
          deliveryText: 'local proof',
          attempts: 3,
        },
      });
    }
    const before = await db.prisma.workspacePREvent.findMany();
    const deliveries = await db.prisma.workspacePRDelivery.findMany();
    await db.prisma.$transaction(async (tx) => {
      await expect(
        workspacePrEventAccessor.restoreBackup(
          tx,
          'w',
          [event('incoming-first', null), event('incoming-second', 'collision')],
          { inert: true }
        )
      ).rejects.toThrow();
      expect(await tx.workspacePREvent.findMany()).toEqual(before);
      expect(await tx.workspacePRDelivery.findMany()).toEqual(deliveries);
    });
  }
);

it('validates every payload owner before inserting earlier members when the caller catches an error', async () => {
  const invalid = event('invalid-second', null);
  invalid.payload = {
    kind: 'MONITORING_ENABLED',
    workspaceId: 'foreign',
    bindingRevision: 0,
    replyToPrComments: false,
  };
  await db.prisma.$transaction(async (tx) => {
    await expect(
      workspacePrEventAccessor.restoreBackup(tx, 'w', [event('valid-first', null), invalid])
    ).rejects.toThrow('Imported event payload target is invalid');
    expect(await tx.workspacePREvent.count()).toBe(0);
  });
});
