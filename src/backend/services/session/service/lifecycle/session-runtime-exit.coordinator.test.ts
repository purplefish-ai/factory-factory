import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStatus } from '@/shared/core';
import { createLifecycleTestSession } from './session-lifecycle.test-helpers';
import { SessionRuntimeExitCoordinator } from './session-runtime-exit.coordinator';

const { mockTraceLog, mockTraceClose } = vi.hoisted(() => ({
  mockTraceLog: vi.fn(),
  mockTraceClose: vi.fn(),
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getCurrentProcessEnv: () => ({ NODE_ENV: 'test' }),
}));

vi.mock('@/backend/services/session/service/logging/acp-trace-logger.service', () => ({
  acpTraceLogger: {
    log: mockTraceLog,
    closeSession: mockTraceClose,
  },
}));

type ExitCoordinatorHarness = ReturnType<typeof createExitCoordinatorHarness>;

function createExitCoordinatorHarness(options?: { browse?: boolean; lifecycleStopping?: boolean }) {
  const session = createLifecycleTestSession();
  const repository = {
    getSessionById: vi.fn(async () => session),
    updateSession: vi.fn(async () => session),
  };
  const domain = {
    markError: vi.fn(),
    markProcessExit: vi.fn(),
  };
  const permission = {
    cancelPendingRequests: vi.fn(),
  };
  const processorHandlers = {
    onAcpEvent: vi.fn(),
  };
  const processor = {
    createRuntimeEventHandler: vi.fn(() => processorHandlers),
    clearSessionState: vi.fn(),
    finalizeOrphanedToolCalls: vi.fn(),
    clearPendingToolCalls: vi.fn(),
    handleAcpLog: vi.fn(),
  };
  const promptCompletion = {
    clearSession: vi.fn(),
  };
  const lifecycleEvents = {
    record: vi.fn(async () => null),
  };
  const lifecycleGate = {
    isSessionStopping: vi.fn(() => options?.lifecycleStopping ?? false),
    releaseShutdown: vi.fn(),
  };
  const workflowFinalizer = {
    finalizeRuntimeExit: vi.fn(async () => undefined),
    clearInactiveSession: vi.fn(),
  };
  const onSessionExit = vi.fn();
  const coordinator = new SessionRuntimeExitCoordinator({
    repository,
    sessionDomainService: domain,
    sessionPermissionService: permission,
    acpEventProcessor: processor,
    promptTurnCompletionService: promptCompletion,
    lifecycleEventService: lifecycleEvents,
    lifecycleGate,
    workflowFinalizer,
    onSessionExit,
  });
  const purpose = options?.browse ? ('browse' as const) : ('active' as const);
  const handlers = coordinator.createHandlers({
    sessionId: 'session-1',
    purpose,
    persistProviderSessionId: !options?.browse,
  });

  return {
    coordinator,
    handlers,
    repository,
    domain,
    permission,
    processor,
    processorHandlers,
    promptCompletion,
    lifecycleEvents,
    lifecycleGate,
    workflowFinalizer,
    onSessionExit,
    session,
  };
}

function runtimeExit(
  overrides: Partial<{
    exitCode: number | null;
    incarnationId: string;
    purpose: 'active' | 'browse';
    managed: boolean;
  }> = {}
) {
  return {
    sessionId: 'session-1',
    exitCode: 1,
    incarnationId: '11111111-1111-4111-8111-111111111111',
    purpose: 'active' as const,
    managed: false,
    ...overrides,
  };
}

describe('SessionRuntimeExitCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates ACP handlers and persists provider session identity for active runtimes', async () => {
    const harness = createExitCoordinatorHarness();

    await harness.handlers.onSessionId?.('session-1', 'provider-session-9');

    expect(harness.processor.createRuntimeEventHandler).toHaveBeenCalledWith('session-1');
    expect(harness.handlers.onAcpEvent).toBe(harness.processorHandlers.onAcpEvent);
    expect(harness.repository.updateSession).toHaveBeenCalledWith('session-1', {
      providerSessionId: 'provider-session-9',
    });
    expect(mockTraceLog).toHaveBeenCalledWith('session-1', 'runtime_metadata', {
      type: 'provider_session_id',
      providerSessionId: 'provider-session-9',
    });
  });

  it('omits provider session persistence for browse runtimes', () => {
    const harness = createExitCoordinatorHarness({ browse: true });

    expect(harness.handlers.onSessionId).toBeUndefined();
  });

  it('public handleExit cleans up a browse exit without finalizing the active session', async () => {
    const harness = createExitCoordinatorHarness({ browse: true });

    await harness.coordinator.handleExit(runtimeExit({ purpose: 'browse' }));

    expect(harness.lifecycleGate.releaseShutdown).toHaveBeenCalledWith('session-1');
    expect(harness.processor.clearSessionState).toHaveBeenCalledWith('session-1');
    expect(mockTraceClose).toHaveBeenCalledWith('session-1');
    expect(harness.domain.markProcessExit).not.toHaveBeenCalled();
    expect(harness.repository.getSessionById).not.toHaveBeenCalled();
    expect(harness.workflowFinalizer.finalizeRuntimeExit).not.toHaveBeenCalled();
  });

  it('records runtime errors only for active runtimes', () => {
    const active = createExitCoordinatorHarness();
    const browse = createExitCoordinatorHarness({ browse: true });
    const runtimeError = new Error('provider transport failed');

    active.handlers.onError?.('session-1', runtimeError);
    browse.handlers.onError?.('session-1', runtimeError);

    expect(active.domain.markError).toHaveBeenCalledWith('session-1', 'provider transport failed');
    expect(browse.domain.markError).not.toHaveBeenCalled();
    expect(mockTraceLog).toHaveBeenCalledWith(
      'session-1',
      'runtime_error',
      expect.objectContaining({ message: 'provider transport failed' })
    );
  });

  it('uses typed runtime error purpose instead of handler creation purpose', () => {
    const harness = createExitCoordinatorHarness({ browse: true });
    const runtimeError = new Error('promoted runtime failed');

    harness.handlers.onRuntimeError?.({
      sessionId: 'session-1',
      error: runtimeError,
      incarnationId: '11111111-1111-4111-8111-111111111111',
      purpose: 'active',
    });

    expect(harness.domain.markError).toHaveBeenCalledWith('session-1', 'promoted runtime failed');
  });

  it('records the process-exit snapshot and successful persisted status', async () => {
    const harness = createExitCoordinatorHarness();

    await harness.coordinator.handleExit(runtimeExit({ exitCode: 0 }));

    expect(harness.domain.markProcessExit).toHaveBeenCalledWith('session-1', 0);
    expect(harness.repository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.COMPLETED,
    });
  });

  it('continues durable exit effects after the persisted status update fails', async () => {
    const harness = createExitCoordinatorHarness();
    harness.repository.updateSession.mockRejectedValueOnce(new Error('database write failed'));

    await harness.coordinator.handleExit(runtimeExit());

    expect(harness.lifecycleEvents.record).toHaveBeenCalledOnce();
    expect(harness.workflowFinalizer.finalizeRuntimeExit).toHaveBeenCalledOnce();
  });

  it('continues workflow finalization when unexpected-exit history fails', async () => {
    const harness = createExitCoordinatorHarness();
    harness.lifecycleEvents.record.mockRejectedValueOnce(new Error('history write failed'));

    await harness.coordinator.handleExit(runtimeExit());

    expect(harness.workflowFinalizer.finalizeRuntimeExit).toHaveBeenCalledOnce();
  });

  it.each([
    [1, 'Session stopped: agent process exited unexpectedly (code 1).', '1'],
    [null, 'Session stopped: agent process exited unexpectedly.', 'signal'],
  ] as const)('records unmanaged exit code %s with an incarnation-scoped dedupe key', async (exitCode, message, dedupeSuffix) => {
    const harness = createExitCoordinatorHarness();

    await harness.coordinator.handleExit(runtimeExit({ exitCode }));

    expect(harness.lifecycleEvents.record).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      kind: 'SESSION_STOPPED',
      reason: 'UNEXPECTED_EXIT',
      message,
      dedupeKey: `process-exit:11111111-1111-4111-8111-111111111111:${dedupeSuffix}`,
    });
  });

  it.each([
    ['runtime-managed', { managed: true }, false],
    ['lifecycle-deliberate', {}, true],
  ] as const)('preserves idle status for %s deliberate exits', async (_caseName, eventOverrides, lifecycleStopping) => {
    const harness = createExitCoordinatorHarness({ lifecycleStopping });

    await harness.coordinator.handleExit(runtimeExit({ ...eventOverrides, exitCode: null }));

    expect(harness.repository.updateSession).not.toHaveBeenCalled();
    expect(harness.lifecycleEvents.record).not.toHaveBeenCalled();
    expect(harness.workflowFinalizer.finalizeRuntimeExit).toHaveBeenCalledWith(
      expect.objectContaining({ deliberate: true })
    );
  });

  it('prepares active runtime state and delegates workflow-specific exit effects', async () => {
    const harness = createExitCoordinatorHarness({ lifecycleStopping: true });

    await harness.coordinator.handleExit(runtimeExit());

    expect(harness.promptCompletion.clearSession).toHaveBeenCalledWith('session-1');
    expect(harness.onSessionExit).toHaveBeenCalledWith('session-1');
    expect(harness.processor.finalizeOrphanedToolCalls).toHaveBeenCalledWith(
      'session-1',
      'runtime_exit'
    );
    expect(harness.processor.clearSessionState).toHaveBeenCalledWith('session-1');
    expect(harness.permission.cancelPendingRequests).toHaveBeenCalledWith('session-1');
    expect(mockTraceLog).toHaveBeenCalledWith('session-1', 'runtime_exit', { exitCode: 1 });
    expect(harness.workflowFinalizer.finalizeRuntimeExit).toHaveBeenCalledWith({
      session: harness.session,
      sessionId: 'session-1',
      exitCode: 1,
      deliberate: true,
    });
  });

  it('continues cleanup when the session-exit callback fails', async () => {
    const harness = createExitCoordinatorHarness();
    harness.onSessionExit.mockImplementationOnce(() => {
      throw new Error('queue cleanup failed');
    });

    await harness.coordinator.handleExit(runtimeExit());

    expect(harness.processor.finalizeOrphanedToolCalls).toHaveBeenCalledWith(
      'session-1',
      'runtime_exit'
    );
    expect(harness.processor.clearSessionState).toHaveBeenCalledWith('session-1');
    expect(harness.permission.cancelPendingRequests).toHaveBeenCalledWith('session-1');
    expect(harness.repository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.FAILED,
    });
    expect(harness.workflowFinalizer.finalizeRuntimeExit).toHaveBeenCalledOnce();
  });

  it('closes the trace without active finalization when browse cleanup fails', async () => {
    const harness = createExitCoordinatorHarness({ browse: true });
    harness.processor.clearSessionState.mockImplementationOnce(() => {
      throw new Error('browse cleanup failed');
    });

    await expect(
      harness.coordinator.handleExit(runtimeExit({ purpose: 'browse' }))
    ).rejects.toThrow('browse cleanup failed');

    expect(mockTraceClose).toHaveBeenCalledWith('session-1');
    expect(harness.domain.markProcessExit).not.toHaveBeenCalled();
    expect(harness.workflowFinalizer.finalizeRuntimeExit).not.toHaveBeenCalled();
  });

  it('closes the trace without finalization when active preparation fails', async () => {
    const harness = createExitCoordinatorHarness();
    harness.promptCompletion.clearSession.mockImplementationOnce(() => {
      throw new Error('active preparation failed');
    });

    await expect(harness.coordinator.handleExit(runtimeExit())).rejects.toThrow(
      'active preparation failed'
    );

    expect(mockTraceClose).toHaveBeenCalledWith('session-1');
    expect(harness.domain.markProcessExit).not.toHaveBeenCalled();
    expect(harness.workflowFinalizer.finalizeRuntimeExit).not.toHaveBeenCalled();
  });

  it('closes the trace in finally when inactive cleanup fails', async () => {
    const harness: ExitCoordinatorHarness = createExitCoordinatorHarness();
    harness.workflowFinalizer.clearInactiveSession.mockImplementationOnce(() => {
      throw new Error('inactive cleanup failed');
    });

    await expect(harness.coordinator.handleExit(runtimeExit())).rejects.toThrow(
      'inactive cleanup failed'
    );

    expect(mockTraceClose).toHaveBeenCalledWith('session-1');
  });
});
