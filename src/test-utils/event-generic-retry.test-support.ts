import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import {
  createEventDeliveryFixture,
  waitForEventFixture,
  releaseEventBoundaries,
  drainEventFixtureTasks,
} from '@/backend/orchestration/testing/event-delivery.test-support';
import {
  eventProviderCollection,
  fakeEventProvider,
} from '@/backend/orchestration/testing/event-provider.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

export let db: IntegrationDatabase;
export let h: Awaited<ReturnType<typeof createEventDeliveryFixture>>;
export let consumer: ReturnType<
  typeof import('@/backend/orchestration/event-run-consumer.orchestrator').createEventRunConsumer
>;
export let providers: ReturnType<typeof fakeEventProvider>[];
const exitTasks = new Set<Promise<void>>();
export let waitForProviders: ReturnType<typeof eventProviderCollection>['waitForProviders'];
beforeEach(async () => {
  db = await createIntegrationDatabase();
  const accounts = await vi.importActual<typeof import('@/backend/services/codex-accounts')>(
    '@/backend/services/codex-accounts'
  );
  vi.spyOn(accounts.codexAccountService, 'withAccountReservation').mockImplementation(
    (_options, operation) => operation('event-test-account')
  );
  vi.spyOn(accounts.codexAccountService, 'getEnabledAccountIds').mockResolvedValue([
    'event-test-account',
  ]);
  vi.spyOn(accounts.codexAccountService, 'getRuntimeContext').mockImplementation(
    async (id = 'event-test-account') => ({
      accountId: id,
      homeDir: db.tempDir,
      sessionsDir: db.tempDir,
      env: {},
    })
  );
  h = await createEventDeliveryFixture(db, 'CODEX');
  const { SessionRuntimeExitCoordinator } = await vi.importActual<
    typeof import('@/backend/services/session/service/lifecycle/session-runtime-exit.coordinator')
  >('@/backend/services/session/service/lifecycle/session-runtime-exit.coordinator');
  const exit = SessionRuntimeExitCoordinator.prototype.handleExit;
  vi.spyOn(SessionRuntimeExitCoordinator.prototype, 'handleExit').mockImplementation(function (
    this: InstanceType<typeof SessionRuntimeExitCoordinator>,
    event
  ) {
    const task = exit.call(this, event);
    exitTasks.add(task);
    void task.finally(() => exitTasks.delete(task)).catch(() => undefined);
    return task;
  });
  const collection = eventProviderCollection();
  ({ providers, waitForProviders } = collection);
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('No host signals');
  });
  const factory = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-client-factory')
  >('@/backend/services/session/service/acp/acp-client-factory');
  const { AcpNativeSessionTracker } = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-native-session-tracker')
  >('@/backend/services/session/service/acp/acp-native-session-tracker');
  vi.spyOn(factory.AcpClientFactory.prototype, 'createClient').mockImplementation(({ options }) => {
    const provider = fakeEventProvider(
      h.session.AcpProcessHandle,
      options,
      undefined,
      new AcpNativeSessionTracker()
    );
    collection.add(provider);
    return Promise.resolve(provider.handle);
  });
  const { createEventRunConsumer } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-consumer.orchestrator')
  >('@/backend/orchestration/event-run-consumer.orchestrator');
  consumer = createEventRunConsumer();
}, 30_000);
afterEach(async () => {
  try {
    releaseEventBoundaries();
    for (const provider of providers) {
      provider.response.resolve({ stopReason: 'end_turn' });
    }
    await consumer.drain();
    await strictStop();
    await consumer.stop();
    await drainEventFixtureTasks();
    await h.workspace.workspaceActivityService.withNotificationsSuppressed(
      h.claim.reservedWorkspaceId,
      async () => {
        await h.session.acpRuntimeManager.stopAllClients(10);
        await new Promise<void>((resolve) => setImmediate(resolve));
        while (exitTasks.size > 0) {
          await Promise.allSettled([...exitTasks]);
        }
      }
    );
    h.session.sessionPromptTurnCompletionService.clearAll();
    h.session.sessionDomainService.clearAllSessions();
  } finally {
    const signals = vi.mocked(process.kill).mock.calls.slice();
    vi.restoreAllMocks();
    vi.useRealTimers();
    await destroyIntegrationDatabase(db);
    expect(signals).toEqual([]);
  }
});

const row = () => db.prisma.agentRun.findUniqueOrThrow({ where: { id: h.claim.runId } });
export async function context() {
  const run = await row();
  return {
    projectId: h.workspaceSource.projectId,
    claim: {
      ...h.claim,
      workerGeneration: run.workerGeneration,
      attemptGeneration: run.attemptGeneration,
    },
    attempt: (await h.read()).attempt,
  };
}
export async function launch() {
  await consumer.consumeClaim(h.claim, new AbortController().signal);
  await waitForProviders(1);
  const provider = providers[0];
  if (!provider) {
    throw new Error('Initial provider missing');
  }
  await waitForEventFixture(provider.called, 'retry provider initial prompt');
}
export async function strictStop() {
  const groups = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-owned-group')
  >('@/backend/services/session/service/acp/acp-owned-group');
  vi.spyOn(groups, 'stopOwnedRuntimeGroup').mockImplementation(({ child }) => {
    child.kill();
    return Promise.resolve('LOCAL_RUNTIME_GROUP_STOPPED');
  });
}

export async function recoveryWorktree() {
  const path = join(db.tempDir, 'retry-worktree');
  await mkdir(path);
  await db.prisma.workspace.update({
    where: { id: h.claim.reservedWorkspaceId },
    data: { worktreePath: path },
  });
  return path;
}

export async function beginIndependentPrompt(sessionId: string, replacement: true | 'inflight') {
  if (replacement === true) {
    await h.session.sessionLifecycleService.stopSession(sessionId);
    await h.session.sessionLifecycleService.startSession(sessionId, { initialPrompt: '' });
  }
  const provider = providers[replacement === true ? 3 : 1];
  if (!provider) {
    throw new Error('Current provider missing');
  }
  const turn =
    replacement === true
      ? h.session.sessionService.sendSessionMessage(sessionId, 'New runtime prompt')
      : h.session.acpRuntimeManager.sendPrompt(sessionId, [
          { type: 'text', text: 'Independent current prompt' },
        ]);
  await provider.called;
  expect(provider.handle.isPromptInFlight).toBe(true);
  return { turn, provider };
}

export async function readyRetryPRFixture() {
  await launch();
  const initial = providers[0];
  if (!initial) {
    throw new Error('Initial fixture provider missing');
  }
  initial.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  await recoveryWorktree();
  const other = await db.prisma.agentSession.create({
    data: {
      workspaceId: h.claim.reservedWorkspaceId,
      workflow: 'default',
      provider: 'CODEX',
      model: 'gpt-5.4',
      codexAccountId: 'event-test-account',
      status: 'IDLE',
    },
  });
  await h.session.sessionLifecycleService.startSession(other.id, { initialPrompt: '' });
  const { captureWorkspaceRetryGuard } = await vi.importActual<
    typeof import('@/backend/orchestration/workspace-retry-authority')
  >('@/backend/orchestration/workspace-retry-authority');
  const workspace = await h.workspace.workspaceDataService.findByIdWithProject(
    h.claim.reservedWorkspaceId
  );
  if (!workspace) {
    throw new Error('Missing workspace');
  }
  const guard = await captureWorkspaceRetryGuard(workspace);
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: workspace.id },
    data: { enabled: true, bindingRevision: 1, eventEpoch: 1, recipientSessionId: other.id },
  });
  const { redObservation } = await vi.importActual<
    typeof import('@/shared/pr-monitoring.test-helpers')
  >('@/shared/pr-monitoring.test-helpers');
  for (const [id, number] of [
    ['first', 1],
    ['second', 2],
  ] as const) {
    const observation = {
      ...redObservation,
      number,
      url: `https://github.com/org/repo/pull/${number}`,
    };
    await db.prisma.workspacePR.create({
      data: { id, workspaceId: workspace.id, url: observation.url },
    });
    expect(
      await h.workspace.workspacePrSnapshotService.acceptMonitoredObservation({
        target: { workspaceId: workspace.id, prId: id },
        expectedPrRevision: 0,
        expectedEventEpoch: 1,
        observation,
      })
    ).toMatchObject({ applied: true });
  }
  const { createPRBackgroundDeliveryPort } = await vi.importActual<
    typeof import('@/backend/orchestration/pr-event-delivery-port')
  >('@/backend/orchestration/pr-event-delivery-port');
  const { defaultPRDeliveryPorts } = await vi.importActual<
    typeof import('@/backend/orchestration/pr-delivery-dependencies')
  >('@/backend/orchestration/pr-delivery-dependencies');
  const port = createPRBackgroundDeliveryPort({
    ...defaultPRDeliveryPorts,
    refreshObservation: async () => true,
  });
  if (!guard) {
    throw new Error('Missing event retry guard');
  }
  return { other, workspace, guard, port };
}

/** Read the compatibility ledger from the normalized frozen effect owner. */
export async function readPRDeliveryEvents(workspaceId: string) {
  return h.workspace.workspacePRMonitoringService.projectEvents(
    await db.prisma.workspacePREvent.findMany({ where: { workspaceId } }),
    await db.prisma.workspacePRDelivery.findMany({ where: { workspaceId } })
  );
}
