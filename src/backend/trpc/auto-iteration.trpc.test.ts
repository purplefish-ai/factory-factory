import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAutoIterationService = vi.hoisted(() => ({
  start: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  resumeFromFailed: vi.fn(),
  stop: vi.fn(),
  getStatus: vi.fn(),
  isRunning: vi.fn(),
}));

const mockWorkspaceDataService = vi.hoisted(() => ({
  findById: vi.fn(),
}));

vi.mock('@/backend/services/auto-iteration', () => ({
  autoIterationService: mockAutoIterationService,
  insightsService: { read: vi.fn() },
  logbookService: { read: vi.fn() },
}));

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: mockWorkspaceDataService,
}));

import { autoIterationRouter } from './auto-iteration.trpc';

const validProgress = {
  currentIteration: 2,
  baselineMetricSummary: '10 tests passing',
  currentMetricSummary: '12 tests passing',
  acceptedCount: 1,
  rejectedRegressionCount: 0,
  rejectedCritiqueCount: 1,
  crashedCount: 0,
  sessionRecycleCount: 0,
  startedAt: '2026-05-17T12:00:00.000Z',
  lastIterationAt: null,
  currentPhase: 'idle',
  lastTestOutput: 'ok',
};

function createCaller() {
  return autoIterationRouter.createCaller({ appContext: {} } as never);
}

describe('autoIterationRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAutoIterationService.getStatus.mockReturnValue(null);
    mockAutoIterationService.isRunning.mockReturnValue(false);
    mockAutoIterationService.start.mockResolvedValue(undefined);
    mockAutoIterationService.resumeFromFailed.mockResolvedValue(undefined);
  });

  it('rejects malformed persisted config before starting', async () => {
    const caller = createCaller();
    mockWorkspaceDataService.findById.mockResolvedValue({
      id: 'ws-1',
      mode: 'AUTO_ITERATION',
      autoIterationConfig: {
        testCommand: '',
        targetDescription: 'Improve coverage',
      },
    });

    await expect(caller.start({ workspaceId: 'ws-1' })).rejects.toThrow(
      'Invalid auto-iteration config'
    );
    expect(mockAutoIterationService.start).not.toHaveBeenCalled();
  });

  it('defaults persisted config before starting', async () => {
    const caller = createCaller();
    mockWorkspaceDataService.findById.mockResolvedValue({
      id: 'ws-1',
      mode: 'AUTO_ITERATION',
      autoIterationConfig: {
        testCommand: 'pnpm test',
        targetDescription: 'Improve coverage',
      },
    });

    await expect(caller.start({ workspaceId: 'ws-1' })).resolves.toEqual({ success: true });

    expect(mockAutoIterationService.start).toHaveBeenCalledWith('ws-1', {
      testCommand: 'pnpm test',
      targetDescription: 'Improve coverage',
      maxIterations: 25,
      testTimeoutSeconds: 600,
      sessionRecycleInterval: 10,
    });
  });

  it('rejects malformed progress before failed resume', async () => {
    const caller = createCaller();
    mockWorkspaceDataService.findById.mockResolvedValue({
      id: 'ws-1',
      autoIterationStatus: 'FAILED',
      autoIterationConfig: {
        testCommand: 'pnpm test',
        targetDescription: 'Improve coverage',
      },
      autoIterationProgress: { currentIteration: 2 },
    });

    await expect(caller.resume({ workspaceId: 'ws-1' })).rejects.toThrow(
      'Invalid auto-iteration progress'
    );
    expect(mockAutoIterationService.resumeFromFailed).not.toHaveBeenCalled();
  });

  it('parses persisted snapshot data in getStatus fallback', async () => {
    const caller = createCaller();
    mockWorkspaceDataService.findById.mockResolvedValue({
      id: 'ws-1',
      autoIterationStatus: 'FAILED',
      autoIterationConfig: {
        testCommand: 'pnpm test',
        targetDescription: 'Improve coverage',
      },
      autoIterationProgress: validProgress,
    });

    await expect(caller.getStatus({ workspaceId: 'ws-1' })).resolves.toEqual({
      status: 'FAILED',
      config: {
        testCommand: 'pnpm test',
        targetDescription: 'Improve coverage',
        maxIterations: 25,
        testTimeoutSeconds: 600,
        sessionRecycleInterval: 10,
      },
      progress: validProgress,
    });
  });
});
