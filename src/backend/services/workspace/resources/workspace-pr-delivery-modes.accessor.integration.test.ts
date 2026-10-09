import type { PrismaClient } from '@prisma-gen/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { workspacePrEventAccessor } from './workspace-pr-event.accessor';
import { workspacePrMonitoringAccessor } from './workspace-pr-monitoring.accessor';
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
async function switchDedicated() {
  return await workspacePrMonitoringAccessor.setBinding({
    workspaceId: 'w',
    enabled: true,
    recipientSessionId: null,
    deliveryMode: 'DEDICATED',
    expectedBindingRevision: 0,
    replyToPrComments: true,
  });
}
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
it('defaults monitoring projections to main delivery', async () => {
  expect(await workspaceRatchetAccessor.findSnapshotProjection('w')).toMatchObject({
    prMonitoring: { deliveryMode: 'MAIN' },
  });
});
it('changes mode atomically while retaining the main preference and never queuing dedicated controls', async () => {
  expect(await switchDedicated()).toEqual({ applied: true, bindingRevision: 1 });
  expect(await workspacePrMonitoringAccessor.get('w')).toMatchObject({
    deliveryMode: 'DEDICATED',
    recipientSessionId: 'main',
    eventEpoch: 1,
  });
  expect(await workspacePrEventAccessor.addEnabledControl('w', 1, true)).toEqual([]);
  expect(await workspacePrEventAccessor.listPending('w')).toEqual([]);
  expect(
    await workspacePrMonitoringAccessor.setBinding({
      workspaceId: 'w',
      enabled: true,
      deliveryMode: 'MAIN',
      expectedBindingRevision: 0,
    })
  ).toEqual({ applied: false, bindingRevision: 1 });
  expect(
    await workspacePrMonitoringAccessor.setBinding({
      workspaceId: 'w',
      enabled: true,
      deliveryMode: 'MAIN',
      expectedBindingRevision: 1,
    })
  ).toEqual({ applied: true, bindingRevision: 2 });
  expect(await workspacePrMonitoringAccessor.get('w')).toMatchObject({
    deliveryMode: 'MAIN',
    recipientSessionId: 'main',
    eventEpoch: 2,
  });
});
it('authorizes dedicated claims only for their bound PR and keeps frozen identity across mode changes', async () => {
  await switchDedicated();
  const id = await fact();
  const request = {
    workspaceId: 'w',
    prId: 'p',
    bindingRevision: 1,
    deliveryMode: 'DEDICATED' as const,
  };
  const input = {
    deliveryId: 'frozen',
    sessionId: 'dedicated',
    eventIds: [id],
    text: 'original text',
  };
  for (const sessionId of ['main', 'sibling', 'foreign']) {
    expect(
      await workspacePrEventAccessor.claimDelivery(request, { ...input, sessionId })
    ).toBeNull();
  }
  expect(
    await workspacePrEventAccessor.claimDelivery({ ...request, deliveryMode: 'MAIN' }, input)
  ).toBeNull();
  expect(await workspacePrEventAccessor.claimDelivery(request, input)).toMatchObject({
    sessionId: 'dedicated',
    deliveryProviderSessionId: 'dedicated-provider',
  });
  await workspacePrMonitoringAccessor.setBinding({
    workspaceId: 'w',
    enabled: true,
    deliveryMode: 'MAIN',
    expectedBindingRevision: 1,
  });
  expect(await db.prisma.workspacePREvent.findUnique({ where: { id } })).toMatchObject({
    state: 'DISPATCHING',
    deliveryId: 'frozen',
    deliverySessionId: 'dedicated',
    deliveryText: 'original text',
  });
  await workspacePrEventAccessor.settleDelivery({
    deliveryId: 'frozen',
    sessionId: 'dedicated',
    bindingRevision: 1,
    result: 'retry',
  });
  expect(
    await workspacePrEventAccessor.claimDelivery(
      { ...request, bindingRevision: 2, deliveryMode: 'MAIN' },
      { ...input, sessionId: 'main' }
    )
  ).toBeNull();
});
it('pauses and resumes the workspace through its bound dedicated conversation', async () => {
  await switchDedicated();
  const id = await fact();
  await db.prisma.workspacePREvent.update({
    where: { id },
    data: {
      attempts: 3,
      deliveryId: 'frozen',
      deliverySessionId: 'dedicated',
      deliveryText: 'original',
    },
  });
  expect(await workspacePrMonitoringAccessor.pause('dedicated', 'USER_STOPPED')).toEqual({
    count: 1,
  });
  expect(await workspacePrMonitoringAccessor.get('w')).toMatchObject({
    deliveryPauseReason: 'USER_STOPPED',
    bindingRevision: 2,
  });
  await workspacePrMonitoringAccessor.resume('dedicated', () => false);
  expect(await workspacePrMonitoringAccessor.get('w')).toMatchObject({
    deliveryPauseReason: 'USER_STOPPED',
  });
  await workspacePrMonitoringAccessor.resume('dedicated');
  expect(await workspacePrMonitoringAccessor.get('w')).toMatchObject({
    deliveryPauseReason: null,
    bindingRevision: 3,
  });
  expect(await db.prisma.workspacePREvent.findUnique({ where: { id } })).toMatchObject({
    attempts: 0,
    deliverySessionId: 'dedicated',
    deliveryId: 'frozen',
  });
});
it('rejects dedicated sessions as ordinary main recipients', async () => {
  await expect(
    workspacePrMonitoringAccessor.setBinding({
      workspaceId: 'w',
      enabled: true,
      recipientSessionId: 'dedicated',
      expectedBindingRevision: 0,
    })
  ).rejects.toThrow('ordinary');
});
it('fences the previous main recipient and detached dedicated conversations from pausing the selected mode', async () => {
  await switchDedicated();
  expect(await workspacePrMonitoringAccessor.pause('main', 'USER_STOPPED')).toEqual({ count: 0 });
  await db.prisma.workspacePR.update({ where: { id: 'p' }, data: { detachedAt: new Date() } });
  expect(await workspacePrMonitoringAccessor.pause('dedicated', 'USER_STOPPED')).toEqual({
    count: 0,
  });
  expect(await workspacePrMonitoringAccessor.get('w')).toMatchObject({
    bindingRevision: 1,
    deliveryPauseReason: null,
  });
});
it('rejects dedicated claims for detached targets, disabled monitoring and foreign workspaces', async () => {
  await switchDedicated();
  const id = await fact();
  const request = {
    workspaceId: 'w',
    prId: 'p',
    bindingRevision: 1,
    deliveryMode: 'DEDICATED' as const,
  };
  const input = { deliveryId: 'frozen', sessionId: 'dedicated', eventIds: [id], text: 'frozen' };
  expect(
    await workspacePrEventAccessor.claimDelivery({ ...request, workspaceId: 'other' }, input)
  ).toBeNull();
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: 'w' },
    data: { enabled: false },
  });
  expect(await workspacePrEventAccessor.claimDelivery(request, input)).toBeNull();
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: 'w' },
    data: { enabled: true },
  });
  await db.prisma.workspacePR.update({ where: { id: 'p' }, data: { detachedAt: new Date() } });
  expect(await workspacePrEventAccessor.claimDelivery(request, input)).toBeNull();
  expect(await db.prisma.workspacePREvent.findUnique({ where: { id } })).toMatchObject({
    state: 'PENDING',
    deliveryId: null,
    attempts: 0,
  });
});
it('preserves a dedicated user stop if its resume callback becomes stale immediately before the transaction update', async () => {
  await switchDedicated();
  await workspacePrMonitoringAccessor.pause('dedicated', 'USER_STOPPED');
  let checks = 2;
  await workspacePrMonitoringAccessor.resume('dedicated', () => checks-- > 0);
  expect(await workspacePrMonitoringAccessor.get('w')).toMatchObject({
    deliveryPauseReason: 'USER_STOPPED',
    bindingRevision: 2,
  });
});
it('serializes dedicated PR claims across the workspace and releases the next batch after settlement', async () => {
  await switchDedicated();
  const firstId = await fact();
  const [secondId] = await db.prisma.$transaction((tx) =>
    workspacePrEventAccessor.insert(tx, 'w', 'p2', [
      {
        kind: 'CI_FAILED',
        deduplicationKey: 'sibling-failure',
        payload: {
          kind: 'CI_FAILED',
          target: { workspaceId: 'w', prId: 'p2' },
          observation: { ...redObservation, url: 'https://github.com/org/repo/pull/2', number: 2 },
        },
      },
    ])
  );
  if (!secondId) {
    throw new Error('Missing sibling event');
  }
  const batches = [
    { prId: 'p', sessionId: 'dedicated', eventId: firstId, deliveryId: 'first' },
    { prId: 'p2', sessionId: 'sibling', eventId: secondId, deliveryId: 'second' },
  ];
  const claim = (batch: (typeof batches)[number]) =>
    workspacePrEventAccessor.claimDelivery(
      { workspaceId: 'w', prId: batch.prId, bindingRevision: 1, deliveryMode: 'DEDICATED' },
      {
        sessionId: batch.sessionId,
        deliveryId: batch.deliveryId,
        eventIds: [batch.eventId],
        text: batch.deliveryId,
      }
    );
  const claims = await Promise.all(batches.map(claim));
  expect(claims.filter(Boolean)).toHaveLength(1);
  const winnerIndex = claims.findIndex(Boolean);
  const winner = batches[winnerIndex]!;
  const waiting = batches[1 - winnerIndex]!;
  expect(await claim(waiting)).toBeNull();
  expect(
    await db.prisma.workspacePREvent.findUnique({ where: { id: waiting.eventId } })
  ).toMatchObject({ state: 'PENDING', deliveryId: null, attempts: 0 });
  expect(
    await workspacePrEventAccessor.settleDelivery({
      deliveryId: winner.deliveryId,
      sessionId: winner.sessionId,
      bindingRevision: 1,
      result: 'delivered',
    })
  ).toBe(true);
  expect(await claim(waiting)).toMatchObject({ sessionId: waiting.sessionId, attempt: 1 });
});

it('explicitly resumes a paused main destination after switching to dedicated without a binding', async () => {
  await workspacePrMonitoringAccessor.pause('main', 'USER_STOPPED');
  await db.prisma.workspacePRDedicatedSession.deleteMany();
  expect(
    await workspacePrMonitoringAccessor.setBinding({
      workspaceId: 'w',
      enabled: true,
      deliveryMode: 'DEDICATED',
      expectedBindingRevision: 1,
    })
  ).toEqual({ applied: true, bindingRevision: 2 });
  expect(await workspacePrMonitoringAccessor.get('w')).toMatchObject({
    deliveryPauseReason: 'USER_STOPPED',
  });
  expect(
    await workspacePrMonitoringAccessor.setBinding({
      workspaceId: 'w',
      enabled: true,
      resume: true,
      expectedBindingRevision: 2,
    })
  ).toEqual({ applied: true, bindingRevision: 3 });
  expect(await workspacePrMonitoringAccessor.get('w')).toMatchObject({
    deliveryMode: 'DEDICATED',
    deliveryPauseReason: null,
    eventEpoch: 1,
  });
});
it('explicit resume survives a deleted dedicated conversation and renews frozen retries without cancelling pending facts', async () => {
  await switchDedicated();
  const frozenId = await fact();
  await db.prisma.workspacePREvent.update({
    where: { id: frozenId },
    data: {
      attempts: 3,
      deliveryId: 'frozen',
      deliverySessionId: 'dedicated',
      deliveryProvider: 'CODEX',
      deliveryProviderSessionId: 'dedicated-provider',
      deliveryText: 'unchanged',
      deliveryBindingRevision: 1,
    },
  });
  const [pendingId] = await db.prisma.$transaction((tx) =>
    workspacePrEventAccessor.insert(tx, 'w', 'p', [
      {
        kind: 'CI_FAILED',
        deduplicationKey: 'later-failure',
        payload: {
          kind: 'CI_FAILED',
          target: { workspaceId: 'w', prId: 'p' },
          observation: redObservation,
        },
      },
    ])
  );
  await workspacePrMonitoringAccessor.pause('dedicated', 'SESSION_FAILED');
  await db.prisma.agentSession.delete({ where: { id: 'dedicated' } });
  expect(
    await workspacePrMonitoringAccessor.setBinding({
      workspaceId: 'w',
      enabled: true,
      resume: true,
      expectedBindingRevision: 2,
    })
  ).toEqual({ applied: true, bindingRevision: 3 });
  expect(await workspacePrMonitoringAccessor.get('w')).toMatchObject({
    deliveryPauseReason: null,
    eventEpoch: 1,
  });
  expect(await db.prisma.workspacePREvent.findUnique({ where: { id: frozenId } })).toMatchObject({
    state: 'PENDING',
    attempts: 0,
    deliveryId: 'frozen',
    deliverySessionId: 'dedicated',
    deliveryProvider: 'CODEX',
    deliveryProviderSessionId: 'dedicated-provider',
    deliveryText: 'unchanged',
    deliveryBindingRevision: 1,
  });
  expect(await db.prisma.workspacePREvent.findUnique({ where: { id: pendingId } })).toMatchObject({
    state: 'PENDING',
  });
});
it('rejects stale explicit resume and preserves nonrecoverable pauses through disabling', async () => {
  await workspacePrMonitoringAccessor.pause('main', 'USER_STOPPED');
  expect(
    await workspacePrMonitoringAccessor.setBinding({
      workspaceId: 'w',
      enabled: true,
      resume: true,
      expectedBindingRevision: 0,
    })
  ).toEqual({ applied: false, bindingRevision: 1 });
  expect(await workspacePrMonitoringAccessor.get('w')).toMatchObject({
    deliveryPauseReason: 'USER_STOPPED',
  });
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: 'w' },
    data: { deliveryPauseReason: 'LEGACY_FIXER_USER_STOPPED' },
  });
  expect(
    await workspacePrMonitoringAccessor.setBinding({
      workspaceId: 'w',
      enabled: false,
      resume: true,
      expectedBindingRevision: 1,
    })
  ).toEqual({ applied: true, bindingRevision: 2 });
  expect(await workspacePrMonitoringAccessor.get('w')).toMatchObject({
    enabled: false,
    deliveryPauseReason: 'LEGACY_FIXER_USER_STOPPED',
  });
});
