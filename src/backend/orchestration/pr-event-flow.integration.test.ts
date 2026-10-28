import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  PR_SNAPSHOT_UPDATED,
  prObservationService,
  prSnapshotService,
} from '@/backend/services/github';
import { sessionBackgroundDeliveryService } from '@/backend/services/session';
import {
  workspacePRMonitoringService,
  workspacePrSnapshotService,
} from '@/backend/services/workspace';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import type { PrismaClient } from '@prisma-gen/client';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined, busy: false }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!state.prisma) {
      throw new Error('Missing test database');
    }
    return state.prisma;
  },
}));
vi.mock('@/backend/services/session', () => ({
  acpRuntimeManager: { isSessionPromptInFlight: () => state.busy },
  sessionDomainService: { getPendingInteractiveRequest: () => null },
  sessionLifecycleService: {},
  sessionDataService: {
    findPRDedicatedSession: async ({
      workspaceId,
      prId,
    }: {
      workspaceId: string;
      prId: string;
    }) => {
      const bound = await state.prisma?.workspacePRDedicatedSession.findUnique({
        where: { prId },
        include: { session: { include: { workspace: true } } },
      });
      return bound?.session?.workspaceId === workspaceId ? bound.session : null;
    },
    findAgentSessionById: (id: string) =>
      state.prisma?.agentSession.findUnique({ where: { id }, include: { workspace: true } }),
  },
  sessionBackgroundDeliveryService: { enqueue: vi.fn() },
  sessionDispatchService: { tryDispatchNextMessage: vi.fn(async () => undefined) },
  findPRDeliveryReceipt: vi.fn(),
}));

vi.mock('./pr-delivery-readiness', () => ({ recipientCanDispatch: vi.fn(async () => true) }));
vi.mock('@/backend/services/settings', () => ({
  userSettingsService: { get: vi.fn(async () => ({ ratchetReplyToPrComments: true })) },
}));

import { createPRDeliveryPorts, defaultPRDeliveryPorts } from './pr-delivery-dependencies';
import { prBackgroundDeliveryPort } from './pr-event-delivery-port';
import { preparePRDelivery } from './pr-event-delivery.orchestrator';
import {
  createPRObservationPorts,
  defaultPRMonitoringServices,
} from './pr-monitoring-dependencies';
import { observeMonitoredPR } from './pr-observation.orchestrator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let db: IntegrationDatabase;
beforeEach(() => {
  // Delivery integration controls its freshness prerequisite at the delivery port.
  vi.spyOn(defaultPRDeliveryPorts, 'refreshObservation').mockResolvedValue(true);
});
beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
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
      worktreePath: db.tempDir,
      prMonitoring: { create: { enabled: true, bindingRevision: 1, eventEpoch: 1 } },
      prs: {
        create: [
          { id: 'p', url: redObservation.url },
          { id: 'sibling', url: 'https://github.com/org/repo/pull/2' },
        ],
      },
    },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 'main',
      workspaceId: 'w',
      workflow: 'implement',
      model: 'custom-model',
      provider: 'CODEX',
      providerSessionId: 'existing-main',
    },
  });
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: 'w' },
    data: { recipientSessionId: 'main' },
  });
}, 30_000);
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});
it('commits facts and events together, rejects stale writes, and preserves a sibling update', async () => {
  const target = { workspaceId: 'w', prId: 'p' };
  const input = {
    target,
    expectedPrRevision: 0,
    expectedEventEpoch: 1,
    observation: redObservation,
  };
  expect(
    await workspacePrSnapshotService.acceptMonitoredObservation({
      ...input,
      expectedEventEpoch: 2,
    })
  ).toEqual({ applied: false, eventIds: [] });
  expect(await db.prisma.workspacePREvent.count({ where: { prId: 'p' } })).toBe(0);
  expect(await workspacePrSnapshotService.acceptMonitoredObservation(input)).toMatchObject({
    applied: true,
  });
  expect(
    await workspacePrSnapshotService.acceptMonitoredObservation({
      ...input,
      observation: { ...redObservation, ciStatus: 'SUCCESS' },
    })
  ).toEqual({ applied: false, eventIds: [] });
  expect(await workspacePrSnapshotService.find(target)).toMatchObject({
    ciStatus: 'FAILURE',
    revision: 1,
    observation: redObservation,
  });
  const sibling = {
    ...redObservation,
    url: 'https://github.com/org/repo/pull/2',
    number: 2,
    headSha: 'sibling-head',
  };
  await workspacePrSnapshotService.acceptMonitoredObservation({
    target: { workspaceId: 'w', prId: 'sibling' },
    expectedPrRevision: 0,
    expectedEventEpoch: 1,
    observation: sibling,
  });
  await workspacePrSnapshotService.acceptMonitoredObservation({
    ...input,
    expectedPrRevision: 1,
    observation: { ...redObservation, prState: 'MERGED', ciStatus: 'SUCCESS' },
  });
  expect(
    (await workspacePRMonitoringService.listPending('w', 'sibling')).map((e) => e.kind)
  ).toEqual(['CI_FAILED']);
  expect(await db.prisma.agentSession.count()).toBe(1);
});
it('defers a busy main session, then freezes one bounded update and reuses it on retry', async () => {
  const request = { workspaceId: 'w', prId: 'sibling', bindingRevision: 1 };
  state.busy = true;
  expect(await preparePRDelivery({ sessionId: 'main', request })).toMatchObject({
    status: 'blocked',
  });
  expect((await workspacePRMonitoringService.listPending('w', 'sibling'))[0]).toMatchObject({
    attempts: 0,
    deliveryId: null,
  });
  state.busy = false;
  const prepared = await preparePRDelivery({ sessionId: 'main', request });
  expect(prepared.status).toBe('ready');
  if (prepared.status !== 'ready') {
    throw new Error('Expected delivery');
  }
  expect(prepared.delivery.text).toContain('PR update: "org/repo" #2');
  expect(Buffer.byteLength(prepared.delivery.text)).toBeLessThanOrEqual(16_384);
  await prBackgroundDeliveryPort.fail(prepared.delivery, new Error('temporary transport failure'));
  const retry = await preparePRDelivery({ sessionId: 'main', request });
  expect(retry).toMatchObject({
    status: 'ready',
    delivery: {
      deliveryId: prepared.delivery.deliveryId,
      text: prepared.delivery.text,
      attempt: 2,
    },
  });
  if (retry.status !== 'ready') {
    throw new Error('Expected retry');
  }
  await prBackgroundDeliveryPort.complete(retry.delivery);
  expect(await workspacePRMonitoringService.listPending('w', 'sibling')).toEqual([]);
  expect(await db.prisma.agentSession.findUnique({ where: { id: 'main' } })).toMatchObject({
    model: 'custom-model',
    providerSessionId: 'existing-main',
  });
  expect(await db.prisma.agentSession.count()).toBe(1);
});

it('delivers a dedicated PR batch through the same ledger and guards sibling recipients', async () => {
  await db.prisma.agentSession.create({
    data: {
      id: 'dedicated',
      workspaceId: 'w',
      workspacePrId: 'p',
      workflow: 'pr-monitoring',
      model: 'custom',
      provider: 'CODEX',
      providerSessionId: 'dedicated-provider',
    },
  });
  await db.prisma.workspacePRDedicatedSession.create({
    data: { prId: 'p', sessionId: 'dedicated' },
  });
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: 'w' },
    data: {
      enabled: true,
      deliveryMode: 'DEDICATED',
      bindingRevision: 100,
      deliveryPauseReason: null,
    },
  });
  await db.prisma.workspacePREvent.deleteMany({ where: { workspaceId: 'w' } });
  await db.prisma.workspacePREvent.create({
    data: {
      id: 'dedicated-event',
      workspaceId: 'w',
      prId: 'p',
      kind: 'CI_FAILED',
      deduplicationKey: 'dedicated-event',
      payload: {
        kind: 'CI_FAILED',
        target: { workspaceId: 'w', prId: 'p' },
        observation: redObservation,
      },
    },
  });
  const request = {
    workspaceId: 'w',
    prId: 'p',
    bindingRevision: 100,
    deliveryMode: 'DEDICATED' as const,
  };
  expect(await preparePRDelivery({ sessionId: 'main', request })).toEqual({ status: 'discard' });
  const result = await preparePRDelivery({ sessionId: 'dedicated', request });
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') {
    throw new Error('expected dedicated claim');
  }
  expect(result.delivery.text).toContain('dedicated conversation');
  expect(result.delivery.deliveryProviderSessionId).toBe('dedicated-provider');
  expect(await prBackgroundDeliveryPort.validate(result.delivery)).toBe(true);
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: 'w' },
    data: { deliveryMode: 'MAIN', bindingRevision: 101 },
  });
  expect(await prBackgroundDeliveryPort.validate(result.delivery)).toBe(false);
  const frozen = await db.prisma.workspacePREvent.findUniqueOrThrow({
    where: { id: 'dedicated-event' },
  });
  expect(frozen.deliveryText).toBe(result.delivery.text);
  expect(frozen.deliverySessionId).toBe('dedicated');
});

it('retains a competing dedicated request and wakes it after the workspace claim settles', async () => {
  const workspaceId = 'competing';
  await db.prisma.workspace.create({
    data: {
      id: workspaceId,
      projectId: 'project',
      name: 'Competing PRs',
      status: 'READY',
      worktreePath: db.tempDir,
      prMonitoring: { create: { enabled: true, deliveryMode: 'DEDICATED', bindingRevision: 1 } },
    },
  });
  const recipients = ['first', 'second'];
  for (const name of recipients) {
    const prId = `competing-${name}`;
    const observation = {
      ...redObservation,
      number: name === 'first' ? 101 : 102,
      url: `https://github.com/org/repo/pull/${name === 'first' ? 101 : 102}`,
    };
    await db.prisma.workspacePR.create({ data: { id: prId, workspaceId, url: observation.url } });
    await db.prisma.agentSession.create({
      data: {
        id: prId,
        workspaceId,
        workspacePrId: prId,
        workflow: 'pr-monitoring',
        provider: 'CODEX',
        providerSessionId: `${prId}-provider`,
      },
    });
    await db.prisma.workspacePRDedicatedSession.create({ data: { prId, sessionId: prId } });
    await db.prisma.workspacePREvent.create({
      data: {
        id: `${prId}-event`,
        workspaceId,
        prId,
        kind: 'CI_FAILED',
        deduplicationKey: prId,
        payload: { kind: 'CI_FAILED', target: { workspaceId, prId }, observation },
      },
    });
  }
  const inputs = recipients.map((name) => ({
    sessionId: `competing-${name}`,
    request: {
      workspaceId,
      prId: `competing-${name}`,
      bindingRevision: 1,
      deliveryMode: 'DEDICATED' as const,
    },
  }));
  const results = await Promise.all(inputs.map((input) => preparePRDelivery(input)));
  expect(results.map((result) => result.status).sort()).toEqual(['blocked', 'ready']);
  const winner = results.find((result) => result.status === 'ready');
  const waiting = inputs[results.findIndex((result) => result.status === 'blocked')]!;
  if (winner?.status !== 'ready') {
    throw new Error('Expected a single workspace claim');
  }
  expect(
    await workspacePRMonitoringService.listPending(workspaceId, waiting.request.prId)
  ).toMatchObject([{ state: 'PENDING', attempts: 0, deliveryId: null }]);
  await prBackgroundDeliveryPort.complete(winner.delivery);
  expect(sessionBackgroundDeliveryService.enqueue).toHaveBeenCalledWith(
    waiting.sessionId,
    waiting.request
  );
  expect(await preparePRDelivery(waiting)).toMatchObject({
    status: 'ready',
    delivery: { attempt: 1 },
  });
});

it('coalesces poll, manual refresh, and delivery through separately composed observation ports', async () => {
  const workspaceId = 'observation-graph';
  const prId = 'observation-pr';
  await db.prisma.workspace.create({
    data: {
      id: workspaceId,
      projectId: 'project',
      name: 'Observation graph',
      status: 'READY',
      worktreePath: db.tempDir,
      prMonitoring: { create: { enabled: true, eventEpoch: 1 } },
      prs: { create: { id: prId, url: redObservation.url } },
    },
  });
  const graph = { ...defaultPRMonitoringServices };
  const fetched = deferred<typeof redObservation>();
  const fetch = vi.spyOn(prObservationService, 'fetch').mockReturnValue(fetched.promise);
  const publish = vi.spyOn(prSnapshotService, 'emit');
  const target = { workspaceId, prId };
  const pollPorts = createPRObservationPorts(graph);
  const manualPorts = createPRObservationPorts(graph);
  const deliveryPorts = createPRDeliveryPorts(graph);
  const results = [
    observeMonitoredPR(pollPorts, target),
    observeMonitoredPR(manualPorts, target, { force: true }),
    deliveryPorts.refreshObservation(target),
  ];
  fetched.resolve(redObservation);
  expect(await Promise.all(results)).toEqual([true, true, true]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await workspacePrSnapshotService.find(target)).toMatchObject({ revision: 1 });
  expect(await workspacePRMonitoringService.listPending(workspaceId, prId)).toMatchObject([
    { kind: 'CI_FAILED' },
  ]);
  expect(publish).toHaveBeenCalledExactlyOnceWith(PR_SNAPSHOT_UPDATED, {
    workspaceId,
    prId,
    prUrl: redObservation.url,
    prNumber: 1,
    prState: 'OPEN',
    previousPrState: 'NONE',
    prCiStatus: 'FAILURE',
    prReviewState: null,
  });
  // A new wrapper reuses the accepted revision without another GitHub fetch.
  expect(await observeMonitoredPR(createPRObservationPorts(graph), target)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  // Another application graph with the same underlying services has its own cache.
  expect(await observeMonitoredPR(createPRObservationPorts({ ...graph }), target)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('accepts a changed head without superseding an in-flight frozen failure', async () => {
  const workspaceId = 'policy-flow';
  const prId = 'policy-pr';
  const sessionId = 'policy-main';
  const target = { workspaceId, prId };
  await db.prisma.workspace.create({
    data: {
      id: workspaceId,
      projectId: 'project',
      name: 'Policy flow',
      status: 'READY',
      worktreePath: db.tempDir,
      prMonitoring: { create: { enabled: true, bindingRevision: 1, eventEpoch: 1 } },
      prs: { create: { id: prId, url: redObservation.url } },
    },
  });
  await db.prisma.agentSession.create({
    data: {
      id: sessionId,
      workspaceId,
      workflow: 'implement',
      provider: 'CODEX',
      providerSessionId: 'policy-provider',
    },
  });
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId },
    data: { recipientSessionId: sessionId },
  });
  const accepted = await workspacePrSnapshotService.acceptMonitoredObservation({
    target,
    expectedPrRevision: 0,
    expectedEventEpoch: 1,
    observation: redObservation,
  });
  expect(accepted.eventIds).toHaveLength(1);
  const prepared = await preparePRDelivery({
    sessionId,
    request: { workspaceId, prId, bindingRevision: 1 },
  });
  if (prepared.status !== 'ready') {
    throw new Error('Expected a frozen failure delivery');
  }
  const changed = await workspacePrSnapshotService.acceptMonitoredObservation({
    target,
    expectedPrRevision: 1,
    expectedEventEpoch: 1,
    observation: { ...redObservation, headSha: 'next-head' },
  });
  expect(changed.eventIds).toHaveLength(1);
  const frozen = await db.prisma.workspacePREvent.findUniqueOrThrow({
    where: { id: accepted.eventIds[0]! },
  });
  expect(frozen).toMatchObject({
    state: 'DISPATCHING',
    deliveryId: prepared.delivery.deliveryId,
    deliveryText: prepared.delivery.text,
  });
  const next = await db.prisma.workspacePREvent.findUniqueOrThrow({
    where: { id: changed.eventIds[0]! },
  });
  expect(next).toMatchObject({
    state: 'PENDING',
    deliveryId: null,
    kind: 'CI_FAILED',
    payload: { observation: { headSha: 'next-head' } },
  });
  await prBackgroundDeliveryPort.complete(prepared.delivery);
  expect(
    (await workspacePRMonitoringService.listPending(workspaceId, prId)).map((e) => e.id)
  ).toEqual(changed.eventIds);
});
