import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { createLogger } from '@/backend/services/logger.service';
import { AutoIterationStatus } from '@/shared/core';
import { AutoIterationService } from './auto-iteration.service';
import type { RunningLoop } from './auto-iteration-loop-state';
import { createInitialRunningLoop } from './auto-iteration-loop-state';
import type {
  AutoIterationLogbookBridge,
  AutoIterationSessionBridge,
  AutoIterationWorkspaceBridge,
} from './bridges';
import { insightsService } from './insights.service';

type Logger = ReturnType<typeof createLogger>;
type AutoIterationServiceInternals = {
  loops: Map<string, RunningLoop>;
  runLoop(loop: RunningLoop, worktreePath: string): Promise<void>;
  finalize(loop: RunningLoop, status: AutoIterationStatus): Promise<void>;
};

const config = {
  testCommand: 'pnpm test',
  targetDescription: 'Improve tests',
  maxIterations: 5,
  testTimeoutSeconds: 60,
  sessionRecycleInterval: 3,
};

function createLoggerMock(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function createWorkspaceBridge(): AutoIterationWorkspaceBridge {
  return {
    getWorktreePath: vi.fn().mockResolvedValue('/tmp/worktree'),
    updateAutoIterationStatus: vi.fn().mockResolvedValue(undefined),
    updateAutoIterationProgress: vi.fn().mockResolvedValue(undefined),
    updateAutoIterationSessionId: vi.fn().mockResolvedValue(undefined),
    finishAutoIterationIfSessionMatches: vi.fn().mockResolvedValue(true),
  };
}

function createSessionBridge(): AutoIterationSessionBridge {
  return {
    startSession: vi.fn().mockResolvedValue('session-1'),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    stopSession: vi.fn().mockResolvedValue(undefined),
    getLastAssistantMessage: vi.fn().mockResolvedValue('assistant response'),
    recycleSession: vi.fn().mockResolvedValue('session-2'),
  };
}

function createLogbookBridge(): AutoIterationLogbookBridge {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    appendEntry: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(null),
    readStrategyFile: vi.fn().mockResolvedValue(null),
    writeStrategyFile: vi.fn().mockResolvedValue(undefined),
  };
}

function createPausedLoop(workspaceId: string): RunningLoop {
  const loop = createInitialRunningLoop(workspaceId, config);
  loop.sessionId = 'session-1';
  loop.pauseRequested = true;
  loop.loopPromise = Promise.resolve();
  return loop;
}

describe('AutoIterationService resume', () => {
  let service: AutoIterationService;
  let serviceInternals: AutoIterationServiceInternals;
  let logger: Logger;
  let sessionBridge: AutoIterationSessionBridge;
  let workspaceBridge: AutoIterationWorkspaceBridge;

  beforeEach(() => {
    logger = createLoggerMock();
    service = new AutoIterationService(logger);
    serviceInternals = service as unknown as AutoIterationServiceInternals;
    sessionBridge = createSessionBridge();
    workspaceBridge = createWorkspaceBridge();
    service.configure(sessionBridge, workspaceBridge, createLogbookBridge());
  });

  it('starts only one run loop for concurrent resume calls', async () => {
    const loop = createPausedLoop('ws-1');
    serviceInternals.loops.set('ws-1', loop);

    let releaseStatusUpdate = (): void => undefined;
    vi.mocked(workspaceBridge.updateAutoIterationStatus).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStatusUpdate = resolve;
        })
    );

    const runLoop = vi
      .spyOn(serviceInternals, 'runLoop')
      .mockImplementation(() => new Promise<void>(() => undefined));

    const firstResume = service.resume('ws-1');
    await vi.waitFor(() => {
      expect(workspaceBridge.updateAutoIterationStatus).toHaveBeenCalledTimes(1);
    });

    const secondResume = service.resume('ws-1');
    releaseStatusUpdate();

    await Promise.all([firstResume, secondResume]);

    expect(workspaceBridge.updateAutoIterationStatus).toHaveBeenCalledWith(
      'ws-1',
      AutoIterationStatus.RUNNING
    );
    expect(workspaceBridge.updateAutoIterationStatus).toHaveBeenCalledTimes(1);
    expect(workspaceBridge.getWorktreePath).toHaveBeenCalledTimes(1);
    expect(runLoop).toHaveBeenCalledTimes(1);
    expect(loop.loopPromise).not.toBeNull();
  });

  it('restores paused state and releases the resume sentinel if restarting the loop fails', async () => {
    const loop = createPausedLoop('ws-1');
    serviceInternals.loops.set('ws-1', loop);

    const startupError = new Error('status update failed');
    let rejectStatusUpdate = (_error: Error): void => undefined;
    vi.mocked(workspaceBridge.updateAutoIterationStatus)
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectStatusUpdate = reject;
          })
      )
      .mockResolvedValueOnce(undefined);

    const runLoop = vi
      .spyOn(serviceInternals, 'runLoop')
      .mockImplementation(() => new Promise<void>(() => undefined));

    const firstResume = service.resume('ws-1');
    await vi.waitFor(() => {
      expect(workspaceBridge.updateAutoIterationStatus).toHaveBeenCalledTimes(1);
    });

    const secondResume = service.resume('ws-1');
    rejectStatusUpdate(startupError);

    await expect(firstResume).rejects.toThrow('status update failed');
    await secondResume;

    expect(workspaceBridge.updateAutoIterationStatus).toHaveBeenNthCalledWith(
      2,
      'ws-1',
      AutoIterationStatus.PAUSED
    );
    expect(workspaceBridge.updateAutoIterationStatus).toHaveBeenCalledTimes(3);
    expect(workspaceBridge.getWorktreePath).toHaveBeenCalledTimes(2);
    expect(runLoop).toHaveBeenCalledTimes(1);
    expect(loop.loopPromise).not.toBeNull();
    expect(loop.pauseRequested).toBe(false);
  });

  it('keeps resume recoverable when worktree lookup fails', async () => {
    const loop = createPausedLoop('ws-1');
    serviceInternals.loops.set('ws-1', loop);

    vi.mocked(workspaceBridge.getWorktreePath)
      .mockRejectedValueOnce(new Error('Workspace ws-1 has no worktree path'))
      .mockResolvedValueOnce('/tmp/worktree');

    const runLoop = vi
      .spyOn(serviceInternals, 'runLoop')
      .mockImplementation(() => new Promise<void>(() => undefined));

    await expect(service.resume('ws-1')).rejects.toThrow('has no worktree path');

    expect(workspaceBridge.updateAutoIterationStatus).toHaveBeenCalledWith(
      'ws-1',
      AutoIterationStatus.PAUSED
    );
    expect(workspaceBridge.updateAutoIterationStatus).not.toHaveBeenCalledWith(
      'ws-1',
      AutoIterationStatus.RUNNING
    );
    expect(loop.loopPromise).toBeNull();
    expect(loop.pauseRequested).toBe(true);
    expect(service.getStatus('ws-1')?.status).toBe(AutoIterationStatus.PAUSED);

    await service.resume('ws-1');

    expect(workspaceBridge.getWorktreePath).toHaveBeenCalledTimes(2);
    expect(workspaceBridge.updateAutoIterationStatus).toHaveBeenLastCalledWith(
      'ws-1',
      AutoIterationStatus.RUNNING
    );
    expect(runLoop).toHaveBeenCalledTimes(1);
    expect(loop.loopPromise).not.toBeNull();
    expect(loop.pauseRequested).toBe(false);
  });

  it('keeps failed setup registered until terminal persistence settles', async () => {
    vi.spyOn(insightsService, 'initialize').mockResolvedValue(undefined);
    vi.spyOn(insightsService, 'getOpenContent').mockResolvedValue('');

    const setupError = new Error('session pointer write failed');
    let releaseFailedStatus!: () => void;
    vi.mocked(workspaceBridge.updateAutoIterationStatus)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFailedStatus = resolve;
          })
      );
    vi.mocked(workspaceBridge.updateAutoIterationSessionId)
      .mockRejectedValueOnce(setupError)
      .mockResolvedValueOnce(undefined);
    vi.mocked(workspaceBridge.finishAutoIterationIfSessionMatches).mockResolvedValueOnce(false);

    const startPromise = service.start('ws-1', config);
    await vi.waitFor(() => {
      expect(workspaceBridge.updateAutoIterationStatus).toHaveBeenCalledWith(
        'ws-1',
        AutoIterationStatus.FAILED
      );
    });

    expect(service.isRunning('ws-1')).toBe(true);
    await expect(service.start('ws-1', config)).rejects.toThrow(
      'Auto-iteration already running for workspace ws-1'
    );

    releaseFailedStatus();
    await expect(startPromise).rejects.toBe(setupError);
    expect(service.isRunning('ws-1')).toBe(false);
  });

  it('does not remove a replacement loop when a stale resumed loop rejects', async () => {
    const oldLoop = createPausedLoop('ws-1');
    serviceInternals.loops.set('ws-1', oldLoop);

    let rejectRunLoop!: (error: Error) => void;
    vi.spyOn(serviceInternals, 'runLoop').mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRunLoop = reject;
        })
    );

    await service.resume('ws-1');

    const replacement = createPausedLoop('ws-1');
    replacement.sessionId = 'session-2';
    serviceInternals.loops.set('ws-1', replacement);
    vi.clearAllMocks();

    let releasePersistence!: (updated: boolean) => void;
    vi.mocked(workspaceBridge.finishAutoIterationIfSessionMatches).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releasePersistence = resolve;
        })
    );
    let loopSettled = false;
    void oldLoop.loopPromise?.then(() => {
      loopSettled = true;
    });

    rejectRunLoop(new Error('old loop failed'));
    await vi.waitFor(() => {
      expect(workspaceBridge.finishAutoIterationIfSessionMatches).toHaveBeenCalled();
    });
    expect(loopSettled).toBe(false);

    releasePersistence(false);
    await oldLoop.loopPromise;

    expect(serviceInternals.loops.get('ws-1')).toBe(replacement);
    expect(workspaceBridge.finishAutoIterationIfSessionMatches).toHaveBeenCalledWith(
      'ws-1',
      'session-1',
      AutoIterationStatus.FAILED
    );
    expect(workspaceBridge.updateAutoIterationStatus).not.toHaveBeenCalled();
  });

  it('finishes a dead session with a session-keyed mutation', () => {
    const loop = createPausedLoop('ws-1');
    serviceInternals.loops.set('ws-1', loop);

    service.onSessionDeath('ws-1', 'session-1');

    expect(workspaceBridge.finishAutoIterationIfSessionMatches).toHaveBeenCalledWith(
      'ws-1',
      'session-1',
      AutoIterationStatus.FAILED
    );
    expect(workspaceBridge.updateAutoIterationStatus).not.toHaveBeenCalled();
    expect(workspaceBridge.updateAutoIterationSessionId).not.toHaveBeenCalled();
  });

  it('keeps a dead loop registered until its terminal state is persisted', async () => {
    const loop = createPausedLoop('ws-1');
    serviceInternals.loops.set('ws-1', loop);

    let releasePersistence!: (updated: boolean) => void;
    vi.mocked(workspaceBridge.finishAutoIterationIfSessionMatches).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releasePersistence = resolve;
        })
    );

    service.onSessionDeath('ws-1', 'session-1');

    expect(service.isRunning('ws-1')).toBe(true);
    await expect(service.start('ws-1', config)).rejects.toThrow(
      'Auto-iteration already running for workspace ws-1'
    );

    releasePersistence(true);
    await vi.waitFor(() => {
      expect(service.isRunning('ws-1')).toBe(false);
    });
  });

  it('does not resume a dead loop while terminal persistence is pending', async () => {
    const loop = createPausedLoop('ws-1');
    serviceInternals.loops.set('ws-1', loop);

    let releasePersistence!: (updated: boolean) => void;
    vi.mocked(workspaceBridge.finishAutoIterationIfSessionMatches).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releasePersistence = resolve;
        })
    );

    service.onSessionDeath('ws-1', 'session-1');
    const resumePromise = service.resume('ws-1');
    void resumePromise.catch(() => undefined);

    await Promise.resolve();
    await Promise.resolve();
    expect(workspaceBridge.getWorktreePath).not.toHaveBeenCalled();

    releasePersistence(true);
    await expect(resumePromise).rejects.toThrow('failed and was cleaned up — cannot resume');
  });

  it('logs rejected background terminal persistence without leaving the loop registered', async () => {
    const loop = createPausedLoop('ws-1');
    serviceInternals.loops.set('ws-1', loop);
    const persistenceError = new Error('database unavailable');
    vi.mocked(workspaceBridge.finishAutoIterationIfSessionMatches).mockRejectedValueOnce(
      persistenceError
    );

    service.onSessionDeath('ws-1', 'session-1');

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith('Failed to persist auto-iteration terminal state', {
        workspaceId: 'ws-1',
        error: 'Error: database unavailable',
      });
    });
    expect(service.isRunning('ws-1')).toBe(false);
  });

  it('does not remove a replacement loop when a stale finalizer completes', async () => {
    const oldLoop = createPausedLoop('ws-1');
    serviceInternals.loops.set('ws-1', oldLoop);

    let releaseStopSession = (): void => undefined;
    vi.mocked(sessionBridge.stopSession).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStopSession = resolve;
        })
    );

    const finalizePromise = serviceInternals.finalize(oldLoop, AutoIterationStatus.STOPPED);
    await vi.waitFor(() => {
      expect(sessionBridge.stopSession).toHaveBeenCalledWith('session-1');
    });

    service.onSessionDeath('ws-1', 'session-1');
    const replacement = createPausedLoop('ws-1');
    replacement.sessionId = 'session-2';
    serviceInternals.loops.set('ws-1', replacement);
    vi.clearAllMocks();

    releaseStopSession();
    await finalizePromise;

    expect(serviceInternals.loops.get('ws-1')).toBe(replacement);
    expect(workspaceBridge.finishAutoIterationIfSessionMatches).toHaveBeenCalledWith(
      'ws-1',
      'session-1',
      AutoIterationStatus.STOPPED
    );
    expect(workspaceBridge.updateAutoIterationStatus).not.toHaveBeenCalled();
    expect(workspaceBridge.updateAutoIterationSessionId).not.toHaveBeenCalled();
  });
});
