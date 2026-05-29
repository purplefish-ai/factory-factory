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

type Logger = ReturnType<typeof createLogger>;
type AutoIterationServiceInternals = {
  loops: Map<string, RunningLoop>;
  runLoop(loop: RunningLoop, worktreePath: string): Promise<void>;
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
  let workspaceBridge: AutoIterationWorkspaceBridge;

  beforeEach(() => {
    service = new AutoIterationService(createLoggerMock());
    serviceInternals = service as unknown as AutoIterationServiceInternals;
    workspaceBridge = createWorkspaceBridge();
    service.configure(createSessionBridge(), workspaceBridge, createLogbookBridge());
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

  it('releases the resume sentinel if restarting the loop fails', async () => {
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

    expect(workspaceBridge.updateAutoIterationStatus).toHaveBeenCalledTimes(2);
    expect(workspaceBridge.getWorktreePath).toHaveBeenCalledTimes(1);
    expect(runLoop).toHaveBeenCalledTimes(1);
    expect(loop.loopPromise).not.toBeNull();
  });
});
