import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTreeKill = vi.fn();
const mockFindById = vi.fn();
const mockBeginStopping = vi.fn();
const mockCompleteStopping = vi.fn();
const mockMarkCompleted = vi.fn();
const mockMarkFailed = vi.fn();
const mockReset = vi.fn();

vi.mock('tree-kill', () => ({
  default: (...args: unknown[]) => mockTreeKill(...args),
}));

vi.mock('@/backend/resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}));

vi.mock('./run-script-state-machine.service', () => ({
  runScriptStateMachine: {
    beginStopping: (...args: unknown[]) => mockBeginStopping(...args),
    completeStopping: (...args: unknown[]) => mockCompleteStopping(...args),
    markCompleted: (...args: unknown[]) => mockMarkCompleted(...args),
    markFailed: (...args: unknown[]) => mockMarkFailed(...args),
    reset: (...args: unknown[]) => mockReset(...args),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { RunScriptService } from './run-script.service';

type ExitHandlerCapable = {
  handleProcessExit: (
    workspaceId: string,
    pid: number,
    code: number | null,
    signal: string | null
  ) => Promise<void>;
};

type StopHandlerCapable = {
  runningProcesses: Map<string, { pid: number }>;
};

describe('RunScriptService.handleProcessExit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTreeKill.mockImplementation(
      (_pid: number, _signal: string, callback: (error: Error | null) => void) => callback(null)
    );
  });

  it('finalizes STOPPING state to IDLE when the process exits', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'STOPPING' });
    mockCompleteStopping.mockResolvedValue(undefined);

    const service = new RunScriptService() as unknown as ExitHandlerCapable;

    await service.handleProcessExit('ws-1', 12_345, 0, null);

    expect(mockFindById).toHaveBeenCalledWith('ws-1');
    expect(mockCompleteStopping).toHaveBeenCalledWith('ws-1');
    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('swallows completeStopping errors for STOPPING exits', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'STOPPING' });
    mockCompleteStopping.mockRejectedValue(new Error('tree-kill failed'));

    const service = new RunScriptService() as unknown as ExitHandlerCapable;

    await expect(service.handleProcessExit('ws-1', 12_345, 1, 'SIGTERM')).resolves.toBe(undefined);
    expect(mockCompleteStopping).toHaveBeenCalledWith('ws-1');
    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });
});

describe('RunScriptService.stopRunScript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTreeKill.mockImplementation(
      (_pid: number, _signal: string, callback: (error: Error | null) => void) => callback(null)
    );
  });

  it('returns success when completeStopping races with exit handler', async () => {
    mockFindById
      .mockResolvedValueOnce({
        id: 'ws-1',
        runScriptStatus: 'RUNNING',
        runScriptPid: 12_345,
        runScriptCleanupCommand: null,
        worktreePath: '/tmp/ws-1',
        runScriptPort: null,
      })
      .mockResolvedValueOnce({
        id: 'ws-1',
        runScriptStatus: 'IDLE',
      });
    mockBeginStopping.mockResolvedValue(undefined);
    mockCompleteStopping.mockRejectedValue(new Error('already transitioned'));

    const service = new RunScriptService();
    (service as unknown as StopHandlerCapable).runningProcesses.set('ws-1', { pid: 12_345 });
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect(mockBeginStopping).toHaveBeenCalledWith('ws-1');
    expect(mockTreeKill).toHaveBeenCalledWith(12_345, 'SIGTERM', expect.any(Function));
    expect(mockCompleteStopping).toHaveBeenCalledWith('ws-1');
    expect(mockFindById).toHaveBeenNthCalledWith(2, 'ws-1');
  });

  it('returns error when workspace not found', async () => {
    mockFindById.mockResolvedValue(null);

    const service = new RunScriptService();
    const result = await service.stopRunScript('ws-missing');

    expect(result).toEqual({ success: false, error: 'Workspace not found' });
  });

  it('returns success immediately when already IDLE', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'IDLE' });

    const service = new RunScriptService();
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect(mockBeginStopping).not.toHaveBeenCalled();
  });

  it('returns success immediately when already STOPPING', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'STOPPING' });

    const service = new RunScriptService();
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect(mockBeginStopping).not.toHaveBeenCalled();
  });

  it('handles COMPLETED state by resetting to IDLE', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      runScriptStatus: 'COMPLETED',
      runScriptPid: null,
    });
    mockReset.mockResolvedValue(undefined);

    const service = new RunScriptService();
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect(mockReset).toHaveBeenCalledWith('ws-1');
  });

  it('handles FAILED state by resetting to IDLE', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      runScriptStatus: 'FAILED',
      runScriptPid: null,
    });
    mockReset.mockResolvedValue(undefined);

    const service = new RunScriptService();
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
    expect(mockReset).toHaveBeenCalledWith('ws-1');
  });

  it('returns error when no process or PID available for RUNNING workspace', async () => {
    mockFindById.mockResolvedValue({
      id: 'ws-1',
      runScriptStatus: 'RUNNING',
      runScriptPid: null,
    });

    const service = new RunScriptService();
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: false, error: 'No run script is running' });
  });

  it('handles beginStopping race where state moved to COMPLETED', async () => {
    mockFindById
      .mockResolvedValueOnce({
        id: 'ws-1',
        runScriptStatus: 'RUNNING',
        runScriptPid: 12_345,
        runScriptCleanupCommand: null,
        worktreePath: '/tmp/ws-1',
        runScriptPort: null,
      })
      .mockResolvedValueOnce({
        id: 'ws-1',
        runScriptStatus: 'COMPLETED',
      });
    mockBeginStopping.mockRejectedValue(new Error('CAS failed'));

    const service = new RunScriptService();
    (service as unknown as StopHandlerCapable).runningProcesses.set('ws-1', { pid: 12_345 });
    const result = await service.stopRunScript('ws-1');

    expect(result).toEqual({ success: true });
  });
});

describe('RunScriptService.handleProcessExit edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks COMPLETED on exit code 0 from RUNNING state', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    mockMarkCompleted.mockResolvedValue(undefined);

    const service = new RunScriptService() as unknown as ExitHandlerCapable;
    await service.handleProcessExit('ws-1', 12_345, 0, null);

    expect(mockMarkCompleted).toHaveBeenCalledWith('ws-1');
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('marks FAILED on non-zero exit code from RUNNING state', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    mockMarkFailed.mockResolvedValue(undefined);

    const service = new RunScriptService() as unknown as ExitHandlerCapable;
    await service.handleProcessExit('ws-1', 12_345, 1, null);

    expect(mockMarkFailed).toHaveBeenCalledWith('ws-1');
    expect(mockMarkCompleted).not.toHaveBeenCalled();
  });

  it('marks FAILED on signal-killed process (null exit code)', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    mockMarkFailed.mockResolvedValue(undefined);

    const service = new RunScriptService() as unknown as ExitHandlerCapable;
    await service.handleProcessExit('ws-1', 12_345, null, 'SIGKILL');

    expect(mockMarkFailed).toHaveBeenCalledWith('ws-1');
  });

  it('skips transition when already in IDLE state', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'IDLE' });

    const service = new RunScriptService() as unknown as ExitHandlerCapable;
    await service.handleProcessExit('ws-1', 12_345, 0, null);

    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockCompleteStopping).not.toHaveBeenCalled();
  });

  it('skips transition when already in COMPLETED state', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'COMPLETED' });

    const service = new RunScriptService() as unknown as ExitHandlerCapable;
    await service.handleProcessExit('ws-1', 12_345, 0, null);

    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('skips transition when already in FAILED state', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'FAILED' });

    const service = new RunScriptService() as unknown as ExitHandlerCapable;
    await service.handleProcessExit('ws-1', 12_345, 1, null);

    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('swallows state machine errors during exit handling', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-1', runScriptStatus: 'RUNNING' });
    mockMarkCompleted.mockRejectedValue(new Error('CAS conflict'));

    const service = new RunScriptService() as unknown as ExitHandlerCapable;
    await expect(service.handleProcessExit('ws-1', 12_345, 0, null)).resolves.toBeUndefined();
  });
});

describe('RunScriptService.appendOutput', () => {
  it('truncates output buffer when exceeding MAX_OUTPUT_BUFFER_SIZE', () => {
    const service = new RunScriptService();
    const appendOutput = (
      service as unknown as { appendOutput: (id: string, data: string) => void }
    ).appendOutput.bind(service);

    // Build a string just over 500KB
    const bigChunk = 'x'.repeat(400 * 1024);
    appendOutput('ws-1', bigChunk);

    const smallChunk = 'y'.repeat(200 * 1024);
    appendOutput('ws-1', smallChunk);

    const buffer = service.getOutputBuffer('ws-1');
    // Buffer should be capped at 500KB
    expect(buffer.length).toBe(500 * 1024);
    // Should contain the latest data
    expect(buffer.endsWith('y'.repeat(200 * 1024))).toBe(true);
  });

  it('notifies listeners on new output', () => {
    const service = new RunScriptService();
    const appendOutput = (
      service as unknown as { appendOutput: (id: string, data: string) => void }
    ).appendOutput.bind(service);
    const listener = vi.fn();
    service.subscribeToOutput('ws-1', listener);

    appendOutput('ws-1', 'hello');
    expect(listener).toHaveBeenCalledWith('hello');
  });

  it('returns empty string for unknown workspace', () => {
    const service = new RunScriptService();
    expect(service.getOutputBuffer('unknown')).toBe('');
  });
});

describe('RunScriptService.subscribeToOutput', () => {
  it('returns unsubscribe function that stops notifications', () => {
    const service = new RunScriptService();
    const appendOutput = (
      service as unknown as { appendOutput: (id: string, data: string) => void }
    ).appendOutput.bind(service);
    const listener = vi.fn();
    const unsub = service.subscribeToOutput('ws-1', listener);

    appendOutput('ws-1', 'before');
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    appendOutput('ws-1', 'after');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('cleans up listener set when last listener unsubscribes', () => {
    const service = new RunScriptService();
    const outputListeners = (service as unknown as { outputListeners: Map<string, Set<unknown>> })
      .outputListeners;

    const unsub = service.subscribeToOutput('ws-1', vi.fn());
    expect(outputListeners.has('ws-1')).toBe(true);

    unsub();
    expect(outputListeners.has('ws-1')).toBe(false);
  });
});

describe('RunScriptService.cleanupSync', () => {
  it('force kills all running processes and clears maps', () => {
    const service = new RunScriptService();
    const mockProcess = { killed: false, kill: vi.fn(), pid: 999 };
    (service as unknown as StopHandlerCapable).runningProcesses.set('ws-1', mockProcess as never);

    service.cleanupSync();

    expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
    expect((service as unknown as StopHandlerCapable).runningProcesses.size).toBe(0);
  });

  it('skips already-killed processes', () => {
    const service = new RunScriptService();
    const mockProcess = { killed: true, kill: vi.fn(), pid: 999 };
    (service as unknown as StopHandlerCapable).runningProcesses.set('ws-1', mockProcess as never);

    service.cleanupSync();

    expect(mockProcess.kill).not.toHaveBeenCalled();
  });
});
