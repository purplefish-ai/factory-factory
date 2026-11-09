import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { PR_DELIVERY_BLOCKED_PAUSE_REASON } from '@/shared/pr-monitoring';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import type { PrismaClient } from '@prisma-gen/client';
import { readDeliveryEvents } from './workspace-pr-delivery.accessor';
import { workspacePrEventAccessor } from './workspace-pr-event.accessor';
import { workspaceRatchetAccessor } from './workspace-ratchet.accessor';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return database.prisma;
  },
}));
let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
}, 30_000);
afterAll(async () => destroyIntegrationDatabase(db));
beforeEach(async () => {
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await db.prisma.project.create({
    data: { id: 'project', name: 'P', slug: 'p', repoPath: '/tmp/p', worktreeBasePath: '/tmp/w' },
  });
  for (const id of ['w', 'other']) {
    await db.prisma.workspace.create({
      data: {
        id,
        projectId: 'project',
        name: id,
        status: 'READY',
        prMonitoring: { create: { enabled: true } },
      },
    });
    await db.prisma.agentSession.create({
      data: {
        id: `${id}-main`,
        workspaceId: id,
        workflow: 'implement',
        provider: 'CLAUDE',
        providerSessionId: `${id}-provider`,
      },
    });
    await db.prisma.workspacePR.create({
      data: { id: `${id}-pr`, workspaceId: id, url: redObservation.url },
    });
    await db.prisma.workspacePRMonitoring.update({
      where: { workspaceId: id },
      data: { recipientSessionId: `${id}-main` },
    });
  }
});

async function fact(workspaceId: string, key: string) {
  const prId = `${workspaceId}-pr`;
  const [id] = await db.prisma.$transaction((tx) =>
    workspacePrEventAccessor.insert(tx, workspaceId, prId, [
      {
        kind: 'CI_FAILED',
        deduplicationKey: key,
        payload: { kind: 'CI_FAILED', target: { workspaceId, prId }, observation: redObservation },
      },
    ])
  );
  if (!id) {
    throw new Error('Missing event');
  }
  return id;
}

/** Contradictory legacy receipt evidence normalizes to a BLOCKED delivery. */
async function blockLegacyBatch(workspaceId: string, deliveryId: string) {
  const ids = [
    await fact(workspaceId, `${deliveryId}-a`),
    await fact(workspaceId, `${deliveryId}-b`),
  ];
  for (const [index, id] of ids.entries()) {
    await db.prisma.workspacePREvent.update({
      where: { id },
      data: {
        deliveryId,
        deliverySessionId: `${workspaceId}-main`,
        deliveryProvider: 'CLAUDE',
        deliveryProviderSessionId: `${workspaceId}-provider`,
        deliveryBindingRevision: 0,
        deliveryText: index === 0 ? 'original' : 'contradictory',
        state: 'DISPATCHING',
      },
    });
  }
  await db.prisma.$transaction((tx) =>
    workspacePrEventAccessor.renewRetryAllowance(tx, workspaceId)
  );
  expect(
    await db.prisma.workspacePRDelivery.findUnique({ where: { id: deliveryId } })
  ).toMatchObject({ state: 'BLOCKED', workspaceId });
  return ids;
}

function claim(workspaceId: string, deliveryId: string, eventIds: string[]) {
  return workspacePrEventAccessor.claimDelivery(
    { workspaceId, prId: null, bindingRevision: 0 },
    { deliveryId, sessionId: `${workspaceId}-main`, eventIds, text: 'fresh facts' }
  );
}

async function exportWorkspace(workspaceId: string) {
  return workspacePrEventAccessor.exportEvents(
    await db.prisma.workspacePREvent.findMany({ where: { workspaceId } }),
    await db.prisma.workspacePRDelivery.findMany({ where: { workspaceId } })
  );
}

it('projects a blocked delivery as a paused workspace that holds every later claim', async () => {
  await blockLegacyBatch('w', 'legacy-blocked');
  const later = await fact('w', 'later');
  expect(await workspaceRatchetAccessor.findSnapshotProjection('w')).toMatchObject({
    prMonitoring: { pauseReason: PR_DELIVERY_BLOCKED_PAUSE_REASON, pendingEventCount: 3 },
  });
  expect(await claim('w', 'next', [later])).toBeNull();
  expect(await workspaceRatchetAccessor.findSnapshotProjection('other')).toMatchObject({
    prMonitoring: { pauseReason: null, pendingEventCount: 0 },
  });
});

it('keeps a persisted pause reason ahead of the projected blocked reason', async () => {
  await blockLegacyBatch('w', 'legacy-blocked');
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: 'w' },
    data: { deliveryPauseReason: 'USER_STOPPED' },
  });
  expect(await workspaceRatchetAccessor.findSnapshotProjection('w')).toMatchObject({
    prMonitoring: { pauseReason: 'USER_STOPPED' },
  });
});

it('discards a blocked delivery without resending or rewriting its evidence', async () => {
  const members = await blockLegacyBatch('w', 'legacy-blocked');
  await blockLegacyBatch('other', 'other-blocked');
  const before = await db.prisma.workspacePREvent.findMany({
    where: { id: { in: members } },
    orderBy: { id: 'asc' },
  });
  const exportedBefore = await exportWorkspace('w');

  expect(await workspacePrEventAccessor.discardBlockedDeliveries('w')).toEqual({ count: 1 });
  expect(await workspacePrEventAccessor.discardBlockedDeliveries('w')).toEqual({ count: 0 });

  expect(
    await db.prisma.workspacePRDelivery.findUniqueOrThrow({ where: { id: 'legacy-blocked' } })
  ).toMatchObject({ state: 'DISMISSED', eventIds: members });
  expect(
    await db.prisma.workspacePREvent.findMany({
      where: { id: { in: members } },
      orderBy: { id: 'asc' },
    })
  ).toEqual(before);
  expect(
    await db.prisma.workspacePRDelivery.findUniqueOrThrow({ where: { id: 'other-blocked' } })
  ).toMatchObject({ state: 'BLOCKED' });
  // Quarantined evidence still exports verbatim; the dismissal is local.
  expect(await exportWorkspace('w')).toEqual(exportedBefore);

  expect(await workspacePrEventAccessor.listPending('w')).toEqual([]);
  expect(await workspaceRatchetAccessor.findSnapshotProjection('w')).toMatchObject({
    prMonitoring: { pauseReason: null, pendingEventCount: 0 },
  });
  // Dismissed members are never retried, settled, deferred or recovered.
  expect(await claim('w', 'legacy-blocked', members)).toBeNull();
  expect(
    await workspacePrEventAccessor.settleDelivery({
      deliveryId: 'legacy-blocked',
      sessionId: 'w-main',
      bindingRevision: 0,
      result: 'delivered',
    })
  ).toBe(false);
  expect(await workspacePrEventAccessor.deferBusy('legacy-blocked')).toEqual({ count: 0 });
  expect(await workspacePrEventAccessor.recoverClaim('legacy-blocked', true)).toMatchObject({
    count: 0,
  });
  expect(
    await db.prisma.workspacePRDelivery.findUniqueOrThrow({ where: { id: 'legacy-blocked' } })
  ).toMatchObject({ state: 'DISMISSED' });

  const later = await fact('w', 'later');
  expect(await claim('w', 'next', [later])).toMatchObject({ deliveryId: 'next', attempt: 1 });
  expect(await claim('other', 'other-next', [await fact('other', 'later')])).toBeNull();
});

it('keeps export fail-closed for damaged normalized membership after a discard', async () => {
  const ids = [await fact('w', 'a'), await fact('w', 'b')];
  await claim('w', 'damaged', ids);
  await db.prisma.workspacePREvent.delete({ where: { id: ids[1] } });
  expect(
    await workspacePrEventAccessor.settleDelivery({
      deliveryId: 'damaged',
      sessionId: 'w-main',
      bindingRevision: 0,
      result: 'retry',
    })
  ).toBe(false);
  expect(await workspaceRatchetAccessor.findSnapshotProjection('w')).toMatchObject({
    prMonitoring: { pauseReason: PR_DELIVERY_BLOCKED_PAUSE_REASON },
  });

  expect(await workspacePrEventAccessor.discardBlockedDeliveries('w')).toEqual({ count: 1 });
  await expect(exportWorkspace('w')).rejects.toThrow(
    'Cannot export incomplete PR delivery membership'
  );
  expect(await claim('w', 'next', [await fact('w', 'later')])).toMatchObject({
    deliveryId: 'next',
  });
});

it('fails closed when a persisted delivery state is unknown', async () => {
  const ids = [await fact('w', 'a')];
  await claim('w', 'claimed', ids);
  await db.prisma.workspacePRDelivery.update({
    where: { id: 'claimed' },
    data: { state: 'MYSTERY' },
  });
  await expect(readDeliveryEvents(db.prisma, { workspaceId: 'w' })).rejects.toThrow();
  await expect(exportWorkspace('w')).rejects.toThrow();
});
