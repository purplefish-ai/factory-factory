import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { boundary } from '@/backend/orchestration/testing/event-delivery.test-support';
import {
  db,
  h,
  consumer,
  providers,
  waitForProviders,
  beginIndependentPrompt,
  context,
  launch,
  strictStop,
  recoveryWorktree,
  readyRetryPRFixture,
} from '@/test-utils/event-generic-retry.test-support';

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
  await waitForProviders(2);
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
    await waitForProviders(2);
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

it.each([
  ['start', true],
  ['start', false],
  ['get-or-create', true],
  ['get-or-create', false],
] as const)(
  'fences recovered notification dispatch through production bridge: %s revoked=%s',
  async (entry, revoked) => {
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
    const notification = await h.workspace.workspaceNotificationService.notifyParent({
      workspaceId: h.claim.reservedWorkspaceId,
      sourceWorkspaceId: 'source',
      sourceWorkspaceName: 'Source',
      sourceProjectName: 'Fixture',
      message: 'Recovered update',
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
    if (!guard) {
      throw new Error('Missing event guard');
    }
    // Wire the production selected-graph callback; do not replace it with fixture forwarding.
    const { createDefaultApplicationDependencies } =
      await vi.importActual<typeof import('@/backend/app-context')>('@/backend/app-context');
    const graph = createDefaultApplicationDependencies();
    graph.lifecycle.wireDomainBridges(graph.services);
    h.session.sessionDomainService.enqueue(other.id, {
      id: 'ordinary-input',
      timestamp: new Date().toISOString(),
      text: 'Queued ordinary work',
      settings: {
        selectedModel: 'gpt-5.4',
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });
    const { SessionNotificationDeliveryService } = await vi.importActual<
      typeof import('@/backend/services/session/service/lifecycle/session-notification-delivery.service')
    >('@/backend/services/session/service/lifecycle/session-notification-delivery.service');
    const recover = SessionNotificationDeliveryService.prototype.recoverPending;
    let recovered = 0;
    vi.spyOn(SessionNotificationDeliveryService.prototype, 'recoverPending').mockImplementation(
      async function (this: InstanceType<typeof SessionNotificationDeliveryService>, input) {
        const result = await recover.call(this, input);
        if (input.sessionId === other.id) {
          recovered += result.dispatchableCount;
        }
        return result;
      }
    );
    const { SessionConfigService } = await vi.importActual<
      typeof import('@/backend/services/session/service/lifecycle/session.config.service')
    >('@/backend/services/session/service/lifecycle/session.config.service');
    const configure = SessionConfigService.prototype.configureQueuedMessage;
    const held = boundary();
    let complete: () => void = () => undefined;
    let beforeConfig = -1;
    let beforePrompt = -1;
    vi.spyOn(SessionConfigService.prototype, 'configureQueuedMessage').mockImplementation(function (
      this: InstanceType<typeof SessionConfigService>,
      id,
      ...args
    ) {
      if (id === other.id) {
        const provider = providers[1]!;
        const configuration = provider.handle.beginConfiguration();
        complete = () => configuration.complete();
        beforeConfig = provider.connection.setSessionConfigOption.mock.calls.length;
        beforePrompt = provider.connection.prompt.mock.calls.length;
        const pending = provider.handle.configurationReady;
        const read = vi
          .spyOn(provider.handle, 'configurationReady', 'get')
          .mockImplementation(() => {
            read.mockRestore();
            void held.wait();
            return pending;
          });
      }
      return configure.call(this, id, ...args);
    });
    const dispatch = h.session.sessionDispatchService.tryDispatchNextMessage.bind(
      h.session.sessionDispatchService
    );
    let queuedAfterDispatch: string | undefined;
    vi.spyOn(h.session.sessionDispatchService, 'tryDispatchNextMessage').mockImplementation(
      async (id, options) => {
        await dispatch(id, options);
        if (id === other.id) {
          queuedAfterDispatch = h.session.sessionDomainService.peekNextMessage(id)?.id;
        }
      }
    );
    const options = { assertCurrent: guard.check, assertCurrentSync: guard.assertCurrent };
    const starting = (
      entry === 'start'
        ? h.session.sessionLifecycleService.startSession(other.id, {
            ...options,
            initialPrompt: '',
          })
        : h.session.sessionLifecycleService.getOrCreateSessionClient(other.id, options)
    ).catch((error: unknown) => error);
    try {
      await held.entered;
      expect(recovered).toBeGreaterThan(0);
      expect(beforeConfig).toBeGreaterThanOrEqual(0);
      expect(beforePrompt).toBe(0);
      if (revoked) {
        h.session.sessionDomainService.enqueue(other.id, {
          id: 'new-human-input',
          timestamp: new Date().toISOString(),
          text: 'Keep my new input',
          settings: {
            selectedModel: null,
            reasoningEffort: null,
            thinkingEnabled: false,
            planModeEnabled: false,
          },
        });
        await strictStop();
        expect(
          await consumer.resolveAmbiguousRun({ ...(await context()), action: 'RETRY' })
        ).toMatchObject({ status: 'RETRIED' });
        await waitForProviders(3);
        await providers[2]!.called;
        expect((await h.read()).attempt.attemptGeneration).toBe(h.attempt.attemptGeneration + 1);
      }
    } finally {
      held.release();
      complete();
    }
    providers[1]!.response.resolve({ stopReason: 'end_turn' });
    const result = await starting;
    const provider = providers[1]!;
    if (revoked) {
      expect(provider.connection.setSessionConfigOption.mock.calls.length).toBe(beforeConfig);
      expect(provider.connection.prompt.mock.calls.length).toBe(beforePrompt);
      expect(queuedAfterDispatch).toBe('ordinary-input');
      expect(
        await db.prisma.workspaceNotification.findUnique({ where: { id: notification.id } })
      ).toMatchObject({ deliveredAt: null });
      expect(h.session.sessionDomainService.peekNextMessage(other.id)?.id).toBe('ordinary-input');
      expect(
        h.session.sessionDomainService.getQueueSnapshot(other.id).map((message) => message.id)
      ).toEqual([
        'ordinary-input',
        `workspace-mail-wake-${workspace.id}:${notification.revision}`,
        'new-human-input',
      ]);
      if (entry === 'start') {
        expect(result).toBeInstanceOf(Error);
      }
      expect(h.session.acpRuntimeManager.getClient(h.attempt.sessionId)).toBe(providers[2]!.handle);
    } else {
      expect(result).not.toBeInstanceOf(Error);
      expect(provider.connection.setSessionConfigOption.mock.calls.length).toBeGreaterThan(
        beforeConfig
      );
      expect(provider.connection.prompt.mock.calls.length).toBe(beforePrompt + 1);
      const sent = JSON.stringify(provider.connection.prompt.mock.calls.at(-1));
      expect(sent).toContain('You have workspace mail');
      expect(sent).not.toContain('Recovered update');
      expect(
        await db.prisma.workspaceNotification.findUnique({ where: { id: notification.id } })
      ).toMatchObject({ acknowledgedAt: null, deliveredAt: null });

      expect(queuedAfterDispatch).toBeUndefined();
      h.session.sessionDomainService.enqueue(other.id, {
        id: 'explicit-stop-input',
        timestamp: new Date().toISOString(),
        text: 'Cancel on explicit stop',
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      });
      await h.session.sessionLifecycleService.stopSession(other.id);
      expect(h.session.sessionDomainService.getQueueSnapshot(other.id)).toEqual([]);
    }
  }
);

it.each([true, false])(
  'carries retry authority through production queue auto-start projection, revoked=%s',
  async (revoked) => {
    await launch();
    providers[0]!.response.resolve({ stopReason: 'end_turn' });
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
    const { SessionContextService } = await vi.importActual<
      typeof import('@/backend/services/session/service/lifecycle/session-context.service')
    >('@/backend/services/session/service/lifecycle/session-context.service');
    const load = SessionContextService.prototype.load;
    const held = boundary();
    vi.spyOn(SessionContextService.prototype, 'load').mockImplementation(async function (
      this: InstanceType<typeof SessionContextService>,
      id,
      ...args
    ) {
      const source = await load.call(this, id, ...args);
      if (id === other.id) {
        await held.wait();
      }
      return source;
    });
    h.session.sessionDomainService.enqueue(other.id, {
      id: 'auto-start-input',
      text: 'Start ordinary session',
      timestamp: new Date().toISOString(),
      settings: {
        selectedModel: 'gpt-5.4',
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });
    const dispatch = h.session.sessionDispatchService
      .tryDispatchNextMessage(other.id, { guard })
      .catch((error: unknown) => error);
    try {
      await held.entered;
      if (revoked) {
        await strictStop();
        expect(
          await consumer.resolveAmbiguousRun({ ...(await context()), action: 'RETRY' })
        ).toMatchObject({ status: 'RETRIED' });
        await waitForProviders(2);
        await providers[1]!.called;
      }
    } finally {
      held.release();
    }
    if (!revoked) {
      await waitForProviders(2);
      providers[1]!.response.resolve({ stopReason: 'end_turn' });
    }
    await dispatch;
    expect(providers).toHaveLength(2);
    if (revoked) {
      expect(h.session.acpRuntimeManager.getClient(other.id)).toBeUndefined();
      expect(h.session.sessionDomainService.peekNextMessage(other.id)?.id).toBe('auto-start-input');
    } else {
      expect(providers[1]!.connection.prompt).toHaveBeenCalledOnce();
      expect(h.session.sessionDomainService.peekNextMessage(other.id)).toBeUndefined();
    }
  }
);

it.each([
  ['dispatch', true, false],
  ['dispatch', false, false],
  ['direct', true, false],
  ['direct', false, false],
  ['dispatch', true, true],
  ['direct', true, true],
  ['dispatch', true, 'inflight'],
  ['direct', true, 'inflight'],
] as const)(
  'restores a no-prompt runtime after %s retry send loses authority, revoked=%s replacement=%s',
  async (entry, revoked, replacement) => {
    await launch();
    providers[0]!.response.resolve({ stopReason: 'end_turn' });
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
    const provider = providers[1]!;
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
    const held = boundary();
    const send = h.session.acpRuntimeManager.sendPrompt.bind(h.session.acpRuntimeManager);
    vi.spyOn(h.session.acpRuntimeManager, 'sendPrompt').mockImplementation(
      (id, prompt, timeout, observation, caller) =>
        send(
          id,
          prompt,
          timeout,
          observation,
          id === other.id && caller
            ? {
                assertCurrent: caller.assertCurrent,
                check: async () => {
                  await caller.check();
                  await held.wait();
                  await caller.check();
                },
              }
            : caller
        )
    );
    h.session.sessionDomainService.enqueue(other.id, {
      id: 'fenced-input',
      text: 'Keep input',
      timestamp: new Date().toISOString(),
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });
    const dispatch = (
      entry === 'dispatch'
        ? h.session.sessionDispatchService.tryDispatchNextMessage(other.id, { guard })
        : h.session.sessionService.sendSessionMessage(other.id, 'Direct follow-up', guard)
    ).catch((error: unknown) => error);
    let independent: Awaited<ReturnType<typeof beginIndependentPrompt>> | undefined;
    try {
      await held.entered;
      expect(h.session.sessionDomainService.getRuntimeSnapshot(other.id)).toMatchObject({
        phase: 'running',
        activity: 'WORKING',
      });
      if (revoked) {
        await strictStop();
        expect(
          await consumer.resolveAmbiguousRun({ ...(await context()), action: 'RETRY' })
        ).toMatchObject({ status: 'RETRIED' });
        await waitForProviders(3);
        await providers[2]!.called;
        if (replacement) {
          independent = await beginIndependentPrompt(other.id, replacement);
        }
      }
    } finally {
      held.release();
      if (replacement !== 'inflight') {
        provider.response.resolve({ stopReason: 'end_turn' });
      }
    }
    await dispatch;
    if (independent) {
      const { provider: currentProvider, turn } = independent;
      expect(h.session.acpRuntimeManager.getClient(other.id)).toBe(currentProvider.handle);
      expect(h.session.sessionDomainService.getRuntimeSnapshot(other.id)).toMatchObject({
        phase: 'running',
        activity: 'WORKING',
        processState: 'alive',
      });
      expect(provider.connection.prompt).toHaveBeenCalledTimes(replacement === 'inflight' ? 1 : 0);
      currentProvider.response.resolve({ stopReason: 'end_turn' });
      await turn;
      return;
    }
    expect(h.session.sessionDomainService.getRuntimeSnapshot(other.id)).toMatchObject({
      phase: 'idle',
      activity: 'IDLE',
      processState: 'alive',
    });
    expect(provider.connection.prompt).toHaveBeenCalledTimes(revoked ? 0 : 1);
    expect(h.session.sessionDomainService.peekNextMessage(other.id)?.id).toBe(
      revoked || entry === 'direct' ? 'fenced-input' : undefined
    );
  }
);

it.each([
  ['head', true],
  ['head', false],
  ['batch', true],
  ['batch', false],
] as const)(
  'fences actual background preparation before %s queue removal, revoked=%s',
  async (position, revoked) => {
    await launch();
    providers[0]!.response.resolve({ stopReason: 'end_turn' });
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
    const { prBackgroundDeliveryPort } = await vi.importActual<
      typeof import('@/backend/orchestration/pr-event-delivery-port')
    >('@/backend/orchestration/pr-event-delivery-port');
    h.session.sessionBackgroundDeliveryService.configure(prBackgroundDeliveryPort);
    const held = boundary();
    const get = h.workspace.workspacePRMonitoringService.get.bind(
      h.workspace.workspacePRMonitoringService
    );
    vi.spyOn(h.workspace.workspacePRMonitoringService, 'get').mockImplementationOnce(async (id) => {
      const result = await get(id);
      await held.wait();
      return result;
    });
    if (position === 'batch') {
      h.session.sessionDomainService.enqueue(other.id, {
        id: 'human-before-background',
        text: 'Human',
        timestamp: new Date().toISOString(),
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      });
    }
    expect(
      h.session.sessionBackgroundDeliveryService.enqueue(other.id, {
        workspaceId: workspace.id,
        prId: 'missing-pr',
        bindingRevision: 1,
      })
    ).toMatchObject({ queued: true });
    const before = h.session.sessionDomainService.getQueueSnapshot(other.id);
    const dispatch = h.session.sessionDispatchService
      .tryDispatchNextMessage(other.id, { guard })
      .catch((error: unknown) => error);
    try {
      await held.entered;
      if (revoked) {
        await strictStop();
        expect(
          await consumer.resolveAmbiguousRun({ ...(await context()), action: 'RETRY' })
        ).toMatchObject({ status: 'RETRIED' });
        await waitForProviders(3);
        await providers[2]!.called;
      }
    } finally {
      held.release();
      providers[1]!.response.resolve({ stopReason: 'end_turn' });
    }
    await dispatch;
    expect(h.session.sessionDomainService.getQueueSnapshot(other.id)).toEqual(
      revoked ? before : []
    );
    expect(providers[1]!.connection.prompt).toHaveBeenCalledTimes(
      !revoked && position === 'batch' ? 1 : 0
    );
  }
);

it.each([true, false])(
  'carries captured authority into common startup initial prompt, revoked=%s',
  async (revoked) => {
    await launch();
    providers[0]!.response.resolve({ stopReason: 'end_turn' });
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
    if (!guard) {
      throw new Error('Missing guard');
    }
    const held = boundary();
    const send = h.session.sessionService.sendSessionMessage.bind(h.session.sessionService);
    vi.spyOn(h.session.sessionService, 'sendSessionMessage').mockImplementation(
      async (id, ...args) => {
        if (id === other.id) {
          await held.wait();
        }
        return send(id, ...args);
      }
    );
    const startup = h.session.sessionLifecycleService
      .startSession(other.id, {
        initialPrompt: 'Guard this common branch',
        assertCurrent: guard.check,
        assertCurrentSync: guard.assertCurrent,
      })
      .catch((error: unknown) => error);
    try {
      await held.entered;
      if (revoked) {
        await strictStop();
        expect(
          await consumer.resolveAmbiguousRun({ ...(await context()), action: 'RETRY' })
        ).toMatchObject({ status: 'RETRIED' });
        await waitForProviders(3);
        await providers[2]!.called;
      }
    } finally {
      held.release();
      providers[1]!.response.resolve({ stopReason: 'end_turn' });
    }
    const result = await startup;
    expect(providers[1]!.connection.prompt).toHaveBeenCalledTimes(revoked ? 0 : 1);
    if (revoked) {
      expect(result).toMatchObject({ name: 'WorkspaceInitFenceError' });
    }
  }
);

it.each([
  ['inner', 'head', true],
  ['inner', 'head', false],
  ['outer', 'head', true],
  ['outer', 'head', false],
  ['outer', 'batch', true],
  ['outer', 'batch', false],
] as const)(
  'releases exact PR claims at %s guard for %s dispatch, revoked=%s',
  async (edge, position, revoked) => {
    const { other, workspace, guard, port } = await readyRetryPRFixture();
    const held = boundary();
    let deliveryId: string | undefined;
    h.session.sessionBackgroundDeliveryService.configure({
      ...port,
      prepare: async (input) => {
        const result = await port.prepare(input);
        expect(result.status).toBe('ready');
        if (result.status !== 'ready') {
          throw new Error('Missing prepared claim');
        }
        deliveryId = result.delivery.deliveryId;
        if (edge === 'inner') {
          await held.wait();
        }
        return result;
      },
    });
    let published = false;
    const prepare = h.session.sessionBackgroundDeliveryService.prepare.bind(
      h.session.sessionBackgroundDeliveryService
    );
    vi.spyOn(h.session.sessionBackgroundDeliveryService, 'prepare').mockImplementation(
      async (...args) => {
        const result = await prepare(...args);
        if (result.status === 'ready') {
          deliveryId = result.delivery.deliveryId;
          published = edge === 'outer';
        }
        return result;
      }
    );
    const dispatchGuard = {
      ...guard,
      check: async () => {
        await guard.check();
        if (published) {
          published = false;
          await held.wait();
          await guard.check();
        }
      },
    };
    const addHuman = () =>
      h.session.sessionDomainService.enqueue(other.id, {
        id: 'human-with-prepared-claim',
        text: 'Retain human input',
        timestamp: '',
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      });
    if (position === 'batch') {
      addHuman();
    }
    providers[1]!.connection.setSessionConfigOption.mockClear();
    for (const prId of edge === 'inner' ? ['first', 'second'] : ['first']) {
      expect(
        h.session.sessionBackgroundDeliveryService.enqueue(other.id, {
          workspaceId: workspace.id,
          prId,
          bindingRevision: 1,
        })
      ).toMatchObject({ queued: true });
    }
    let before = structuredClone(h.session.sessionDomainService.getQueueSnapshot(other.id));
    const dispatch = h.session.sessionDispatchService
      .tryDispatchNextMessage(other.id, { guard: dispatchGuard })
      .catch((error: unknown) => error);
    try {
      await held.entered;
      if (edge === 'outer') {
        expect(deliveryId).toBeDefined();
        expect(h.session.sessionBackgroundDeliveryService.isDeliveryActive(deliveryId!)).toBe(true);
        if (revoked && position === 'head') {
          addHuman();
        }
        before = structuredClone(h.session.sessionDomainService.getQueueSnapshot(other.id));
      }
      expect(
        await db.prisma.workspacePREvent.count({
          where: { workspaceId: workspace.id, batch: { state: 'DISPATCHING' } },
        })
      ).toBe(2);
      if (revoked) {
        await strictStop();
        expect(
          await consumer.resolveAmbiguousRun({ ...(await context()), action: 'RETRY' })
        ).toMatchObject({ status: 'RETRIED' });
        await waitForProviders(3);
        await providers[2]!.called;
      }
    } finally {
      held.release();
      providers[1]!.response.resolve({ stopReason: 'end_turn' });
    }
    await dispatch;
    if (!deliveryId) {
      throw new Error('Missing captured prepared delivery ID');
    }
    expect(h.session.sessionBackgroundDeliveryService.isDeliveryActive(deliveryId)).toBe(false);
    if (revoked) {
      expect(providers[1]!.connection.setSessionConfigOption).not.toHaveBeenCalled();
    }
    expect(h.session.sessionDomainService.getQueueSnapshot(other.id)).toEqual(
      revoked ? before : []
    );
    expect(providers[1]!.connection.prompt).toHaveBeenCalledTimes(revoked ? 0 : 1);
    expect(
      await db.prisma.workspacePREvent.count({
        where: { workspaceId: workspace.id, batch: { state: 'DISPATCHING' } },
      })
    ).toBe(0);
    expect(
      await db.prisma.workspacePREvent.count({
        where: { workspaceId: workspace.id, batch: { state: revoked ? 'PENDING' : 'DELIVERED' } },
      })
    ).toBe(2);
  }
);
