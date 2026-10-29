import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  PR_SNAPSHOT_UPDATED,
  prObservationService,
  prSnapshotService,
} from '@/backend/services/github';
import { ratchetService } from '@/backend/services/ratchet';
import {
  sessionBackgroundDeliveryService,
  sessionDispatchService,
  findPRDeliveryReceipt,
} from '@/backend/services/session';
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
  sessionBackgroundDeliveryService: {
    enqueue: vi.fn(() => ({ queued: true })),
    invalidate: vi.fn(),
  },
  sessionDispatchService: { tryDispatchNextMessage: vi.fn(async () => undefined) },
  findPRDeliveryReceipt: vi.fn(),
}));

vi.mock('./pr-delivery-readiness', () => ({ recipientCanDispatch: vi.fn(async () => true) }));
vi.mock('@/backend/services/settings', () => ({
  userSettingsService: { get: vi.fn(async () => ({ ratchetReplyToPrComments: true })) },
}));

import { createEventCollectorOrchestrator } from './event-collector.orchestrator';
import { createPRDeliveryPorts, defaultPRDeliveryPorts } from './pr-delivery-dependencies';
import { recoverPRDeliveries } from './pr-delivery-recovery';
import { prBackgroundDeliveryPort } from './pr-event-delivery-port';
import { preparePRDelivery, wakePRDelivery } from './pr-event-delivery.orchestrator';
import {
  createPRObservationPorts,
  defaultPRMonitoringServices,
} from './pr-monitoring-dependencies';
import { bindIssueMonitoringSession, setPRMonitoring } from './pr-monitoring.orchestrator';
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
    prEventsCreated: true,
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

it('queues a committed failure after an empty idle wake without waiting for another poll', async () => {
  const workspaceId = 'post-idle-observation';
  const prId = 'post-idle-pr';
  await db.prisma.workspace.create({
    data: {
      id: workspaceId,
      projectId: 'project',
      name: 'Post-idle observation',
      status: 'READY',
      worktreePath: db.tempDir,
      prMonitoring: { create: { enabled: true, bindingRevision: 1, eventEpoch: 1 } },
      prs: { create: { id: prId, url: redObservation.url, state: 'OPEN' } },
    },
  });
  const sessionId = 'post-idle-session';
  await db.prisma.agentSession.create({
    data: {
      id: sessionId,
      workspaceId,
      workflow: 'implement',
      provider: 'CODEX',
      providerSessionId: 'post-idle-provider',
    },
  });
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId },
    data: { recipientSessionId: sessionId },
  });
  const graph = { ...defaultPRMonitoringServices };
  const delivery = createPRDeliveryPorts(graph);
  const wake = vi.fn((id: string, isCurrent?: () => boolean) =>
    wakePRDelivery(id, delivery, isCurrent)
  );
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  ratchetService.configure({
    observe: vi.fn(),
    wake,
    setMonitoring: vi.fn(),
  });
  const collector = createEventCollectorOrchestrator({
    createLogger: () => logger,
    prSnapshotService,
    ratchetService,
    workspaceActivityService: new EventEmitter(),
    workspaceStateMachine: new EventEmitter(),
    runScriptStateMachine: new EventEmitter(),
    sessionDomainService: new EventEmitter(),
    workspaceDataService: {
      subscribeAcceptedBranch: () => vi.fn(),
      findRatchetProjection: async () => null,
    },
    workspaceSnapshotStore: {
      getAllWorkspaceIds: () => [],
      getByWorkspaceId: () => undefined,
      upsert: vi.fn(),
    },
  } as never);
  collector.start();
  try {
    vi.mocked(sessionBackgroundDeliveryService.enqueue).mockClear();
    vi.mocked(sessionDispatchService.tryDispatchNextMessage).mockClear();
    await wakePRDelivery(workspaceId, delivery);
    expect(sessionBackgroundDeliveryService.enqueue).not.toHaveBeenCalled();

    const fetch = vi.spyOn(prObservationService, 'fetch').mockResolvedValue(redObservation);
    const target = { workspaceId, prId };
    const ports = createPRObservationPorts(graph);
    state.busy = true;
    await observeMonitoredPR(ports, target, { force: true });
    await vi.waitFor(() => {
      expect(sessionBackgroundDeliveryService.enqueue).toHaveBeenCalledExactlyOnceWith(sessionId, {
        workspaceId,
        prId,
        bindingRevision: 1,
      });
      expect(sessionDispatchService.tryDispatchNextMessage).toHaveBeenCalledWith(sessionId);
    });
    const request = { workspaceId, prId, bindingRevision: 1 };
    expect(await preparePRDelivery({ sessionId, request }, delivery)).toMatchObject({
      status: 'blocked',
    });
    expect((await workspacePRMonitoringService.listPending(workspaceId))[0]).toMatchObject({
      state: 'PENDING',
      deliveryId: null,
    });
    await observeMonitoredPR(ports, target, { force: true });
    expect(sessionBackgroundDeliveryService.enqueue).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);

    wake.mockRejectedValueOnce(new Error('Delivery temporarily unavailable'));
    fetch.mockResolvedValue({ ...redObservation, headSha: 'wake-failure' });
    expect(await observeMonitoredPR(ports, target, { force: true })).toBe(true);
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith('PR delivery wake deferred after observation', {
        workspaceId,
        error: 'Delivery temporarily unavailable',
      });
    });
    expect((await workspacePRMonitoringService.listPending(workspaceId))[0]).toMatchObject({
      state: 'PENDING',
      payload: { observation: { headSha: 'wake-failure' } },
    });
    await wakePRDelivery(workspaceId, delivery);
    expect(sessionBackgroundDeliveryService.enqueue).toHaveBeenCalledTimes(2);

    collector.stop();
    fetch.mockResolvedValue({ ...redObservation, headSha: 'after-collector-stop' });
    await observeMonitoredPR(ports, target, { force: true });
    expect(sessionBackgroundDeliveryService.enqueue).toHaveBeenCalledTimes(2);
  } finally {
    state.busy = false;
    collector.stop();
  }
});

it.each([false, true])(
  'keeps issue-start monitoring silent until PR events exist (attached PR=%s)',
  async (attachedPR) => {
    const workspaceId = `issue-start-${attachedPR}`;
    const sessionId = `${workspaceId}-main`;
    const prId = `${workspaceId}-pr`;
    await db.prisma.workspace.create({
      data: {
        id: workspaceId,
        projectId: 'project',
        name: 'Issue start',
        status: 'READY',
        worktreePath: db.tempDir,
        prMonitoring: { create: { enabled: true } },
        ...(attachedPR ? { prs: { create: { id: prId, url: redObservation.url } } } : {}),
      },
    });
    await db.prisma.agentSession.create({
      data: {
        id: sessionId,
        workspaceId,
        workflow: 'implement',
        provider: 'CODEX',
        providerSessionId: sessionId,
        model: 'custom',
      },
    });
    vi.mocked(sessionBackgroundDeliveryService.enqueue).mockClear();
    vi.mocked(sessionDispatchService.tryDispatchNextMessage).mockClear();
    await bindIssueMonitoringSession(workspaceId, sessionId);
    const config = await workspacePRMonitoringService.get(workspaceId);
    expect(config).toMatchObject({ enabled: true, recipientSessionId: sessionId });
    await setPRMonitoring({
      workspaceId,
      enabled: true,
      recipientSessionId: sessionId,
      expectedBindingRevision: config!.bindingRevision,
    });
    expect(await db.prisma.workspacePREvent.count({ where: { workspaceId } })).toBe(0);
    expect(sessionBackgroundDeliveryService.enqueue).not.toHaveBeenCalled();
    expect(sessionDispatchService.tryDispatchNextMessage).not.toHaveBeenCalled();

    if (!attachedPR) {
      await db.prisma.workspacePR.create({
        data: { id: prId, workspaceId, url: redObservation.url },
      });
    }
    await workspacePrSnapshotService.acceptMonitoredObservation({
      target: { workspaceId, prId },
      expectedPrRevision: 0,
      expectedEventEpoch: config!.eventEpoch,
      observation: redObservation,
    });
    await wakePRDelivery(workspaceId);
    expect(sessionBackgroundDeliveryService.enqueue).toHaveBeenCalledExactlyOnceWith(sessionId, {
      workspaceId,
      prId,
      bindingRevision: config!.bindingRevision,
    });
  }
);

it('recovers an absent frozen batch with a detached target and delivers attached siblings with fresh facts', async () => {
  const workspaceId = 'detached-main-recovery';
  const sessionId = `${workspaceId}-session`;
  const targets = ['one', 'two', 'three'].map((name, index) => ({
    id: `${workspaceId}-${name}`,
    workspaceId,
    url: `https://github.com/org/repo/pull/${index + 10}`,
  }));
  await db.prisma.workspace.create({
    data: {
      id: workspaceId,
      projectId: 'project',
      name: workspaceId,
      status: 'READY',
      worktreePath: db.tempDir,
      prMonitoring: { create: { enabled: true, bindingRevision: 1 } },
    },
  });
  await db.prisma.workspacePR.createMany({ data: targets });
  await db.prisma.agentSession.create({
    data: {
      id: sessionId,
      workspaceId,
      workflow: 'implement',
      provider: 'CODEX',
      providerSessionId: `${sessionId}-provider`,
    },
  });
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId },
    data: { recipientSessionId: sessionId },
  });
  const addFact = (index: number) => {
    const target = targets[index]!;
    return db.prisma.workspacePREvent.create({
      data: {
        workspaceId,
        prId: target.id,
        kind: 'CI_FAILED',
        deduplicationKey: `failed-${index}`,
        payload: {
          kind: 'CI_FAILED',
          target: { workspaceId, prId: target.id },
          observation: { ...redObservation, url: target.url, number: index + 10 },
        },
      },
    });
  };
  const original = [await addFact(0), await addFact(1)];
  const prepared = await preparePRDelivery({
    sessionId,
    request: { workspaceId, prId: targets[0]!.id, bindingRevision: 1 },
  });
  if (prepared.status !== 'ready') {
    throw new Error('Expected original frozen delivery');
  }
  const frozen = prepared.delivery;
  await prBackgroundDeliveryPort.fail(frozen, new Error('Temporary transport failure'));
  await db.prisma.workspacePR.update({
    where: { id: targets[1]!.id },
    data: { detachedAt: new Date() },
  });
  const fresh = await addFact(2);

  vi.mocked(findPRDeliveryReceipt).mockResolvedValue('unavailable');
  await recoverPRDeliveries(sessionId);
  expect(
    await db.prisma.workspacePREvent.findMany({ where: { deliveryId: frozen.deliveryId } })
  ).toEqual(
    expect.arrayContaining(
      original.map((row) =>
        expect.objectContaining({
          id: row.id,
          state: 'PENDING',
          deliveryText: frozen.text,
          deliveryId: frozen.deliveryId,
        })
      )
    )
  );
  expect(await db.prisma.workspacePREvent.count({ where: { workspaceId } })).toBe(3);
  await workspacePRMonitoringService.resume(sessionId);
  vi.mocked(findPRDeliveryReceipt).mockResolvedValue('absent');
  await recoverPRDeliveries(sessionId);
  await recoverPRDeliveries(sessionId);
  expect(
    await db.prisma.workspacePREvent.findMany({ where: { deliveryId: frozen.deliveryId } })
  ).toEqual(
    expect.arrayContaining(
      original.map((row) =>
        expect.objectContaining({
          id: row.id,
          state: 'CANCELLED',
          deliveryText: frozen.text,
          deliveryId: frozen.deliveryId,
        })
      )
    )
  );
  const pending = await workspacePRMonitoringService.listPending(workspaceId);
  expect(pending).toHaveLength(2);
  expect(pending).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        prId: targets[0]!.id,
        state: 'PENDING',
        deliveryId: null,
        deduplicationKey: original[0]!.deduplicationKey,
      }),
      expect.objectContaining({
        id: fresh.id,
        prId: targets[2]!.id,
        state: 'PENDING',
        deliveryId: null,
      }),
    ])
  );
  const binding = await workspacePRMonitoringService.get(workspaceId);
  const next = await preparePRDelivery({
    sessionId,
    request: { workspaceId, prId: targets[2]!.id, bindingRevision: binding!.bindingRevision },
  });
  if (next.status !== 'ready') {
    throw new Error('Expected eligible sibling delivery');
  }
  expect(next.delivery.deliveryId).not.toBe(frozen.deliveryId);
  expect(next.delivery.text).toContain(targets[0]!.url);
  expect(next.delivery.text).toContain(targets[2]!.url);
  expect(next.delivery.text).not.toContain(targets[1]!.url);
  await prBackgroundDeliveryPort.complete(next.delivery);
  expect(await workspacePRMonitoringService.listPending(workspaceId)).toEqual([]);
});

it('delivers a large MAIN ledger in bounded batches without acknowledging deferred PRs', async () => {
  const workspaceId = 'bounded-main-ledger';
  const sessionId = `${workspaceId}-session`;
  const prs = Array.from({ length: 70 }, (_, index) => ({
    id: `${workspaceId}-${index}`,
    workspaceId,
    url: `https://github.com/org/repo/pull/${index + 100}`,
  }));
  await db.prisma.workspace.create({
    data: {
      id: workspaceId,
      projectId: 'project',
      name: workspaceId,
      status: 'READY',
      worktreePath: db.tempDir,
      prMonitoring: { create: { enabled: true, bindingRevision: 1 } },
    },
  });
  await db.prisma.workspacePR.createMany({ data: prs });
  await db.prisma.agentSession.create({
    data: {
      id: sessionId,
      workspaceId,
      workflow: 'implement',
      provider: 'CODEX',
      providerSessionId: `${sessionId}-provider`,
    },
  });
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId },
    data: { recipientSessionId: sessionId },
  });
  await db.prisma.workspacePREvent.createMany({
    data: prs.map((pr, index) => ({
      id: `${pr.id}-event`,
      workspaceId,
      prId: pr.id,
      kind: 'CI_FAILED',
      deduplicationKey: `failure-${index}`,
      payload: {
        kind: 'CI_FAILED',
        target: { workspaceId, prId: pr.id },
        observation: {
          ...redObservation,
          url: pr.url,
          number: index + 100,
          headBranch: `feature-${'x'.repeat(300)}`,
        },
      },
    })),
  });
  const delivered = new Set<string>();
  let batches = 0;
  while (delivered.size < prs.length && batches < 10) {
    const pending = await workspacePRMonitoringService.listPending(workspaceId);
    const representative = pending[0]?.prId;
    if (!representative) {
      throw new Error('Expected pending ledger facts');
    }
    const prepared = await preparePRDelivery({
      sessionId,
      request: { workspaceId, prId: representative, bindingRevision: 1 },
    });
    if (prepared.status !== 'ready') {
      throw new Error('Expected bounded MAIN delivery');
    }
    const delivery = prepared.delivery;
    expect(Buffer.byteLength(delivery.text)).toBeLessThanOrEqual(16_384);
    expect(delivery.eventIds.length).toBeGreaterThan(0);
    expect(delivery.eventIds.length).toBeLessThan(prs.length);
    for (const pr of prs) {
      if (delivery.eventIds.includes(`${pr.id}-event`)) {
        expect(delivery.text).toContain(JSON.stringify(pr.url));
        expect(delivered.has(pr.id)).toBe(false);
        delivered.add(pr.id);
      } else {
        expect(delivery.text).not.toContain(JSON.stringify(pr.url));
      }
    }
    expect(
      await db.prisma.workspacePREvent.count({ where: { workspaceId, state: 'PENDING' } })
    ).toBe(prs.length - delivered.size);
    await prBackgroundDeliveryPort.complete(delivery);
    expect(
      await db.prisma.workspacePREvent.count({ where: { workspaceId, state: 'DELIVERED' } })
    ).toBe(delivered.size);
    batches++;
  }
  expect(delivered.size).toBe(70);
  expect(batches).toBeGreaterThan(1);
  expect(await workspacePRMonitoringService.get(workspaceId)).toMatchObject({
    deliveryPauseReason: null,
  });
});
