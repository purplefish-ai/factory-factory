import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceNotificationService } from '@/backend/services/workspace';
import { SessionStatus } from '@/shared/core';
import { createLifecycleHarness } from './session-lifecycle.test-helpers';

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getCurrentProcessEnv: () => ({ ...process.env }),
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

async function captureRuntimeExit(
  harness: ReturnType<typeof createLifecycleHarness>
): Promise<(sessionId: string, exitCode: number | null) => Promise<void>> {
  await harness.service.getOrCreateSessionClient('session-1');
  const onExit = harness.runtimeManager.getOrCreateClient.mock.calls.at(-1)?.[2]?.onExit;
  if (!onExit) {
    throw new Error('Expected runtime exit callback');
  }
  return onExit;
}

describe('SessionRuntimeExitCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([]);
  });

  it('records an unexpected process exit once with its runtime incarnation and exit code', async () => {
    const harness = createLifecycleHarness();
    const onExit = await captureRuntimeExit(harness);

    await onExit('session-1', 1);

    expect(harness.sessionDomainService.markProcessExit).toHaveBeenCalledWith('session-1', 1);
    expect(harness.repository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.FAILED,
    });
    expect(harness.lifecycleEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'SESSION_STOPPED',
        reason: 'UNEXPECTED_EXIT',
        message: 'Session stopped: agent process exited unexpectedly (code 1).',
        dedupeKey: expect.stringMatching(
          /^process-exit:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:1$/
        ),
      })
    );
    expect(harness.sessionDomainService.clearSession).toHaveBeenCalledWith('session-1', {
      preserveRejections: true,
    });
  });

  it('records an unexpected process exit when the status update fails', async () => {
    const harness = createLifecycleHarness();
    const onExit = await captureRuntimeExit(harness);
    harness.repository.updateSession.mockRejectedValueOnce(new Error('database write failed'));

    await onExit('session-1', 1);

    expect(harness.lifecycleEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'UNEXPECTED_EXIT',
        dedupeKey: expect.stringMatching(/^process-exit:.+:1$/),
      })
    );
  });

  it('does not collapse repeated null-PID exits from separate runtime incarnations', async () => {
    const harness = createLifecycleHarness({
      providerProcessPid: null,
    });

    const firstExit = await captureRuntimeExit(harness);
    await firstExit('session-1', 1);
    const secondExit = await captureRuntimeExit(harness);
    await secondExit('session-1', 1);

    const dedupeKeys = harness.lifecycleEventService.record.mock.calls.map(
      ([recordInput]) => recordInput.dedupeKey
    );
    expect(dedupeKeys).toHaveLength(2);
    expect(new Set(dedupeKeys).size).toBe(2);
    expect(dedupeKeys).toEqual([
      expect.stringMatching(/^process-exit:.+:1$/),
      expect.stringMatching(/^process-exit:.+:1$/),
    ]);
  });

  it('does not label a deliberate stop as an unexpected exit', async () => {
    const harness = createLifecycleHarness();
    const onExit = await captureRuntimeExit(harness);
    harness.runtimeManager.isStopInProgress.mockReturnValue(true);

    await onExit('session-1', 0);

    expect(harness.lifecycleEventService.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'UNEXPECTED_EXIT' })
    );
  });

  it('records a null-code runtime exit as a failed signal exit', async () => {
    const harness = createLifecycleHarness();
    const onExit = await captureRuntimeExit(harness);
    harness.repository.updateSession.mockClear();

    await onExit('session-1', null);

    expect(harness.sessionDomainService.markProcessExit).toHaveBeenCalledWith('session-1', null);
    expect(harness.repository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.FAILED,
    });
    expect(harness.lifecycleEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'UNEXPECTED_EXIT',
        message: 'Session stopped: agent process exited unexpectedly.',
        dedupeKey: expect.stringMatching(/^process-exit:.+:signal$/),
      })
    );
  });

  // AcpRuntimeManager separately owns stale SIGKILL callback suppression. This
  // characterizes lifecycle state when an older callback is already in flight.
  it('preserves a restarted generation when a stale-incarnation exit finishes', async () => {
    const harness = createLifecycleHarness();
    const onExit = await captureRuntimeExit(harness);
    let resolveUpdate!: (value: typeof harness.session) => void;
    harness.repository.updateSession.mockReturnValueOnce(
      new Promise<typeof harness.session>((resolve) => {
        resolveUpdate = resolve;
      })
    );
    const oldGeneration = harness.service.getStopGeneration('session-1');

    const exitPromise = onExit('session-1', 0);

    expect(harness.service.isStopGenerationCurrent('session-1', oldGeneration)).toBe(false);
    await harness.service.startSession('session-1');
    const restartedGeneration = harness.service.getStopGeneration('session-1');
    expect(restartedGeneration).not.toBe(oldGeneration);

    resolveUpdate(harness.session);
    await exitPromise;

    expect(harness.service.isStopGenerationCurrent('session-1', restartedGeneration)).toBe(true);
    expect(harness.service.isStopGenerationCurrent('session-1', oldGeneration)).toBe(false);
  });
});
