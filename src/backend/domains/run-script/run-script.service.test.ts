import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindById = vi.fn();
const mockCompleteStopping = vi.fn();
const mockMarkCompleted = vi.fn();
const mockMarkFailed = vi.fn();

vi.mock('@/backend/resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}));

vi.mock('./run-script-state-machine.service', () => ({
  runScriptStateMachine: {
    completeStopping: (...args: unknown[]) => mockCompleteStopping(...args),
    markCompleted: (...args: unknown[]) => mockMarkCompleted(...args),
    markFailed: (...args: unknown[]) => mockMarkFailed(...args),
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

describe('RunScriptService.handleProcessExit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
