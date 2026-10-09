import type { PrismaClient } from '@prisma-gen/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { workspacePrDiscoveryAccessor } from './workspace-pr-discovery.accessor';
import { workspacePrEventAccessor } from './workspace-pr-event.accessor';
import { workspacePrMonitoringAccessor } from './workspace-pr-monitoring.accessor';
import { workspacePrAccessor } from './workspace-pr.accessor';
import { workspaceRatchetAccessor } from './workspace-ratchet.accessor';
import { workspaceAccessor } from './workspace.accessor';

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
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});
beforeEach(async () => {
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: '/tmp/repo',
      worktreeBasePath: '/tmp/worktrees',
      githubOwner: 'org',
      githubRepo: 'repo',
    },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'w',
      projectId: 'project',
      name: 'Workspace',
      status: 'READY',
      branchName: 'feature',
      prMonitoring: { create: { enabled: true } },
      prDiscovery: { create: {} },
    },
  });
});
function createPR(id = 'p', extra = {}) {
  return db.prisma.workspacePR.create({
    data: {
      id,
      workspaceId: 'w',
      url: `https://github.com/org/repo/pull/${id === 'p' ? 1 : 2}`,
      ...extra,
    },
  });
}
it('neutralizes a detached cached PR before reattaching it', async () => {
  const pr = await createPR('p', {
    detachedAt: new Date(),
    state: 'MERGED',
    hasMergeConflict: true,
    ciStatus: 'FAILURE',
    observation: redObservation,
    syncedAt: new Date(),
  });
  await workspacePrAccessor.attach('w', pr.url);
  expect(await workspacePrAccessor.findByIdentity({ workspaceId: 'w', prId: pr.id })).toMatchObject(
    {
      detachedAt: null,
      state: 'NONE',
      hasMergeConflict: false,
      ciStatus: 'UNKNOWN',
      observation: null,
      syncedAt: null,
    }
  );
});
it('selects the open sibling for workspace-scoped review, status and PR context', async () => {
  await createPR('p', { state: 'MERGED', number: 1 });
  const open = await createPR('p2', { state: 'OPEN', number: 2 });
  expect(await workspacePrAccessor.findPRState('w')).toMatchObject({
    prId: open.id,
    prState: 'OPEN',
  });
  expect(await workspaceAccessor.findStatusSnapshot('w')).toMatchObject({
    prUrl: open.url,
    prNumber: 2,
  });
  expect(await workspaceAccessor.findPRContext('w')).toMatchObject({ prUrl: open.url });
});
it('reattaches a detached URL from a valid discovery claim', async () => {
  const pr = await createPR('p', { detachedAt: new Date(), state: 'MERGED' });
  const claim = {
    branchName: 'feature',
    githubOwner: 'org',
    githubRepo: 'repo',
    checkedAt: new Date(),
    retryCount: 1,
    nextCheckAt: new Date(Date.now() + 1000),
  };
  await db.prisma.workspacePRDiscovery.update({
    where: { workspaceId: 'w' },
    data: { lastCheckedAt: claim.checkedAt, retryCount: 1, nextCheckAt: claim.nextCheckAt },
  });
  expect(await workspacePrAccessor.attachDiscoveredPRsIfClaimMatches('w', claim, [pr.url])).toEqual(
    ['p']
  );
  expect(await workspacePrAccessor.findByIdentity({ workspaceId: 'w', prId: 'p' })).toMatchObject({
    state: 'NONE',
    detachedAt: null,
  });
});
it('rejects a discovery claim after the project repository changes', async () => {
  const claim = {
    branchName: 'feature',
    githubOwner: 'org',
    githubRepo: 'repo',
    checkedAt: new Date(),
    retryCount: 1,
    nextCheckAt: new Date(Date.now() + 1000),
  };
  await db.prisma.workspacePRDiscovery.update({
    where: { workspaceId: 'w' },
    data: { lastCheckedAt: claim.checkedAt, retryCount: 1, nextCheckAt: claim.nextCheckAt },
  });
  await db.prisma.project.update({ where: { id: 'project' }, data: { githubRepo: 'other' } });
  expect(
    await db.prisma.$transaction((tx) => workspacePrDiscoveryAccessor.claimMatches(tx, 'w', claim))
  ).toBe(false);
});
it('detach cancels unclaimed pending events and removes them from every pending count', async () => {
  await createPR();
  await db.prisma.workspacePREvent.create({
    data: {
      id: 'event',
      workspaceId: 'w',
      prId: 'p',
      kind: 'CI_FAILED',
      deduplicationKey: 'event',
      payload: {
        kind: 'CI_FAILED',
        target: { workspaceId: 'w', prId: 'p' },
        observation: redObservation,
      },
    },
  });
  await workspacePrAccessor.detach({ workspaceId: 'w', prId: 'p' });
  expect(await db.prisma.workspacePREvent.findUnique({ where: { id: 'event' } })).toMatchObject({
    state: 'CANCELLED',
  });
  expect(await workspaceRatchetAccessor.findSnapshotProjection('w')).toMatchObject({
    prMonitoring: { pendingEventCount: 0 },
  });
});
it('pending counts include attached PR events and workspace controls, excluding detached history', async () => {
  await createPR('p');
  await createPR('p2', { detachedAt: new Date() });
  for (const [id, prId] of [
    ['active', 'p'],
    ['detached', 'p2'],
    ['control', null],
  ] as const) {
    await db.prisma.workspacePREvent.create({
      data: {
        id,
        prId,
        workspaceId: 'w',
        kind: 'MONITORING_ENABLED',
        deduplicationKey: id,
        payload: {
          kind: 'MONITORING_ENABLED',
          workspaceId: 'w',
          bindingRevision: 0,
          replyToPrComments: true,
        },
      },
    });
  }
  expect(await workspaceRatchetAccessor.findSnapshotProjection('w')).toMatchObject({
    prMonitoring: { pendingEventCount: 2 },
  });
  expect(await workspaceAccessor.findById('w')).toMatchObject({
    prMonitoring: { pendingEventCount: 2 },
  });
});
it('maintenance workspace reads preserve pending controls and attached PR counts', async () => {
  await createPR('p');
  await createPR('p2', { detachedAt: new Date() });
  for (const [id, prId] of [
    ['active-maintenance', 'p'],
    ['detached-maintenance', 'p2'],
    ['control-maintenance', null],
  ] as const) {
    await db.prisma.workspacePREvent.create({
      data: {
        id,
        prId,
        workspaceId: 'w',
        kind: 'MONITORING_ENABLED',
        deduplicationKey: id,
        payload: {
          kind: 'MONITORING_ENABLED',
          workspaceId: 'w',
          bindingRevision: 0,
          replyToPrComments: true,
        },
      },
    });
  }
  const rows = await workspaceAccessor.findAllNonArchivedWithSessionsAndProject();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: 'w', prMonitoring: { enabled: true, pendingEventCount: 2 } });
});
it('does not preserve explicitly resolved reviews when merging incomplete observations', async () => {
  const review = {
    identity: 'comment:9',
    contentHash: 'hash',
    author: 'reviewer',
    body: 'fix',
    path: 'a.ts',
    line: 1,
    url: redObservation.url,
    activityAt: redObservation.observedAt,
  };
  await createPR('p', {
    revision: 0,
    observation: { ...redObservation, actionableReviews: [review] },
    observationEpoch: 0,
  });
  await db.prisma.workspacePREvent.create({
    data: {
      id: 'pending-review',
      workspaceId: 'w',
      prId: 'p',
      kind: 'REVIEW_FEEDBACK',
      deduplicationKey: 'p:epoch:0:review',
      payload: {
        kind: 'REVIEW_FEEDBACK',
        target: { workspaceId: 'w', prId: 'p' },
        observation: { ...redObservation, actionableReviews: [review] },
        reviews: [review],
      },
    },
  });
  const observation = {
    ...redObservation,
    reviewsComplete: false,
    resolvedReviewIds: ['comment:9'],
  };
  await workspacePrAccessor.acceptMonitoredObservation({
    target: { workspaceId: 'w', prId: 'p' },
    expectedPrRevision: 0,
    expectedEventEpoch: 0,
    observation,
  });
  const row = await workspacePrAccessor.findByIdentity({ workspaceId: 'w', prId: 'p' });
  expect(row?.observation).toMatchObject({ actionableReviews: [] });
  expect(
    await db.prisma.workspacePREvent.findUnique({ where: { id: 'pending-review' } })
  ).toMatchObject({ state: 'SUPERSEDED' });
});

it('records conflict clearance while its detection delivery is frozen in flight', async () => {
  const detected = { ...redObservation, hasMergeConflict: true };
  await createPR('p', { observation: detected, observationEpoch: 0 });
  await db.prisma.workspacePREvent.create({
    data: {
      workspaceId: 'w',
      prId: 'p',
      kind: 'CONFLICT_DETECTED',
      state: 'DISPATCHING',
      deliveryId: 'frozen',
      deduplicationKey: 'p:epoch:0:detection',
      payload: {
        kind: 'CONFLICT_DETECTED',
        target: { workspaceId: 'w', prId: 'p' },
        observation: detected,
      },
    },
  });
  await workspacePrAccessor.acceptMonitoredObservation({
    target: { workspaceId: 'w', prId: 'p' },
    expectedPrRevision: 0,
    expectedEventEpoch: 0,
    observation: redObservation,
  });
  expect(
    await db.prisma.workspacePREvent.findMany({ where: { prId: 'p', kind: 'CONFLICT_CLEARED' } })
  ).toHaveLength(1);
});

it('keeps events unclaimed until the recipient has a provider conversation identity', async () => {
  await db.prisma.agentSession.create({
    data: {
      id: 'main',
      workspaceId: 'w',
      workflow: 'implement',
      provider: 'CLAUDE',
      model: 'sonnet',
    },
  });
  const binding = await workspacePrMonitoringAccessor.setBinding({
    workspaceId: 'w',
    enabled: true,
    recipientSessionId: 'main',
    expectedBindingRevision: 0,
    replyToPrComments: true,
  });
  const event = (await workspacePrEventAccessor.listPending('w', null))[0];
  if (!event) {
    throw new Error('Missing control event');
  }
  const request = { workspaceId: 'w', prId: null, bindingRevision: binding.bindingRevision };
  const delivery = {
    deliveryId: 'delivery',
    sessionId: 'main',
    eventIds: [event.id],
    text: 'frozen',
  };
  expect(await workspacePrEventAccessor.claimDelivery(request, delivery)).toBeNull();
  expect(await db.prisma.workspacePREvent.findUnique({ where: { id: event.id } })).toMatchObject({
    state: 'PENDING',
    attempts: 0,
    deliveryId: null,
    deliveryText: null,
    deliveryProviderSessionId: null,
  });
  await db.prisma.agentSession.update({
    where: { id: 'main' },
    data: { providerSessionId: 'conversation' },
  });
  expect(await workspacePrEventAccessor.claimDelivery(request, delivery)).toMatchObject({
    attempt: 1,
  });
  expect(await db.prisma.workspacePREvent.findUnique({ where: { id: event.id } })).toMatchObject({
    state: 'DISPATCHING',
    attempts: 1,
    deliveryProviderSessionId: 'conversation',
  });
});
it('preserves a newer user stop when the resume guard expires before its transaction update', async () => {
  await db.prisma.agentSession.create({
    data: {
      id: 'main',
      workspaceId: 'w',
      workflow: 'implement',
      provider: 'CLAUDE',
      model: 'sonnet',
      providerSessionId: 'conversation',
    },
  });
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: 'w' },
    data: { recipientSessionId: 'main', bindingRevision: 4, deliveryPauseReason: 'USER_STOPPED' },
  });
  await db.prisma.workspacePREvent.create({
    data: {
      id: 'retry',
      workspaceId: 'w',
      kind: 'MONITORING_ENABLED',
      deduplicationKey: 'retry',
      attempts: 3,
      payload: {
        kind: 'MONITORING_ENABLED',
        workspaceId: 'w',
        bindingRevision: 4,
        replyToPrComments: true,
      },
    },
  });
  let remainingCurrentChecks = 2;
  const isCurrent = () => remainingCurrentChecks-- > 0;
  await workspacePrMonitoringAccessor.resume('main', isCurrent);
  expect(await workspacePrMonitoringAccessor.get('w')).toMatchObject({
    deliveryPauseReason: 'USER_STOPPED',
    bindingRevision: 4,
  });
  expect(await db.prisma.workspacePREvent.findUnique({ where: { id: 'retry' } })).toMatchObject({
    attempts: 3,
  });
});

it('persists monitored titles in the PR collection while keeping legacy observations compatible', async () => {
  await createPR('p', { title: 'Old cached title' });
  const observation = { ...redObservation, title: 'Updated title' };
  expect(
    await workspacePrAccessor.acceptMonitoredObservation({
      target: { workspaceId: 'w', prId: 'p' },
      expectedPrRevision: 0,
      expectedEventEpoch: 0,
      observation,
    })
  ).toMatchObject({ applied: true });
  expect(await workspaceAccessor.findById('w')).toMatchObject({
    prs: [expect.objectContaining({ id: 'p', title: 'Updated title' })],
  });
  expect(await workspacePrAccessor.findByIdentity({ workspaceId: 'w', prId: 'p' })).toMatchObject({
    observation: { title: 'Updated title' },
  });
  expect(
    await workspacePrAccessor.acceptMonitoredObservation({
      target: { workspaceId: 'w', prId: 'p' },
      expectedPrRevision: 1,
      expectedEventEpoch: 0,
      observation: redObservation,
    })
  ).toMatchObject({ applied: true });
  expect(await workspacePrAccessor.findByIdentity({ workspaceId: 'w', prId: 'p' })).toMatchObject({
    title: 'Updated title',
  });
  const cleared = { ...redObservation, title: null };
  expect(
    await workspacePrAccessor.acceptMonitoredObservation({
      target: { workspaceId: 'w', prId: 'p' },
      expectedPrRevision: 2,
      expectedEventEpoch: 0,
      observation: cleared,
    })
  ).toMatchObject({ applied: true });
  expect(await workspacePrAccessor.findByIdentity({ workspaceId: 'w', prId: 'p' })).toMatchObject({
    title: null,
  });
});
