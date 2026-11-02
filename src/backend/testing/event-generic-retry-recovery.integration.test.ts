import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createEventDeliveryFixture,
  releaseEventBoundaries,
  boundary,
  drainEventFixtureTasks,
} from '@/backend/orchestration/testing/event-delivery.test-support';
import { fakeEventProvider } from '@/backend/orchestration/testing/event-provider.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';

let db: IntegrationDatabase;
let h: Awaited<ReturnType<typeof createEventDeliveryFixture>>;
let consumer: ReturnType<
  typeof import('@/backend/orchestration/event-run-consumer.orchestrator').createEventRunConsumer
>;
let providers: ReturnType<typeof fakeEventProvider>[];
beforeEach(async () => {
  db = await createIntegrationDatabase();
  const accounts = await vi.importActual<typeof import('@/backend/services/codex-accounts')>(
    '@/backend/services/codex-accounts'
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
  providers = [];
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
    providers.push(provider);
    return Promise.resolve(provider.handle);
  });
  const { createEventRunConsumer } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-consumer.orchestrator')
  >('@/backend/orchestration/event-run-consumer.orchestrator');
  consumer = createEventRunConsumer();
}, 30_000);
afterEach(async () => {
  releaseEventBoundaries();
  for (const provider of providers) {
    provider.response.resolve({ stopReason: 'end_turn' });
  }
  await consumer.drain();
  await consumer.stop();
  await drainEventFixtureTasks();
  await h.session.acpRuntimeManager.stopAllClients(10).catch(() => undefined);
  h.session.sessionPromptTurnCompletionService.clearAll();
  h.session.sessionDomainService.clearAllSessions();
  expect(process.kill).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await destroyIntegrationDatabase(db);
});

const row = () => db.prisma.agentRun.findUniqueOrThrow({ where: { id: h.claim.runId } });
async function context() {
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
async function launch() {
  await consumer.consumeClaim(h.claim, new AbortController().signal);
  await vi.waitFor(() => expect(providers).toHaveLength(1));
  await providers[0]!.called;
}
async function strictStop() {
  const groups = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-owned-group')
  >('@/backend/services/session/service/acp/acp-owned-group');
  vi.spyOn(groups, 'stopOwnedRuntimeGroup').mockImplementation(({ child }) => {
    child.kill();
    return Promise.resolve('LOCAL_RUNTIME_GROUP_STOPPED');
  });
}

async function recoveryWorktree() {
  const path = join(db.tempDir, 'retry-worktree');
  await mkdir(path);
  await db.prisma.workspace.update({
    where: { id: h.claim.reservedWorkspaceId },
    data: { worktreePath: path },
  });
  return path;
}

it('rejects manual event RETRY while a generic startup script holds PROVISIONING, then permits READY', async () => {
  await launch();
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  const worktreePath = await recoveryWorktree();
  const { captureWorkspaceRetryGuard } = await vi.importActual<
    typeof import('@/backend/orchestration/workspace-retry-authority')
  >('@/backend/orchestration/workspace-retry-authority');
  const source = await h.workspace.workspaceDataService.findByIdWithProject(
    h.claim.reservedWorkspaceId
  );
  if (!source) {
    throw new Error('Missing workspace');
  }
  const guard = await captureWorkspaceRetryGuard(source);
  await h.workspace.workspaceStateMachine.startProvisioningFromReady(source.id, 3, guard);
  const { startupScriptService } = await vi.importActual<
    typeof import('@/backend/services/run-script')
  >('@/backend/services/run-script');
  startupScriptService.configure({
    workspace: {
      markReady: (id) => h.workspace.workspaceStateMachine.markReady(id),
      markFailed: (id, error) => h.workspace.workspaceStateMachine.markFailed(id, error),
      clearInitOutput: (...args) => h.workspace.workspaceRunScriptService.clearInitOutput(...args),
      appendInitOutput: (...args) =>
        h.workspace.workspaceRunScriptService.appendInitOutput(...args),
      setInitScriptPid: (...args) =>
        h.workspace.workspaceRunScriptService.setInitScriptPid(...args),
      clearInitScriptPid: (...args) =>
        h.workspace.workspaceRunScriptService.clearInitScriptPid(...args),
    },
  });
  const { executeStartupScriptPipeline } = await vi.importActual<
    typeof import('@/backend/orchestration/workspace-init-script-pipeline')
  >('@/backend/orchestration/workspace-init-script-pipeline');
  await db.prisma.project.update({
    where: { id: source.projectId },
    data: {
      startupScriptCommand: 'touch started; while [ ! -f released ]; do sleep 0.02; done',
      startupScriptTimeout: 10,
    },
  });
  const workspace = await h.workspace.workspaceDataService.findByIdWithProject(source.id);
  if (!workspace) {
    throw new Error('Missing workspace');
  }
  const script = executeStartupScriptPipeline({
    workspaceId: source.id,
    workspaceWithProject: workspace,
    worktreePath,
    factoryConfig: null,
    guard,
  });
  const result = script.catch((error: unknown) => error);
  try {
    await vi.waitFor(async () => {
      await access(join(worktreePath, 'started'));
    });
    await strictStop();
    expect(
      await consumer.resolveAmbiguousRun({ ...(await context()), action: 'RETRY' })
    ).toMatchObject({ status: 'BLOCKED', reason: 'RESOURCES_UNAVAILABLE' });
    expect((await h.read()).attempt.attemptGeneration).toBe(h.attempt.attemptGeneration);
  } finally {
    await writeFile(join(worktreePath, 'released'), '');
  }
  expect(await result).toMatchObject({ handled: true, success: true });
  expect(
    await consumer.resolveAmbiguousRun({ ...(await context()), action: 'RETRY' })
  ).toMatchObject({ status: 'RETRIED' });
  await vi.waitFor(() => expect(providers).toHaveLength(2));
  await providers[1]!.called;
});

it('allows READY recovery during another session startup and fences the old generic continuation', async () => {
  await launch();
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  await recoveryWorktree();
  await db.prisma.agentSession.update({
    where: { id: h.attempt.sessionId },
    data: { status: 'RUNNING' },
  });
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
  const terminal = await vi.importActual<typeof import('@/backend/services/terminal')>(
    '@/backend/services/terminal'
  );
  vi.spyOn(terminal.terminalService, 'createTerminal').mockRejectedValue(
    new Error('No fixture terminal')
  );
  const gate = boundary();
  const start = h.session.sessionLifecycleService.startSession.bind(
    h.session.sessionLifecycleService
  );
  vi.spyOn(h.session.sessionLifecycleService, 'startSession').mockImplementation(
    async (id, options) => {
      if (id === other.id) {
        await gate.wait();
      }
      return start(id, options);
    }
  );
  const stop = vi.spyOn(h.session.sessionLifecycleService, 'stopWorkspaceSessions');
  const { initializeWorkspaceWorktree } = await vi.importActual<
    typeof import('@/backend/orchestration/workspace-init.orchestrator')
  >('@/backend/orchestration/workspace-init.orchestrator');
  await db.prisma.workspace.update({ where: { id: workspace.id }, data: { status: 'FAILED' } });
  const initialization = initializeWorkspaceWorktree(workspace.id, { guard });
  try {
    await gate.entered;
    expect(await db.prisma.workspace.findUnique({ where: { id: workspace.id } })).toMatchObject({
      status: 'READY',
    });
    await strictStop();
    expect(
      await consumer.resolveAmbiguousRun({ ...(await context()), action: 'RETRY' })
    ).toMatchObject({ status: 'RETRIED' });
    await vi.waitFor(() => expect(providers).toHaveLength(2));
    await providers[1]!.called;
  } finally {
    gate.release();
    await initialization;
  }
  expect(providers).toHaveLength(2);
  expect(stop).not.toHaveBeenCalled();
  expect(h.session.acpRuntimeManager.getClient(h.attempt.sessionId)).toBe(providers[1]!.handle);
  expect(await db.prisma.workspace.findUnique({ where: { id: workspace.id } })).toMatchObject({
    status: 'READY',
  });
});

it.each([true, false])(
  'checks queued configuration wait currentness, revoked=%s',
  async (revoked) => {
    await launch();
    providers[0]!.response.resolve({ stopReason: 'end_turn' });
    await consumer.drain();
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
    const provider = providers[0]!;
    const beforeConfig = provider.connection.setSessionConfigOption.mock.calls.length;
    const beforePrompt = provider.connection.prompt.mock.calls.length;
    const configuration = provider.handle.beginConfiguration();
    h.session.sessionDomainService.enqueue(h.attempt.sessionId, {
      id: 'queued-retry',
      timestamp: new Date().toISOString(),
      text: 'Follow up',
      settings: {
        selectedModel: 'gpt-5.4',
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });
    const entered = boundary();
    const pendingConfiguration = provider.handle.configurationReady;
    const readyRead = vi
      .spyOn(provider.handle, 'configurationReady', 'get')
      .mockImplementation(() => {
        void entered.wait();
        return pendingConfiguration;
      });
    const dispatch = h.session.sessionDispatchService.tryDispatchNextMessage(h.attempt.sessionId, {
      guard,
    });
    try {
      await entered.entered;
      if (revoked) {
        await db.prisma.agentInitialDelivery.update({
          where: { runId: h.claim.runId },
          data: { state: 'PENDING' },
        });
      }
    } finally {
      entered.release();
      readyRead.mockRestore();
      configuration.complete();
    }
    await dispatch;
    if (revoked) {
      expect(provider.connection.setSessionConfigOption.mock.calls.length).toBe(beforeConfig);
      expect(provider.connection.prompt.mock.calls.length).toBe(beforePrompt);
      expect(h.session.sessionDomainService.peekNextMessage(h.attempt.sessionId)?.id).toBe(
        'queued-retry'
      );
    } else {
      expect(provider.connection.setSessionConfigOption.mock.calls.length).toBeGreaterThan(
        beforeConfig
      );
      expect(provider.connection.prompt.mock.calls.length).toBe(beforePrompt + 1);
      expect(h.session.sessionDomainService.peekNextMessage(h.attempt.sessionId)).toBeUndefined();
    }
  }
);
