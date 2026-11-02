import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { prMonitoringEventPayloadSchema } from '@/shared/schemas/pr-event.schema';
import { prEventBackupSchema } from '@/shared/schemas/pr-monitoring-backup.schema';
import type { PrismaClient } from '@prisma-gen/client';
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
  }
  await db.prisma.agentSession.createMany({
    data: [
      {
        id: 'main',
        workspaceId: 'w',
        workflow: 'implement',
        provider: 'CLAUDE',
        providerSessionId: 'main-provider',
      },
      {
        id: 'dedicated',
        workspaceId: 'w',
        workspacePrId: 'p',
        workflow: 'pr-monitoring',
        provider: 'CODEX',
        providerSessionId: 'dedicated-provider',
      },
      {
        id: 'sibling',
        workspaceId: 'w',
        workspacePrId: 'p2',
        workflow: 'pr-monitoring',
        provider: 'CODEX',
        providerSessionId: 'sibling-provider',
      },
      {
        id: 'foreign',
        workspaceId: 'other',
        workflow: 'pr-monitoring',
        provider: 'CODEX',
        providerSessionId: 'foreign-provider',
      },
    ],
  });
  await db.prisma.workspacePR.createMany({
    data: [
      { id: 'p', workspaceId: 'w', url: redObservation.url },
      { id: 'p2', workspaceId: 'w', url: 'https://github.com/org/repo/pull/2' },
    ],
  });
  await db.prisma.workspacePRDedicatedSession.createMany({
    data: [
      { prId: 'p', sessionId: 'dedicated' },
      { prId: 'p2', sessionId: 'sibling' },
    ],
  });
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: 'w' },
    data: { recipientSessionId: 'main' },
  });
});
async function fact() {
  const [id] = await db.prisma.$transaction((tx) =>
    workspacePrEventAccessor.insert(tx, 'w', 'p', [
      {
        kind: 'CI_FAILED',
        deduplicationKey: 'failure',
        payload: {
          kind: 'CI_FAILED',
          target: { workspaceId: 'w', prId: 'p' },
          observation: redObservation,
        },
      },
    ])
  );
  if (!id) {
    throw new Error('Missing event');
  }
  return id;
}
async function mainBatchFacts() {
  const first = await fact();
  const [second] = await db.prisma.$transaction((tx) =>
    workspacePrEventAccessor.insert(tx, 'w', 'p2', [
      {
        kind: 'CI_FAILED',
        deduplicationKey: 'second',
        payload: {
          kind: 'CI_FAILED',
          target: { workspaceId: 'w', prId: 'p2' },
          observation: redObservation,
        },
      },
    ])
  );
  if (!second) {
    throw new Error('Missing sibling');
  }
  return [first, second];
}
it('stores one frozen multi-PR batch and rejects incomplete membership or stale settlement', async () => {
  const id = await fact();
  const [second] = await db.prisma.$transaction((tx) =>
    workspacePrEventAccessor.insert(tx, 'w', 'p2', [
      {
        kind: 'CI_FAILED',
        deduplicationKey: 'failure-p2',
        payload: {
          kind: 'CI_FAILED',
          target: { workspaceId: 'w', prId: 'p2' },
          observation: redObservation,
        },
      },
    ])
  );
  if (!second) {
    throw new Error('Missing second fact');
  }
  const request = { workspaceId: 'w', prId: null, bindingRevision: 0 };
  const input = {
    deliveryId: 'batch',
    sessionId: 'main',
    eventIds: [id, second],
    text: 'exact frozen multi PR message',
  };
  expect(await workspacePrEventAccessor.claimDelivery(request, input)).toMatchObject({
    attempt: 1,
  });
  const physical = await db.prisma.workspacePREvent.findMany({ where: { batchId: 'batch' } });
  expect(physical.map((e) => e.deliveryText)).toEqual([null, null]);
  expect(await workspacePrEventAccessor.listPending('w')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id, deliveryText: input.text, state: 'DISPATCHING', attempts: 1 }),
      expect.objectContaining({
        id: second,
        deliveryText: input.text,
        state: 'DISPATCHING',
        attempts: 1,
      }),
    ])
  );
  await workspacePrEventAccessor.settleDelivery({
    ...input,
    bindingRevision: 0,
    attempt: 1,
    result: 'retry',
  });
  expect(
    await workspacePrEventAccessor.claimDelivery(request, { ...input, eventIds: [id] })
  ).toBeNull();
  expect(await workspacePrEventAccessor.claimDelivery(request, input)).toMatchObject({
    attempt: 2,
  });
  expect(
    await workspacePrEventAccessor.settleDelivery({
      ...input,
      bindingRevision: 0,
      attempt: 1,
      result: 'delivered',
    })
  ).toBe(false);
  expect(await workspacePrEventAccessor.listPending('w')).toHaveLength(2);
  expect(await workspaceRatchetAccessor.findSnapshotProjection('w')).toMatchObject({
    prMonitoring: { pendingEventCount: 2 },
  });
  expect(
    await workspacePrEventAccessor.settleDelivery({
      ...input,
      bindingRevision: 0,
      attempt: 2,
      result: 'delivered',
    })
  ).toBe(true);
  expect(await workspacePrEventAccessor.listPending('w')).toHaveLength(0);
  expect(await workspaceRatchetAccessor.findSnapshotProjection('w')).toMatchObject({
    prMonitoring: { pendingEventCount: 0 },
  });
});

it('settles provider acceptance after a crash before the database acknowledgement without resending', async () => {
  const eventIds = await mainBatchFacts();
  const request = { workspaceId: 'w', prId: null, bindingRevision: 0 };
  const input = {
    deliveryId: 'accepted-before-crash',
    sessionId: 'main',
    eventIds,
    text: 'accepted prompt',
  };
  expect(await workspacePrEventAccessor.claimDelivery(request, input)).toMatchObject({
    attempt: 1,
  });
  // Provider has the receipt; the process dies before settleDelivery runs.
  expect(await workspacePrEventAccessor.recoverClaim(input.deliveryId, true)).toEqual({
    count: 2,
    status: 'recovered',
  });
  expect(await workspacePrEventAccessor.claimDelivery(request, input)).toBeNull();
  expect(await workspacePrEventAccessor.listPending('w')).toEqual([]);
  expect(
    await db.prisma.workspacePRDelivery.findUnique({ where: { id: input.deliveryId } })
  ).toMatchObject({
    state: 'DELIVERED',
    attempts: 1,
    eventIds,
    text: input.text,
    providerSessionId: 'main-provider',
  });
});

it.each(['lost', 'added legacy member'])(
  'blocks settlement, retry and competing claims when membership is %s',
  async (damage) => {
    const eventIds = await mainBatchFacts();
    const request = { workspaceId: 'w', prId: null, bindingRevision: 0 };
    const input = {
      deliveryId: 'damaged-membership',
      sessionId: 'main',
      eventIds,
      text: 'frozen before corruption',
    };
    await workspacePrEventAccessor.claimDelivery(request, input);
    if (damage === 'lost') {
      await db.prisma.workspacePREvent.delete({ where: { id: eventIds[1] } });
    } else {
      const original = await db.prisma.workspacePREvent.findUniqueOrThrow({
        where: { id: eventIds[0] },
      });
      await db.prisma.workspacePREvent.create({
        data: {
          ...original,
          payload: prMonitoringEventPayloadSchema.parse(original.payload),
          id: 'unexpected-legacy',
          deduplicationKey: 'unexpected',
          batchId: null,
          deliveryId: input.deliveryId,
        },
      });
    }
    expect(await workspacePrEventAccessor.recoverClaim(input.deliveryId, true)).toEqual({
      count: 0,
      status: 'identity_mismatch',
    });
    expect(
      await workspacePrEventAccessor.settleDelivery({
        ...input,
        bindingRevision: 0,
        attempt: 1,
        result: 'retry',
      })
    ).toBe(false);
    expect(
      await db.prisma.workspacePRDelivery.findUnique({ where: { id: input.deliveryId } })
    ).toMatchObject({ state: 'BLOCKED', eventIds, text: input.text, attempts: 1 });
    const remaining = await db.prisma.workspacePREvent.findMany({ where: { workspaceId: 'w' } });
    const deliveries = await db.prisma.workspacePRDelivery.findMany({
      where: { workspaceId: 'w' },
    });
    expect(() => workspacePrEventAccessor.exportEvents(remaining, deliveries)).toThrow(
      'Cannot export incomplete PR delivery membership'
    );
    expect(
      await workspacePrEventAccessor.claimDelivery(request, {
        ...input,
        deliveryId: 'replacement',
        eventIds: [eventIds[0]!],
      })
    ).toBeNull();
  }
);

it('does not reset or settle inconsistent legacy receipt evidence on resume', async () => {
  const eventIds = await mainBatchFacts();
  for (const [index, id] of eventIds.entries()) {
    await db.prisma.workspacePREvent.update({
      where: { id },
      data: {
        deliveryId: 'legacy-inconsistent',
        deliverySessionId: 'main',
        deliveryProvider: 'CLAUDE',
        deliveryProviderSessionId: 'main-provider',
        deliveryBindingRevision: 0,
        deliveryText: index === 0 ? 'original' : 'contradictory',
        attempts: 3,
        state: 'PENDING',
      },
    });
  }
  await db.prisma.$transaction((tx) => workspacePrEventAccessor.renewRetryAllowance(tx, 'w'));
  expect(await workspacePrEventAccessor.recoverClaim('legacy-inconsistent', true)).toEqual({
    count: 0,
    status: 'identity_mismatch',
  });
  expect(
    await db.prisma.workspacePREvent.findMany({
      where: { deliveryId: 'legacy-inconsistent' },
      orderBy: { deliveryText: 'asc' },
      select: { attempts: true, deliveryText: true },
    })
  ).toEqual([
    { attempts: 3, deliveryText: 'contradictory' },
    { attempts: 3, deliveryText: 'original' },
  ]);
});

it('round trips a normalized frozen batch through the compatible event backup without losing receipts', async () => {
  const eventIds = await mainBatchFacts();
  const input = {
    deliveryId: 'backup-receipt',
    sessionId: 'main',
    eventIds,
    text: 'immutable backup message',
  };
  const request = { workspaceId: 'w', prId: null, bindingRevision: 0 };
  await workspacePrEventAccessor.claimDelivery(request, input);
  const rows = await db.prisma.workspacePREvent.findMany({ where: { workspaceId: 'w' } });
  const deliveries = await db.prisma.workspacePRDelivery.findMany({ where: { workspaceId: 'w' } });
  const events = workspacePrEventAccessor
    .exportEvents(rows, deliveries)
    .map(({ batchId: _batchId, ...event }) =>
      prEventBackupSchema.parse({
        ...event,
        createdAt: event.createdAt.toISOString(),
        claimedAt: event.claimedAt?.toISOString() ?? null,
        deliveredAt: event.deliveredAt?.toISOString() ?? null,
      })
    );
  await db.prisma.workspacePREvent.deleteMany({ where: { workspaceId: 'w' } });
  await db.prisma.workspacePRDelivery.deleteMany({ where: { workspaceId: 'w' } });
  await db.prisma.$transaction((tx) => workspacePrEventAccessor.restoreBackup(tx, 'w', events));
  expect(
    await db.prisma.workspacePRDelivery.findUnique({ where: { id: input.deliveryId } })
  ).toMatchObject({
    state: 'DISPATCHING',
    eventIds,
    text: input.text,
    attempts: 1,
    provider: 'CLAUDE',
    providerSessionId: 'main-provider',
    bindingRevision: 0,
  });
  expect(await workspacePrEventAccessor.claimDelivery(request, input)).toBeNull();
  expect(await workspacePrEventAccessor.recoverClaim(input.deliveryId, true)).toEqual({
    count: 2,
    status: 'recovered',
  });
  expect(await workspacePrEventAccessor.listPending('w')).toEqual([]);
});

it('rolls back a restore that collides with an existing delivery identity', async () => {
  const [id] = await mainBatchFacts();
  await workspacePrEventAccessor.claimDelivery(
    { workspaceId: 'w', prId: null, bindingRevision: 0 },
    { deliveryId: 'collision', sessionId: 'main', eventIds: [id!], text: 'original' }
  );
  const rows = await db.prisma.workspacePREvent.findMany({ where: { batchId: 'collision' } });
  const deliveries = await db.prisma.workspacePRDelivery.findMany({ where: { id: 'collision' } });
  const events = workspacePrEventAccessor
    .exportEvents(rows, deliveries)
    .map(({ batchId: _batchId, ...event }) =>
      prEventBackupSchema.parse({
        ...event,
        id: 'imported-event',
        deduplicationKey: 'imported-fact',
        createdAt: event.createdAt.toISOString(),
        claimedAt: event.claimedAt?.toISOString() ?? null,
        deliveredAt: null,
      })
    );
  await expect(
    db.prisma.$transaction((tx) => workspacePrEventAccessor.restoreBackup(tx, 'w', events))
  ).rejects.toThrow('Imported PR delivery identity already exists');
  expect(
    await db.prisma.workspacePREvent.findUnique({ where: { id: 'imported-event' } })
  ).toBeNull();
  expect(
    await db.prisma.workspacePRDelivery.findUnique({ where: { id: 'collision' } })
  ).toMatchObject({ state: 'DISPATCHING', text: 'original', attempts: 1 });
});
