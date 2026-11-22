import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import type { PrismaClient } from '@prisma-gen/client';
import { workspacePrDeliveryAccessor } from './workspace-pr-delivery.accessor';
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
async function readEvent(id: string | undefined) {
  if (!id) {
    throw new Error('Missing event ID');
  }
  const row = await db.prisma.workspacePREvent.findUnique({ where: { id } });
  if (!row) {
    return null;
  }
  return workspacePrEventAccessor.projectEvents(
    [row],
    await db.prisma.workspacePRDelivery.findMany()
  )[0];
}
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
      await workspacePrDeliveryAccessor.claimDelivery(request, { ...input, sessionId })
    ).toBeNull();
  }
  expect(
    await workspacePrDeliveryAccessor.claimDelivery({ ...request, deliveryMode: 'MAIN' }, input)
  ).toBeNull();
  expect(await workspacePrDeliveryAccessor.claimDelivery(request, input)).toMatchObject({
    sessionId: 'dedicated',
    deliveryProviderSessionId: 'dedicated-provider',
  });
  await workspacePrMonitoringAccessor.setBinding({
    workspaceId: 'w',
    enabled: true,
    deliveryMode: 'MAIN',
    expectedBindingRevision: 1,
  });
  expect(await readEvent(id)).toMatchObject({
    state: 'DISPATCHING',
    deliveryId: 'frozen',
    deliverySessionId: 'dedicated',
    deliveryText: 'original text',
  });
  await workspacePrDeliveryAccessor.settleDelivery({
    deliveryId: 'frozen',
    sessionId: 'dedicated',
    bindingRevision: 1,
    result: 'retry',
  });
  expect(
    await workspacePrDeliveryAccessor.claimDelivery(
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
      deliveryProvider: 'CODEX',
      deliveryProviderSessionId: 'dedicated-provider',
      deliveryBindingRevision: 1,
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
  expect(await readEvent(id)).toMatchObject({
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
    await workspacePrDeliveryAccessor.claimDelivery({ ...request, workspaceId: 'other' }, input)
  ).toBeNull();
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: 'w' },
    data: { enabled: false },
  });
  expect(await workspacePrDeliveryAccessor.claimDelivery(request, input)).toBeNull();
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: 'w' },
    data: { enabled: true },
  });
  await db.prisma.workspacePR.update({ where: { id: 'p' }, data: { detachedAt: new Date() } });
  expect(await workspacePrDeliveryAccessor.claimDelivery(request, input)).toBeNull();
  expect(await readEvent(id)).toMatchObject({
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
    workspacePrDeliveryAccessor.claimDelivery(
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
  expect(await readEvent(waiting.eventId)).toMatchObject({
    state: 'PENDING',
    deliveryId: null,
    attempts: 0,
  });
  expect(
    await workspacePrDeliveryAccessor.settleDelivery({
      deliveryId: winner.deliveryId,
      sessionId: winner.sessionId,
      bindingRevision: 1,
      result: 'delivered',
    })
  ).toBe(true);
  expect(await claim(waiting)).toMatchObject({ sessionId: waiting.sessionId, attempt: 1 });
});

it('holds a main claim while a dedicated delivery from before the mode switch is in flight', async () => {
  await switchDedicated();
  const dedicatedId = await fact();
  expect(
    await workspacePrDeliveryAccessor.claimDelivery(
      { workspaceId: 'w', prId: 'p', bindingRevision: 1, deliveryMode: 'DEDICATED' },
      { deliveryId: 'dedicated-batch', sessionId: 'dedicated', eventIds: [dedicatedId], text: 'a' }
    )
  ).not.toBeNull();
  expect(
    await workspacePrMonitoringAccessor.setBinding({
      workspaceId: 'w',
      enabled: true,
      deliveryMode: 'MAIN',
      recipientSessionId: 'main',
      expectedBindingRevision: 1,
    })
  ).toEqual({ applied: true, bindingRevision: 2 });
  const [mainId] = await db.prisma.$transaction((tx) =>
    workspacePrEventAccessor.insert(tx, 'w', 'p2', [
      {
        kind: 'CI_FAILED',
        deduplicationKey: 'main-failure',
        payload: {
          kind: 'CI_FAILED',
          target: { workspaceId: 'w', prId: 'p2' },
          observation: { ...redObservation, url: 'https://github.com/org/repo/pull/2', number: 2 },
        },
      },
    ])
  );
  if (!mainId) {
    throw new Error('Missing main event');
  }
  const claimMain = () =>
    workspacePrDeliveryAccessor.claimDelivery(
      { workspaceId: 'w', prId: null, bindingRevision: 2 },
      { deliveryId: 'main-batch', sessionId: 'main', eventIds: [mainId], text: 'b' }
    );

  expect(await claimMain()).toBeNull();
  expect(await readEvent(mainId)).toMatchObject({ state: 'PENDING', deliveryId: null });
  await workspacePrDeliveryAccessor.settleDelivery({
    deliveryId: 'dedicated-batch',
    sessionId: 'dedicated',
    bindingRevision: 1,
    result: 'delivered',
  });
  expect(await claimMain()).toMatchObject({ sessionId: 'main', attempt: 1 });
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
  expect(await readEvent(frozenId)).toMatchObject({
    state: 'PENDING',
    attempts: 0,
    deliveryId: 'frozen',
    deliverySessionId: 'dedicated',
    deliveryProvider: 'CODEX',
    deliveryProviderSessionId: 'dedicated-provider',
    deliveryText: 'unchanged',
    deliveryBindingRevision: 1,
  });
  expect(await readEvent(pendingId)).toMatchObject({
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

async function recoveryAndReviewFacts(keyPrefix = '') {
  const review = {
    identity: 'comment:7',
    contentHash: 'hash',
    body: 'Please fix',
    url: 'https://github.com/org/repo/pull/1#discussion_r7',
    author: 'reviewer',
    path: null,
    line: null,
    activityAt: redObservation.observedAt,
  };
  return await db.prisma.$transaction((tx) =>
    workspacePrEventAccessor.insert(tx, 'w', 'p', [
      {
        kind: 'CI_RECOVERED',
        deduplicationKey: `${keyPrefix}recovered`,
        payload: {
          kind: 'CI_RECOVERED',
          target: { workspaceId: 'w', prId: 'p' },
          observation: { ...redObservation, ciStatus: 'SUCCESS' },
        },
      },
      {
        kind: 'REVIEW_FEEDBACK',
        deduplicationKey: `${keyPrefix}review`,
        payload: {
          kind: 'REVIEW_FEEDBACK',
          target: { workspaceId: 'w', prId: 'p' },
          observation: redObservation,
          reviews: [review],
        },
      },
    ])
  );
}
it('cancels unclaimed facts and controls on a mode-only switch and renews the epoch that restates them', async () => {
  const [controlId] = await workspacePrEventAccessor.addEnabledControl('w', 0, true);
  const eventIds = await recoveryAndReviewFacts();
  const epoch = (await workspacePrMonitoringAccessor.get('w'))?.eventEpoch ?? 0;
  await switchDedicated();
  expect(await workspacePrEventAccessor.listPending('w')).toHaveLength(0);
  for (const id of [controlId, ...eventIds]) {
    expect(await readEvent(id)).toMatchObject({ state: 'CANCELLED' });
  }
  expect(await workspacePrMonitoringAccessor.get('w')).toMatchObject({ eventEpoch: epoch + 1 });
  const dedicatedFact = await fact();
  await workspacePrMonitoringAccessor.setBinding({
    workspaceId: 'w',
    enabled: true,
    deliveryMode: 'MAIN',
    expectedBindingRevision: 1,
    replyToPrComments: false,
  });
  expect(await workspacePrEventAccessor.listPending('w')).toHaveLength(0);
  expect(await readEvent(dedicatedFact)).toMatchObject({ state: 'CANCELLED' });
  expect(await workspacePrMonitoringAccessor.get('w')).toMatchObject({ eventEpoch: epoch + 2 });
  // Facts of the new epoch are claimed by the restored main recipient.
  const restated = await recoveryAndReviewFacts('restated');
  expect(
    await workspacePrDeliveryAccessor.claimDelivery(
      { workspaceId: 'w', prId: 'p', bindingRevision: 2 },
      {
        deliveryId: 'rerouted',
        sessionId: 'main',
        eventIds: restated,
        text: 'Queued facts',
      }
    )
  ).toMatchObject({ eventIds: restated, sessionId: 'main', attempt: 1 });
});
it('rejects incomplete dispatching backup claims before persisting a workspace lock', async () => {
  const event = {
    id: 'invalid-claim',
    workspaceId: 'w',
    prId: null,
    kind: 'MONITORING_ENABLED',
    deduplicationKey: 'invalid-claim',
    payload: {
      kind: 'MONITORING_ENABLED' as const,
      workspaceId: 'w',
      bindingRevision: 0,
      replyToPrComments: true,
    },
    state: 'DISPATCHING' as const,
    attempts: 1,
    deliveryId: null,
    deliverySessionId: 'main',
    deliveryBindingRevision: 0,
    deliveryText: 'frozen',
    deliveryProvider: 'CLAUDE',
    deliveryProviderSessionId: 'main-provider',
    claimedAt: null,
    deliveredAt: null,
    createdAt: '2026-10-08T00:00:00.000Z',
  };
  await expect(
    db.prisma.$transaction((tx) => workspacePrDeliveryAccessor.restoreBackup(tx, 'w', [event]))
  ).rejects.toThrow();
  expect(await db.prisma.workspacePREvent.count()).toBe(0);
});

it('cancels unclaimed facts but keeps the frozen claim when a dedicated-to-main switch also binds a missing main preference', async () => {
  await switchDedicated();
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: 'w' },
    data: { recipientSessionId: null },
  });
  const frozenId = await fact();
  expect(
    await workspacePrDeliveryAccessor.claimDelivery(
      {
        workspaceId: 'w',
        prId: 'p',
        bindingRevision: 1,
        deliveryMode: 'DEDICATED',
      },
      {
        deliveryId: 'old-dedicated',
        sessionId: 'dedicated',
        eventIds: [frozenId],
        text: 'frozen text',
      }
    )
  ).not.toBeNull();
  const eventIds = await recoveryAndReviewFacts();
  const [oldControl] = await db.prisma.$transaction((tx) =>
    workspacePrEventAccessor.insert(tx, 'w', null, [
      {
        kind: 'MONITORING_ENABLED',
        deduplicationKey: 'old-control',
        payload: {
          kind: 'MONITORING_ENABLED',
          workspaceId: 'w',
          bindingRevision: 1,
          replyToPrComments: true,
        },
      },
    ])
  );
  expect(
    await workspacePrMonitoringAccessor.setBinding({
      workspaceId: 'w',
      enabled: true,
      deliveryMode: 'MAIN',
      recipientSessionId: 'main',
      expectedBindingRevision: 1,
      replyToPrComments: false,
    })
  ).toEqual({ applied: true, bindingRevision: 2 });
  for (const id of [...eventIds, oldControl]) {
    expect(await readEvent(id)).toMatchObject({
      state: 'CANCELLED',
      deliveryId: null,
    });
  }
  expect(await workspacePrEventAccessor.listPending('w', null)).toHaveLength(0);
  expect(await readEvent(frozenId)).toMatchObject({
    state: 'DISPATCHING',
    deliveryId: 'old-dedicated',
    deliverySessionId: 'dedicated',
    deliveryProvider: 'CODEX',
    deliveryProviderSessionId: 'dedicated-provider',
    deliveryText: 'frozen text',
    deliveryBindingRevision: 1,
  });
  await workspacePrDeliveryAccessor.settleDelivery({
    deliveryId: 'old-dedicated',
    sessionId: 'dedicated',
    bindingRevision: 1,
    result: 'delivered',
  });
  const restated = await recoveryAndReviewFacts('restated');
  expect(
    await workspacePrDeliveryAccessor.claimDelivery(
      { workspaceId: 'w', prId: 'p', bindingRevision: 2 },
      {
        deliveryId: 'new-main',
        sessionId: 'main',
        eventIds: restated,
        text: 'Queued facts',
      }
    )
  ).toMatchObject({ eventIds: restated, sessionId: 'main', attempt: 1 });
});

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
it('atomically claims all main PR targets and preserves the whole frozen retry set', async () => {
  const eventIds = await mainBatchFacts();
  const request = { workspaceId: 'w', prId: null, bindingRevision: 0 };
  const input = { deliveryId: 'batch', sessionId: 'main', eventIds, text: 'all facts' };
  expect(await workspacePrDeliveryAccessor.claimDelivery(request, input)).toMatchObject({
    eventIds,
    attempt: 1,
    deliveryProviderSessionId: 'main-provider',
  });
  expect(
    (await workspacePrEventAccessor.listPending('w')).filter(
      (event) => event.deliveryId === 'batch' && event.state === 'DISPATCHING'
    ).length
  ).toBe(2);
  await workspacePrDeliveryAccessor.settleDelivery({
    deliveryId: 'batch',
    sessionId: 'main',
    bindingRevision: 0,
    result: 'retry',
  });
  expect(
    await workspacePrDeliveryAccessor.claimDelivery(request, { ...input, eventIds: [eventIds[0]!] })
  ).toBeNull();
  expect(await workspacePrDeliveryAccessor.claimDelivery(request, input)).toMatchObject({
    eventIds,
    text: 'all facts',
    attempt: 2,
  });
});
it('rejects an all-PR claim atomically when any target has detached', async () => {
  const eventIds = await mainBatchFacts();
  await db.prisma.workspacePR.update({ where: { id: 'p2' }, data: { detachedAt: new Date() } });
  expect(
    await workspacePrDeliveryAccessor.claimDelivery(
      { workspaceId: 'w', prId: null, bindingRevision: 0 },
      { deliveryId: 'batch', sessionId: 'main', eventIds, text: 'all' }
    )
  ).toBeNull();
  expect(await db.prisma.workspacePREvent.count({ where: { state: 'DISPATCHING' } })).toBe(0);
});
it('cannot mix fresh events into a frozen main batch', async () => {
  const eventIds = await mainBatchFacts();
  const request = { workspaceId: 'w', prId: null, bindingRevision: 0 };
  const input = {
    deliveryId: 'batch',
    sessionId: 'main',
    eventIds: [eventIds[0]!],
    text: 'frozen',
  };
  expect(await workspacePrDeliveryAccessor.claimDelivery(request, input)).not.toBeNull();
  await workspacePrDeliveryAccessor.settleDelivery({
    deliveryId: 'batch',
    sessionId: 'main',
    bindingRevision: 0,
    result: 'retry',
  });
  expect(
    await workspacePrDeliveryAccessor.claimDelivery(request, { ...input, eventIds })
  ).toBeNull();
});
