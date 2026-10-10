import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionLifecycleEventRecord } from '@/backend/services/session/resources/session-lifecycle-event.accessor';
import { AcpRuntimeQuiescence } from '@/backend/services/session/service/acp/acp-runtime-quiescence';
import { acpTraceLogger } from '@/backend/services/session/service/logging/acp-trace-logger.service';
import { createDeferred, createTerminationHarness } from './session-lifecycle.test-helpers';
import { SessionTerminationCoordinator } from './session-termination.coordinator';

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => logger,
  getCurrentProcessEnv: () => ({ NODE_ENV: 'test' }),
}));

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: { findById: vi.fn() },
  workspaceNotificationService: {
    listPendingForDelivery: vi.fn(),
    markDelivered: vi.fn(),
  },
}));

vi.mock('@/backend/services/settings', () => ({
  userSettingsService: {
    get: vi.fn(async () => ({
      defaultWorkspacePermissions: 'STRICT',
      ratchetPermissions: 'YOLO',
    })),
  },
}));

function createShutdownHarness(
  sessionIds = ['session-active', 'session-pending', 'session-fenced', 'session-browse-only']
) {
  const base = createTerminationHarness();
  const runtimeManager = {
    ...base.runtimeManager,
    beginShutdown: vi.fn(() => sessionIds),
    stopAllClients: vi.fn(async () => undefined),
  };
  const promptTurnCompletionService = {
    ...base.promptTurnCompletionService,
    clearAll: vi.fn(),
  };
  const coordinator = new SessionTerminationCoordinator({
    repository: base.repository,
    retryService: base.retryService,
    runtimeManager,
    sessionDomainService: base.sessionDomainService,
    sessionPermissionService: base.sessionPermissionService,
    acpEventProcessor: base.acpEventProcessor,
    promptTurnCompletionService,
    lifecycleEventService: base.lifecycleEventService,
    lifecycleGate: base.lifecycleGate,
    workflowFinalizer: base.workflowFinalizer,
    getRuntimeSnapshot: base.getRuntimeSnapshot,
  });
  coordinator.configure({ workspace: base.workspaceBridge });

  return { ...base, coordinator, runtimeManager, promptTurnCompletionService };
}

describe('SessionTerminationCoordinator workspace stops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructs the public coordinator directly through the narrow harness', () => {
    expect(createTerminationHarness().coordinator).toBeInstanceOf(SessionTerminationCoordinator);
  });

  it('stops persisted, runtime-owned, and active-creation sessions', async () => {
    const { coordinator, repository, runtimeManager, lifecycleEventService } =
      createTerminationHarness();
    runtimeManager.hasClientCreationOperation.mockImplementation(
      (sessionId) => sessionId === 'session-idle'
    );

    await coordinator.stopWorkspaceSessions('workspace-1');

    expect(repository.getSessionsByWorkspaceId).toHaveBeenCalledWith('workspace-1');
    expect(runtimeManager.isSessionRunning).toHaveBeenCalledWith('session-runtime-only');
    expect(runtimeManager.isSessionRunning).toHaveBeenCalledWith('session-idle');
    expect(runtimeManager.stopAndQuiesce).toHaveBeenCalledWith('session-running');
    expect(runtimeManager.stopAndQuiesce).toHaveBeenCalledWith('session-runtime-only');
    expect(runtimeManager.stopAndQuiesce).toHaveBeenCalledWith('session-browse-only');
    expect(runtimeManager.stopAndQuiesce).toHaveBeenCalledWith('session-idle');
    expect(lifecycleEventService.record).toHaveBeenCalledTimes(3);
    expect(lifecycleEventService.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-browse-only' })
    );
  });

  it('attempts every eligible persisted and runtime-owned session and aggregates failures', async () => {
    const { coordinator, lifecycleEventService, runtimeManager } = createTerminationHarness();
    lifecycleEventService.record.mockImplementation(({ sessionId }) => {
      if (sessionId === 'session-running' || sessionId === 'session-runtime-only') {
        return Promise.reject(new Error(`stop failed: ${sessionId}`));
      }
      return Promise.resolve(null);
    });

    await expect(coordinator.stopWorkspaceSessions('workspace-1')).rejects.toThrow(
      'Failed to stop 2 workspace sessions'
    );
    expect(runtimeManager.stopAndQuiesce).not.toHaveBeenCalledWith('session-running');
    expect(runtimeManager.stopAndQuiesce).not.toHaveBeenCalledWith('session-runtime-only');
    expect(runtimeManager.stopAndQuiesce).toHaveBeenCalledWith('session-browse-only');
    expect(runtimeManager.stopAndQuiesce).not.toHaveBeenCalledWith('session-idle');
  });
});

describe('SessionTerminationCoordinator stop causes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['USER_STOP', 'Session stopped by you.'],
    ['SESSION_CLOSED', 'Session closed by you.'],
    ['WORKSPACE_ARCHIVED', 'Session stopped because the workspace was archived.'],
    ['SYSTEM_STOP', 'Session stopped by the system.'],
  ] as const)('records %s before stopping the runtime', async (reason, message) => {
    const { coordinator, lifecycleEventService, runtimeManager } = createTerminationHarness();

    await coordinator.stopSession('session-1', { reason });

    expect(lifecycleEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        kind: 'SESSION_STOPPED',
        reason,
        message,
        dedupeKey: expect.stringMatching(
          /^session-stop:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ),
      })
    );
    expect(lifecycleEventService.record.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeManager.stopAndQuiesce.mock.invocationCallOrder[0]!
    );
  });

  it('uses a new durable stop identity after lifecycle-service reconstruction', async () => {
    const first = createTerminationHarness();
    const reconstructed = createTerminationHarness();

    await first.coordinator.stopSession('session-1', { reason: 'USER_STOP' });
    await reconstructed.coordinator.stopSession('session-1', { reason: 'USER_STOP' });

    const firstKey = first.lifecycleEventService.record.mock.calls[0]?.[0]?.dedupeKey;
    const reconstructedKey =
      reconstructed.lifecycleEventService.record.mock.calls[0]?.[0]?.dedupeKey;
    expect(firstKey).toMatch(/^session-stop:/);
    expect(reconstructedKey).toMatch(/^session-stop:/);
    expect(reconstructedKey).not.toBe(firstKey);
  });

  it('can clean up a failed startup without recording a stop event', async () => {
    const { coordinator, lifecycleEventService, runtimeManager } = createTerminationHarness();

    await coordinator.stopSession('session-1', { recordLifecycleEvent: false });

    expect(lifecycleEventService.record).not.toHaveBeenCalled();
    expect(runtimeManager.stopAndQuiesce).toHaveBeenCalledWith('session-1');
  });

  it('uses the facade-owned runtime snapshot when entering stopping state', async () => {
    const harness = createTerminationHarness();
    harness.getRuntimeSnapshot.mockReturnValue({
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
      updatedAt: '2026-08-14T12:00:00.000Z',
    });

    await harness.coordinator.stopSession('session-1');

    expect(harness.getRuntimeSnapshot).toHaveBeenCalledWith('session-1');
    expect(harness.sessionDomainService.setRuntimeSnapshot).toHaveBeenNthCalledWith(
      1,
      'session-1',
      {
        phase: 'stopping',
        processState: 'alive',
        activity: 'IDLE',
        updatedAt: expect.any(String),
      }
    );
  });
});

describe('SessionTerminationCoordinator graceful shutdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes admission and reserves non-browse sessions before awaiting durable stop events', async () => {
    const event = createDeferred<null>();
    const effects: string[] = [];
    const harness = createShutdownHarness();
    harness.promptTurnCompletionService.clearAll.mockImplementation(() => {
      effects.push('clear-prompts');
    });
    harness.runtimeManager.beginShutdown.mockImplementation(() => {
      effects.push('close-admission');
      return ['session-active', 'session-pending', 'session-fenced', 'session-browse-only'];
    });
    harness.lifecycleEventService.record.mockImplementation(({ sessionId }) => {
      effects.push(`record:${sessionId}`);
      return event.promise;
    });

    const shutdown = harness.coordinator.stopAllClients(4321);
    await vi.waitFor(() => {
      expect(harness.lifecycleEventService.record).toHaveBeenCalledTimes(3);
    });

    expect(effects.slice(0, 2)).toEqual(['clear-prompts', 'close-admission']);
    expect(harness.lifecycleGate.isSessionStopping('session-active')).toBe(true);
    expect(harness.lifecycleGate.isSessionStopping('session-pending')).toBe(true);
    expect(harness.lifecycleGate.isSessionStopping('session-fenced')).toBe(true);
    expect(harness.lifecycleGate.isSessionStopping('session-browse-only')).toBe(false);
    expect(harness.lifecycleEventService.record.mock.calls.map(([input]) => input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: 'session-active', reason: 'SYSTEM_STOP' }),
        expect.objectContaining({ sessionId: 'session-pending', reason: 'SYSTEM_STOP' }),
        expect.objectContaining({ sessionId: 'session-fenced', reason: 'SYSTEM_STOP' }),
      ])
    );
    expect(harness.lifecycleEventService.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-browse-only' })
    );
    expect(harness.runtimeManager.stopAllClients).not.toHaveBeenCalled();

    event.resolve(null);
    await shutdown;

    expect(harness.runtimeManager.stopAllClients).toHaveBeenCalledWith(4321);
  });

  it.each([
    [true, 'event'],
    [true, 'quiescence'],
    [false, 'quiescence'],
  ] as const)(
    'records one stop when shutdown overlaps recording=%s at %s',
    async (recordLifecycleEvent, boundary) => {
      const harness = createShutdownHarness(['session-1']);
      const pendingEvent = createDeferred<SessionLifecycleEventRecord | null>();
      const pendingStop = createDeferred<undefined>();
      if (boundary === 'event') {
        harness.lifecycleEventService.record.mockReturnValueOnce(pendingEvent.promise);
      }
      harness.runtimeManager.stopAndQuiesce.mockReturnValueOnce(pendingStop.promise);
      const stop = harness.coordinator.stopSession('session-1', {
        reason: 'USER_STOP',
        recordLifecycleEvent,
      });
      await vi.waitFor(() => {
        if (boundary === 'event') {
          expect(harness.lifecycleEventService.record).toHaveBeenCalledOnce();
        } else {
          expect(harness.runtimeManager.stopAndQuiesce).toHaveBeenCalledOnce();
        }
      });

      const shutdown = harness.coordinator.stopAllClients();
      if (boundary === 'event') {
        expect(harness.runtimeManager.stopAllClients).not.toHaveBeenCalled();
        const input = harness.lifecycleEventService.record.mock.calls[0]?.[0];
        if (!input) {
          throw new Error('Expected a pending stop event');
        }
        pendingEvent.resolve({ ...input, id: 'stop-event', createdAt: new Date() });
      }
      await shutdown;

      expect(harness.lifecycleEventService.record).toHaveBeenCalledOnce();
      expect(harness.lifecycleEventService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          reason: recordLifecycleEvent ? 'USER_STOP' : 'SYSTEM_STOP',
        })
      );
      expect(harness.lifecycleGate.isStopReserved('session-1')).toBe(true);
      expect(harness.lifecycleGate.isBulkShutdownReserved('session-1')).toBe(false);
      pendingStop.resolve(undefined);
      await stop;
      expect(harness.lifecycleEventService.record).toHaveBeenCalledOnce();
      expect(harness.lifecycleGate.isSessionStopping('session-1')).toBe(false);
    }
  );

  it('waits for a pending durable explicit stop write before shutting down without a duplicate', async () => {
    vi.useFakeTimers();
    const harness = createShutdownHarness(['session-1']);
    const pendingEvent = createDeferred<SessionLifecycleEventRecord | null>();
    const pendingStop = createDeferred<undefined>();
    harness.lifecycleEventService.record.mockReturnValueOnce(pendingEvent.promise);
    harness.runtimeManager.stopAndQuiesce.mockReturnValueOnce(pendingStop.promise);
    const stop = harness.coordinator.stopSession('session-1', { reason: 'USER_STOP' });
    try {
      await vi.advanceTimersByTimeAsync(0);
      const shutdown = harness.coordinator.stopAllClients();
      await vi.advanceTimersByTimeAsync(100);
      expect(harness.runtimeManager.stopAllClients).not.toHaveBeenCalled();
      const input = harness.lifecycleEventService.record.mock.calls[0]?.[0];
      if (!input) {
        throw new Error('Expected a pending stop event');
      }
      pendingEvent.resolve({ ...input, id: 'stop-event', createdAt: new Date() });
      await shutdown;
      expect(harness.lifecycleEventService.record).toHaveBeenCalledOnce();
      expect(harness.runtimeManager.stopAllClients).toHaveBeenCalledOnce();
    } finally {
      pendingEvent.resolve(null);
      pendingStop.resolve(undefined);
      await stop;
      vi.useRealTimers();
    }
  });

  it('retries the same stop event during shutdown after explicit persistence returns null', async () => {
    const harness = createShutdownHarness(['session-1']);
    const pendingStop = createDeferred<undefined>();
    harness.runtimeManager.stopAndQuiesce.mockReturnValueOnce(pendingStop.promise);
    harness.lifecycleEventService.record.mockResolvedValueOnce(null);
    const stop = harness.coordinator.stopSession('session-1', { reason: 'USER_STOP' });
    await vi.waitFor(() => expect(harness.runtimeManager.stopAndQuiesce).toHaveBeenCalledOnce());
    const input = harness.lifecycleEventService.record.mock.calls[0]?.[0];

    await harness.coordinator.stopAllClients();

    expect(harness.lifecycleEventService.record).toHaveBeenCalledTimes(2);
    expect(harness.lifecycleEventService.record).toHaveBeenNthCalledWith(2, input);
    pendingStop.resolve(undefined);
    await stop;
  });

  it('retries failed pending stop persistence even after shutdown recording times out', async () => {
    vi.useFakeTimers();
    const harness = createShutdownHarness(['session-1']);
    const pendingEvent = createDeferred<null>();
    const pendingStop = createDeferred<undefined>();
    harness.lifecycleEventService.record.mockReturnValueOnce(pendingEvent.promise);
    harness.runtimeManager.stopAndQuiesce.mockReturnValueOnce(pendingStop.promise);
    const stop = harness.coordinator.stopSession('session-1', { reason: 'USER_STOP' });
    try {
      await vi.advanceTimersByTimeAsync(0);
      const input = harness.lifecycleEventService.record.mock.calls[0]?.[0];
      const shutdown = harness.coordinator.stopAllClients();
      await vi.advanceTimersByTimeAsync(1000);
      await shutdown;
      expect(harness.lifecycleEventService.record).toHaveBeenCalledOnce();

      pendingEvent.resolve(null);
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.lifecycleEventService.record).toHaveBeenCalledTimes(2);
      expect(harness.lifecycleEventService.record).toHaveBeenNthCalledWith(2, input);
      expect(harness.lifecycleGate.isBulkShutdownReserved('session-1')).toBe(false);
    } finally {
      pendingEvent.resolve(null);
      pendingStop.resolve(undefined);
      await stop;
      vi.useRealTimers();
    }
  });

  it('logs lifecycle recording failures independently and still shuts down the runtime', async () => {
    const harness = createShutdownHarness(['session-active', 'session-fenced']);
    harness.lifecycleEventService.record.mockImplementation(({ sessionId }) =>
      Promise.reject(
        new Error(sessionId === 'session-active' ? 'active event failed' : 'fenced event failed')
      )
    );

    await expect(harness.coordinator.stopAllClients()).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      'Failed recording shutdown lifecycle event; continuing shutdown',
      { sessionId: 'session-active', error: 'active event failed' }
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed recording shutdown lifecycle event; continuing shutdown',
      { sessionId: 'session-fenced', error: 'fenced event failed' }
    );
    expect(harness.runtimeManager.stopAllClients).toHaveBeenCalledWith(5000);
    expect(harness.lifecycleGate.isSessionStopping('session-active')).toBe(false);
    expect(harness.lifecycleGate.isSessionStopping('session-fenced')).toBe(false);
  });

  it('releases reservations if shutdown lifecycle error reporting fails', async () => {
    const recordingFailure = new Error('lifecycle error reporting failed');
    const harness = createShutdownHarness(['session-active', 'session-pending']);
    harness.lifecycleEventService.record.mockRejectedValue(new Error('event failed'));
    logger.warn.mockImplementationOnce(() => {
      throw recordingFailure;
    });

    await expect(harness.coordinator.stopAllClients()).rejects.toBe(recordingFailure);

    expect(harness.runtimeManager.stopAllClients).not.toHaveBeenCalled();
    expect(harness.lifecycleGate.isSessionStopping('session-active')).toBe(false);
    expect(harness.lifecycleGate.isSessionStopping('session-pending')).toBe(false);
  });

  it('holds reservations while runtime shutdown is pending and releases them on success', async () => {
    const runtimeStop = createDeferred<undefined>();
    const harness = createShutdownHarness();
    const browseGeneration = harness.lifecycleGate.getGeneration('session-browse-only');
    harness.runtimeManager.stopAllClients.mockReturnValue(runtimeStop.promise);
    const shutdown = harness.coordinator.stopAllClients();
    await vi.waitFor(() => expect(harness.runtimeManager.stopAllClients).toHaveBeenCalled());
    expect(harness.lifecycleGate.isSessionStopping('session-active')).toBe(true);
    expect(harness.lifecycleGate.isSessionStopping('session-browse-only')).toBe(false);

    runtimeStop.resolve(undefined);
    await shutdown;

    expect(harness.lifecycleGate.isSessionStopping('session-active')).toBe(false);
    expect(harness.lifecycleGate.isSessionStopping('session-pending')).toBe(false);
    expect(harness.lifecycleGate.isSessionStopping('session-fenced')).toBe(false);
    expect(harness.lifecycleGate.isGenerationCurrent('session-browse-only', browseGeneration)).toBe(
      true
    );
  });

  it('clears the one-second lifecycle recording timeout after early completion', async () => {
    vi.useFakeTimers();
    try {
      const harness = createShutdownHarness(['session-active']);

      await harness.coordinator.stopAllClients();

      expect(vi.getTimerCount()).toBe(0);
      expect(harness.runtimeManager.stopAllClients).toHaveBeenCalledWith(5000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues runtime shutdown when lifecycle recording reaches one second', async () => {
    vi.useFakeTimers();
    try {
      const harness = createShutdownHarness(['session-active']);
      harness.lifecycleEventService.record.mockReturnValue(new Promise(() => undefined));

      const shutdown = harness.coordinator.stopAllClients(4321);
      await vi.advanceTimersByTimeAsync(999);
      expect(harness.runtimeManager.stopAllClients).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await shutdown;

      expect(logger.warn).toHaveBeenCalledWith(
        'Timed out recording shutdown lifecycle events; continuing shutdown',
        { timeoutMs: 1000 }
      );
      expect(harness.runtimeManager.stopAllClients).toHaveBeenCalledWith(4321);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards the caller timeout and propagates runtime shutdown rejection after logging', async () => {
    const runtimeFailure = new Error('runtime shutdown failed');
    const harness = createShutdownHarness();
    harness.runtimeManager.stopAllClients.mockRejectedValue(runtimeFailure);

    await expect(harness.coordinator.stopAllClients(8765)).rejects.toBe(runtimeFailure);

    expect(harness.runtimeManager.stopAllClients).toHaveBeenCalledWith(8765);
    expect(logger.error).toHaveBeenCalledWith('Failed to stop ACP clients during shutdown', {
      error: runtimeFailure.message,
    });
    for (const sessionId of ['session-active', 'session-pending', 'session-fenced']) {
      expect(harness.lifecycleGate.isSessionStopping(sessionId)).toBe(false);
      const stop = harness.lifecycleGate.reserveStop(sessionId);
      expect(stop).not.toBeNull();
      stop?.release();
    }
    expect(harness.lifecycleGate.isSessionStopping('session-browse-only')).toBe(false);
  });
});

describe('SessionTerminationCoordinator races', () => {
  it('reserves the stop synchronously before loading the session', async () => {
    const effects: string[] = [];
    const harness = createTerminationHarness({
      getSessionById: () => {
        effects.push('load-session');
        return Promise.resolve(harness.session);
      },
    });
    const originalReserveStop = harness.lifecycleGate.reserveStop.bind(harness.lifecycleGate);
    vi.spyOn(harness.lifecycleGate, 'reserveStop').mockImplementation((...args) => {
      effects.push('reserve-stop');
      return originalReserveStop(...args);
    });

    const stop = harness.coordinator.stopSession('session-1');

    expect(effects.indexOf('reserve-stop')).toBe(0);
    expect(effects.indexOf('reserve-stop')).toBeLessThan(effects.indexOf('load-session'));
    await stop;
  });

  it('waits for the durable event to complete before runtime quiescence begins', async () => {
    const effects: string[] = [];
    const harness = createTerminationHarness();
    const durableEvent = createDeferred<null>();
    harness.lifecycleEventService.record.mockImplementation(async () => {
      await durableEvent.promise;
      effects.push('durable-event-complete');
      return null;
    });
    harness.runtimeManager.stopAndQuiesce.mockImplementation(() => {
      effects.push('runtime-stop');
      return Promise.resolve();
    });

    const stop = harness.coordinator.stopSession('session-1');
    await vi.waitFor(() => {
      expect(harness.lifecycleEventService.record).toHaveBeenCalledOnce();
    });
    expect(harness.runtimeManager.stopAndQuiesce).not.toHaveBeenCalled();

    durableEvent.resolve(null);
    await stop;

    expect(effects).toEqual(['durable-event-complete', 'runtime-stop']);
  });

  it('keeps cleanup order and releases the reservation after a propagated cleanup failure', async () => {
    const effects: string[] = [];
    const harness = createTerminationHarness({
      onBeforeStopSession: () => effects.push('before-stop'),
      getSessionById: () => {
        effects.push('load-session');
        return Promise.resolve(harness.session);
      },
    });
    harness.promptTurnCompletionService.clearSession.mockImplementation(() => {
      effects.push('clear-prompt');
    });
    harness.sessionDomainService.clearQueuedWork.mockImplementation(() => {
      effects.push('clear-queued-work');
    });
    harness.lifecycleEventService.record.mockImplementation(() => {
      effects.push('durable-event');
      return Promise.resolve(null);
    });
    harness.sessionDomainService.setRuntimeSnapshot.mockImplementation((_sessionId, snapshot) => {
      effects.push(snapshot.phase === 'stopping' ? 'snapshot-stopping' : 'snapshot-idle');
    });
    harness.acpEventProcessor.clearStreamingState.mockImplementation(() => {
      effects.push('clear-streaming');
    });
    harness.acpEventProcessor.clearReplaySuppression.mockImplementation(() => {
      effects.push('clear-replay');
    });
    harness.sessionPermissionService.cancelPendingRequests.mockImplementation(() => {
      effects.push('cancel-permissions');
    });
    harness.runtimeManager.stopAndQuiesce.mockImplementation(() => {
      effects.push('runtime-stop');
      return Promise.resolve();
    });
    harness.acpEventProcessor.finalizeOrphanedToolCalls.mockImplementation(() => {
      effects.push('finalize-orphans');
    });
    harness.repository.updateSessionIfStatus.mockImplementation(() => {
      effects.push('update-idle-status');
      return Promise.resolve(0);
    });
    harness.workspaceBridge.markSessionIdle.mockImplementation(() => {
      effects.push('workspace-idle');
    });
    harness.acpEventProcessor.clearSessionState.mockImplementation(() => {
      effects.push('clear-acp-state');
    });
    harness.workflowFinalizer.finalizeDeliberateStop.mockImplementation(() => {
      effects.push('deliberate-finalization');
      return Promise.resolve();
    });
    harness.workflowFinalizer.clearInactiveSession.mockImplementation(() => {
      effects.push('clear-inactive');
      throw new Error('clear inactive failed');
    });
    const closeTrace = vi.spyOn(acpTraceLogger, 'closeSession').mockImplementation(() => {
      effects.push('close-trace');
    });
    const originalReserveStop = harness.lifecycleGate.reserveStop.bind(harness.lifecycleGate);
    vi.spyOn(harness.lifecycleGate, 'reserveStop').mockImplementation((...args) => {
      effects.push('reserve-stop');
      const reservation = originalReserveStop(...args);
      if (!reservation) {
        return null;
      }
      return {
        generation: reservation.generation,
        release: () => {
          effects.push('release-stop');
          reservation.release();
        },
      };
    });

    try {
      await expect(harness.coordinator.stopSession('session-1')).rejects.toThrow(
        'clear inactive failed'
      );
    } finally {
      closeTrace.mockRestore();
    }

    expect(effects).toEqual([
      'reserve-stop',
      'clear-prompt',
      'before-stop',
      'clear-queued-work',
      'load-session',
      'durable-event',
      'snapshot-stopping',
      'clear-streaming',
      'clear-replay',
      'cancel-permissions',
      'runtime-stop',
      'finalize-orphans',
      'update-idle-status',
      'snapshot-idle',
      'workspace-idle',
      'clear-acp-state',
      'deliberate-finalization',
      'clear-inactive',
      'close-trace',
      'release-stop',
    ]);
    expect(harness.lifecycleGate.isStopReserved('session-1')).toBe(false);
  });

  it('continues mandatory cleanup after runtime stop fails and skips deliberate finalization', async () => {
    const effects: string[] = [];
    const harness = createTerminationHarness();
    harness.runtimeManager.stopAndQuiesce.mockImplementation(() => {
      effects.push('runtime-stop-failed');
      return Promise.reject(new Error('runtime stop failed'));
    });
    harness.acpEventProcessor.finalizeOrphanedToolCalls.mockImplementation(() => {
      effects.push('finalize-orphans');
    });
    harness.repository.updateSessionIfStatus.mockImplementation(() => {
      effects.push('update-idle-status');
      return Promise.resolve(0);
    });
    harness.sessionDomainService.setRuntimeSnapshot.mockImplementation((_sessionId, snapshot) => {
      if (snapshot.phase === 'idle') {
        effects.push('snapshot-idle');
      }
    });
    harness.workspaceBridge.markSessionIdle.mockImplementation(() => {
      effects.push('workspace-idle');
    });
    harness.acpEventProcessor.clearSessionState.mockImplementation(() => {
      effects.push('clear-acp-state');
    });
    harness.workflowFinalizer.clearInactiveSession.mockImplementation(() => {
      effects.push('clear-inactive');
    });

    await expect(harness.coordinator.stopSession('session-1')).resolves.toBeUndefined();

    expect(effects).toEqual([
      'runtime-stop-failed',
      'finalize-orphans',
      'update-idle-status',
      'snapshot-idle',
      'workspace-idle',
      'clear-acp-state',
      'clear-inactive',
    ]);
    expect(harness.workflowFinalizer.finalizeDeliberateStop).not.toHaveBeenCalled();
    expect(harness.lifecycleGate.isStopReserved('session-1')).toBe(false);
  });

  it('releases the stop generation after a session stops', async () => {
    const { coordinator, lifecycleGate } = createTerminationHarness();
    const stopGeneration = lifecycleGate.getGeneration('session-1');

    await coordinator.stopSession('session-1');

    const sentinelGeneration = lifecycleGate.getGeneration('sentinel-session');
    expect(sentinelGeneration).toBeGreaterThan(stopGeneration);
    expect(lifecycleGate.getGeneration('session-1')).toBeGreaterThan(sentinelGeneration);
  });

  it('releases the stop generation when finalization retains inactive session state', async () => {
    const { coordinator, lifecycleGate, workflowFinalizer } = createTerminationHarness();
    const stopGeneration = lifecycleGate.getGeneration('session-1');

    await coordinator.stopSession('session-1');

    expect(workflowFinalizer.clearInactiveSession).toHaveBeenCalledWith('session-1', 'manual_stop');
    const sentinelGeneration = lifecycleGate.getGeneration('sentinel-session');
    expect(sentinelGeneration).toBeGreaterThan(stopGeneration);
    expect(lifecycleGate.getGeneration('session-1')).toBeGreaterThan(sentinelGeneration);
  });

  it('waits for a runtime-owned client creation fence and stops the resulting runtime', async () => {
    const { coordinator, runtimeManager } = createTerminationHarness();
    type RuntimeHandle = { id: string };
    let activeHandle: RuntimeHandle | undefined;
    let resolveClient!: (handle: RuntimeHandle) => void;
    const pendingClient = new Promise<RuntimeHandle>((resolve) => {
      resolveClient = resolve;
    });
    const stopClient = vi.fn(() => {
      activeHandle = undefined;
      return Promise.resolve();
    });
    const quiescence = new AcpRuntimeQuiescence({ stopClient });
    runtimeManager.stopAndQuiesce.mockImplementation((sessionId) =>
      quiescence.stopAndQuiesce(sessionId)
    );
    const creation = quiescence.runClientCreationOperation('session-1', 'active', async () => {
      activeHandle = await pendingClient;
      return activeHandle;
    });

    const stopPromise = coordinator.stopSession('session-1');
    await vi.waitFor(() => {
      expect(runtimeManager.stopAndQuiesce).toHaveBeenCalledWith('session-1');
    });
    let stopSettled = false;
    void stopPromise.then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    resolveClient({ id: 'runtime-handle' });

    await stopPromise;
    await creation;
    expect(runtimeManager.stopAndQuiesce).toHaveBeenCalledTimes(1);
    expect(stopClient).toHaveBeenCalledWith('session-1');
    expect(activeHandle).toBeUndefined();
  });

  it('returns a duplicate stop without repeating effects or releasing the active reservation', async () => {
    const harness = createTerminationHarness();
    const stopEvent = createDeferred<null>();
    harness.lifecycleEventService.record.mockReturnValueOnce(stopEvent.promise);
    const originalReserveStop = harness.lifecycleGate.reserveStop.bind(harness.lifecycleGate);
    const releases = vi.fn();
    vi.spyOn(harness.lifecycleGate, 'reserveStop').mockImplementation((...args) => {
      const reservation = originalReserveStop(...args);
      if (!reservation) {
        return null;
      }
      return {
        generation: reservation.generation,
        release: () => {
          releases();
          reservation.release();
        },
      };
    });

    const firstStop = harness.coordinator.stopSession('session-1');
    await vi.waitFor(() => {
      expect(harness.lifecycleEventService.record).toHaveBeenCalledTimes(1);
    });

    await expect(harness.coordinator.stopSession('session-1')).resolves.toBeUndefined();
    expect(harness.lifecycleGate.isSessionStopping('session-1')).toBe(true);
    expect(harness.lifecycleEventService.record).toHaveBeenCalledTimes(1);
    expect(harness.runtimeManager.stopAndQuiesce).not.toHaveBeenCalled();
    expect(harness.sessionDomainService.clearQueuedWork).toHaveBeenCalledTimes(1);
    expect(harness.acpEventProcessor.clearSessionState).not.toHaveBeenCalled();
    expect(releases).not.toHaveBeenCalled();

    stopEvent.resolve(null);
    await firstStop;

    expect(harness.lifecycleGate.isSessionStopping('session-1')).toBe(false);
    expect(harness.runtimeManager.stopAndQuiesce).toHaveBeenCalledTimes(1);
    expect(harness.repository.updateSessionIfStatus).toHaveBeenCalledTimes(1);
    expect(harness.acpEventProcessor.clearSessionState).toHaveBeenCalledTimes(1);
    expect(releases).toHaveBeenCalledTimes(1);
  });
});
