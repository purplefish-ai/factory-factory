import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Prisma
const mockFindUnique = vi.fn();
const mockUpdateMany = vi.fn();
const mockFindUniqueOrThrow = vi.fn();

vi.mock('@/backend/db', () => ({
  prisma: {
    workspace: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
      findUniqueOrThrow: (...args: unknown[]) => mockFindUniqueOrThrow(...args),
    },
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

// Import after mocks are set up
import {
  RUN_SCRIPT_STATUS_CHANGED,
  RunScriptStateMachineError,
  type RunScriptStatusChangedEvent,
  runScriptStateMachine,
} from './run-script-state-machine.service';

describe('RunScriptStateMachineService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isValidTransition', () => {
    it('should allow IDLE -> STARTING', () => {
      expect(runScriptStateMachine.isValidTransition('IDLE', 'STARTING')).toBe(true);
    });

    it('should allow STARTING -> RUNNING', () => {
      expect(runScriptStateMachine.isValidTransition('STARTING', 'RUNNING')).toBe(true);
    });

    it('should allow STARTING -> FAILED', () => {
      expect(runScriptStateMachine.isValidTransition('STARTING', 'FAILED')).toBe(true);
    });

    it('should allow STARTING -> COMPLETED (fast process exit with code 0)', () => {
      expect(runScriptStateMachine.isValidTransition('STARTING', 'COMPLETED')).toBe(true);
    });

    it('should allow STARTING -> STOPPING', () => {
      expect(runScriptStateMachine.isValidTransition('STARTING', 'STOPPING')).toBe(true);
    });

    it('should allow RUNNING -> STOPPING', () => {
      expect(runScriptStateMachine.isValidTransition('RUNNING', 'STOPPING')).toBe(true);
    });

    it('should allow RUNNING -> COMPLETED', () => {
      expect(runScriptStateMachine.isValidTransition('RUNNING', 'COMPLETED')).toBe(true);
    });

    it('should allow RUNNING -> FAILED', () => {
      expect(runScriptStateMachine.isValidTransition('RUNNING', 'FAILED')).toBe(true);
    });

    it('should allow STOPPING -> IDLE', () => {
      expect(runScriptStateMachine.isValidTransition('STOPPING', 'IDLE')).toBe(true);
    });

    it('should allow COMPLETED -> IDLE', () => {
      expect(runScriptStateMachine.isValidTransition('COMPLETED', 'IDLE')).toBe(true);
    });

    it('should allow COMPLETED -> STARTING (restart)', () => {
      expect(runScriptStateMachine.isValidTransition('COMPLETED', 'STARTING')).toBe(true);
    });

    it('should allow FAILED -> IDLE', () => {
      expect(runScriptStateMachine.isValidTransition('FAILED', 'IDLE')).toBe(true);
    });

    it('should allow FAILED -> STARTING (restart)', () => {
      expect(runScriptStateMachine.isValidTransition('FAILED', 'STARTING')).toBe(true);
    });

    it('should not allow IDLE -> RUNNING (skipping STARTING)', () => {
      expect(runScriptStateMachine.isValidTransition('IDLE', 'RUNNING')).toBe(false);
    });

    it('should allow STARTING -> STOPPING (for stop during startup)', () => {
      expect(runScriptStateMachine.isValidTransition('STARTING', 'STOPPING')).toBe(true);
    });

    it('should not allow STOPPING -> RUNNING', () => {
      expect(runScriptStateMachine.isValidTransition('STOPPING', 'RUNNING')).toBe(false);
    });

    it('should not allow COMPLETED -> RUNNING', () => {
      expect(runScriptStateMachine.isValidTransition('COMPLETED', 'RUNNING')).toBe(false);
    });
  });

  describe('transition', () => {
    it('should transition from IDLE to STARTING', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'IDLE' };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'STARTING' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.transition('ws-1', 'STARTING');

      expect(result.runScriptStatus).toBe('STARTING');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ws-1', runScriptStatus: 'IDLE' },
        data: expect.objectContaining({
          runScriptStatus: 'STARTING',
          runScriptPid: null,
          runScriptPort: null,
          runScriptStartedAt: null,
        }),
      });
    });

    it('should transition from STARTING to RUNNING with pid and port', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'STARTING' };
      const updatedWorkspace = {
        ...workspace,
        runScriptStatus: 'RUNNING',
        runScriptPid: 12_345,
        runScriptPort: 3000,
      };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.transition('ws-1', 'RUNNING', {
        pid: 12_345,
        port: 3000,
      });

      expect(result.runScriptStatus).toBe('RUNNING');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ws-1', runScriptStatus: 'STARTING' },
        data: expect.objectContaining({
          runScriptStatus: 'RUNNING',
          runScriptPid: 12_345,
          runScriptPort: 3000,
          runScriptStartedAt: expect.any(Date),
        }),
      });
    });

    it('should transition from RUNNING to STOPPING', async () => {
      const workspace = {
        id: 'ws-1',
        runScriptStatus: 'RUNNING',
        runScriptPid: 12_345,
        runScriptPort: 3000,
      };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'STOPPING' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.transition('ws-1', 'STOPPING');

      expect(result.runScriptStatus).toBe('STOPPING');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ws-1', runScriptStatus: 'RUNNING' },
        data: {
          runScriptStatus: 'STOPPING',
        },
      });
    });

    it('should transition from STOPPING to IDLE and clear process details', async () => {
      const workspace = {
        id: 'ws-1',
        runScriptStatus: 'STOPPING',
        runScriptPid: 12_345,
        runScriptPort: 3000,
      };
      const updatedWorkspace = {
        ...workspace,
        runScriptStatus: 'IDLE',
        runScriptPid: null,
        runScriptPort: null,
      };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.transition('ws-1', 'IDLE');

      expect(result.runScriptStatus).toBe('IDLE');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ws-1', runScriptStatus: 'STOPPING' },
        data: expect.objectContaining({
          runScriptStatus: 'IDLE',
          runScriptPid: null,
          runScriptPort: null,
          runScriptStartedAt: null,
        }),
      });
    });

    it('should transition from RUNNING to COMPLETED', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'RUNNING' };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'COMPLETED' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.transition('ws-1', 'COMPLETED');

      expect(result.runScriptStatus).toBe('COMPLETED');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ws-1', runScriptStatus: 'RUNNING' },
        data: expect.objectContaining({
          runScriptStatus: 'COMPLETED',
          runScriptPid: null,
          runScriptPort: null,
          runScriptStartedAt: null,
        }),
      });
    });

    it('should transition from RUNNING to FAILED', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'RUNNING' };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'FAILED' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.transition('ws-1', 'FAILED');

      expect(result.runScriptStatus).toBe('FAILED');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ws-1', runScriptStatus: 'RUNNING' },
        data: expect.objectContaining({
          runScriptStatus: 'FAILED',
          runScriptPid: null,
          runScriptPort: null,
          runScriptStartedAt: null,
        }),
      });
    });

    it('should throw RunScriptStateMachineError for invalid transition', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'IDLE' };
      mockFindUnique.mockResolvedValue(workspace);

      await expect(runScriptStateMachine.transition('ws-1', 'RUNNING')).rejects.toThrow(
        RunScriptStateMachineError
      );

      await expect(runScriptStateMachine.transition('ws-1', 'RUNNING')).rejects.toThrow(
        /Invalid run script state transition: IDLE \u2192 RUNNING/
      );
    });

    it('should throw error for non-existent workspace', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(runScriptStateMachine.transition('non-existent', 'STARTING')).rejects.toThrow(
        'Workspace not found: non-existent'
      );
    });

    it('should throw on concurrent state change (CAS failure)', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'IDLE' };
      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 0 });
      // On CAS failure, refetch shows the conflicting state
      mockFindUnique.mockResolvedValueOnce(workspace); // initial read
      mockFindUnique.mockResolvedValueOnce({ ...workspace, runScriptStatus: 'STARTING' }); // refetch after CAS fail

      await expect(runScriptStateMachine.transition('ws-1', 'STARTING')).rejects.toThrow(
        /Concurrent state change detected/
      );
    });
  });

  describe('start', () => {
    it('should transition from IDLE to STARTING', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'IDLE' };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'STARTING' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.start('ws-1');

      expect(result?.runScriptStatus).toBe('STARTING');
    });

    it('should return null when already RUNNING', async () => {
      const workspace = {
        id: 'ws-1',
        runScriptStatus: 'RUNNING',
        runScriptPid: process.pid,
      };

      mockFindUnique.mockResolvedValue(workspace);

      const result = await runScriptStateMachine.start('ws-1');

      expect(result).toBeNull();
    });

    it('should transition from COMPLETED to STARTING (restart)', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'COMPLETED' };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'STARTING' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.start('ws-1');

      expect(result?.runScriptStatus).toBe('STARTING');
    });

    it('should transition from FAILED to STARTING (restart)', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'FAILED' };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'STARTING' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.start('ws-1');

      expect(result?.runScriptStatus).toBe('STARTING');
    });
  });

  describe('markRunning', () => {
    it('should transition from STARTING to RUNNING with pid', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'STARTING' };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'RUNNING', runScriptPid: 12_345 };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.markRunning('ws-1', { pid: 12_345 });

      expect(result.runScriptStatus).toBe('RUNNING');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ws-1', runScriptStatus: 'STARTING' },
        data: expect.objectContaining({
          runScriptPid: 12_345,
          runScriptStartedAt: expect.any(Date),
        }),
      });
    });

    it('should transition from STARTING to RUNNING with pid and port', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'STARTING' };
      const updatedWorkspace = {
        ...workspace,
        runScriptStatus: 'RUNNING',
        runScriptPid: 12_345,
        runScriptPort: 3000,
      };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.markRunning('ws-1', { pid: 12_345, port: 3000 });

      expect(result.runScriptStatus).toBe('RUNNING');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ws-1', runScriptStatus: 'STARTING' },
        data: expect.objectContaining({
          runScriptPid: 12_345,
          runScriptPort: 3000,
          runScriptStartedAt: expect.any(Date),
        }),
      });
    });
  });

  describe('beginStopping', () => {
    it('should transition from RUNNING to STOPPING', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'RUNNING' };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'STOPPING' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.beginStopping('ws-1');

      expect(result.runScriptStatus).toBe('STOPPING');
    });
  });

  describe('completeStopping', () => {
    it('should transition from STOPPING to IDLE', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'STOPPING' };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'IDLE' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.completeStopping('ws-1');

      expect(result.runScriptStatus).toBe('IDLE');
    });
  });

  describe('markCompleted', () => {
    it('should transition from RUNNING to COMPLETED', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'RUNNING' };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'COMPLETED' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.markCompleted('ws-1');

      expect(result.runScriptStatus).toBe('COMPLETED');
    });

    it('should transition from STARTING to COMPLETED (fast process exit)', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'STARTING' };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'COMPLETED' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.markCompleted('ws-1');

      expect(result.runScriptStatus).toBe('COMPLETED');
    });
  });

  describe('markFailed', () => {
    it('should transition from STARTING to FAILED (spawn error)', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'STARTING' };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'FAILED' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.markFailed('ws-1');

      expect(result.runScriptStatus).toBe('FAILED');
    });

    it('should transition from RUNNING to FAILED (process error)', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'RUNNING' };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'FAILED' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.markFailed('ws-1');

      expect(result.runScriptStatus).toBe('FAILED');
    });
  });

  describe('reset', () => {
    it('should transition from COMPLETED to IDLE', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'COMPLETED' };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'IDLE' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.reset('ws-1');

      expect(result.runScriptStatus).toBe('IDLE');
    });

    it('should transition from FAILED to IDLE', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'FAILED' };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'IDLE' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.reset('ws-1');

      expect(result.runScriptStatus).toBe('IDLE');
    });
  });

  describe('verifyRunning', () => {
    it('should return RUNNING when process exists', async () => {
      const workspace = {
        id: 'ws-1',
        runScriptStatus: 'RUNNING',
        runScriptPid: process.pid, // Use current process pid to ensure it exists
      };

      mockFindUnique.mockResolvedValue(workspace);

      const result = await runScriptStateMachine.verifyRunning('ws-1');

      expect(result).toBe('RUNNING');
    });

    it('should mark as FAILED when process does not exist', async () => {
      const workspace = {
        id: 'ws-1',
        runScriptStatus: 'RUNNING',
        runScriptPid: 999_999, // Non-existent pid
      };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'FAILED' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await runScriptStateMachine.verifyRunning('ws-1');

      expect(result).toBe('FAILED');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ws-1', runScriptStatus: 'RUNNING' },
        data: expect.objectContaining({
          runScriptStatus: 'FAILED',
        }),
      });
    });

    it('should return current status when not RUNNING', async () => {
      const workspace = {
        id: 'ws-1',
        runScriptStatus: 'IDLE',
        runScriptPid: null,
      };

      mockFindUnique.mockResolvedValue(workspace);

      const result = await runScriptStateMachine.verifyRunning('ws-1');

      expect(result).toBe('IDLE');
      expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('should throw error for non-existent workspace', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(runScriptStateMachine.verifyRunning('non-existent')).rejects.toThrow(
        'Workspace not found: non-existent'
      );
    });
  });

  describe('RunScriptStateMachineError', () => {
    it('should include workspaceId, fromStatus, and toStatus', () => {
      const error = new RunScriptStateMachineError('ws-1', 'IDLE', 'RUNNING');

      expect(error.workspaceId).toBe('ws-1');
      expect(error.fromStatus).toBe('IDLE');
      expect(error.toStatus).toBe('RUNNING');
      expect(error.name).toBe('RunScriptStateMachineError');
    });

    it('should have default message', () => {
      const error = new RunScriptStateMachineError('ws-1', 'IDLE', 'RUNNING');

      expect(error.message).toBe(
        'Invalid run script state transition: IDLE \u2192 RUNNING (workspace: ws-1)'
      );
    });

    it('should accept custom message', () => {
      const error = new RunScriptStateMachineError('ws-1', 'IDLE', 'RUNNING', 'Custom error');

      expect(error.message).toBe('Custom error');
    });
  });

  describe('verifyRunning edge cases', () => {
    it('should handle race condition when markFailed throws', async () => {
      const workspace = {
        id: 'ws-1',
        runScriptStatus: 'RUNNING',
        runScriptPid: 999_999, // Non-existent pid
      };
      const refreshedWorkspace = {
        ...workspace,
        runScriptStatus: 'IDLE',
      };

      // verifyRunning reads workspace: RUNNING with stale pid
      mockFindUnique.mockResolvedValueOnce(workspace);
      // markFailed -> transition reads workspace again
      mockFindUnique.mockResolvedValueOnce(workspace);
      // CAS fails because exit handler already transitioned
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });
      // transition refetches to report conflict
      mockFindUnique.mockResolvedValueOnce({ ...workspace, runScriptStatus: 'IDLE' });
      // verifyRunning catch block refetches to return current state
      mockFindUnique.mockResolvedValueOnce(refreshedWorkspace);

      const result = await runScriptStateMachine.verifyRunning('ws-1');

      // Should return the refreshed status, not throw
      expect(result).toBe('IDLE');
    });

    it('should return RUNNING status when pid is null (no process to verify)', async () => {
      const workspace = {
        id: 'ws-1',
        runScriptStatus: 'RUNNING',
        runScriptPid: null,
      };

      mockFindUnique.mockResolvedValue(workspace);

      const result = await runScriptStateMachine.verifyRunning('ws-1');

      // With null pid, the process check is skipped
      expect(result).toBe('RUNNING');
    });

    it('should return status directly for non-RUNNING states', async () => {
      for (const status of ['IDLE', 'STARTING', 'STOPPING', 'COMPLETED', 'FAILED'] as const) {
        mockFindUnique.mockResolvedValueOnce({
          id: 'ws-1',
          runScriptStatus: status,
          runScriptPid: null,
        });

        const result = await runScriptStateMachine.verifyRunning('ws-1');
        expect(result).toBe(status);
      }
    });
  });

  describe('event emission', () => {
    afterEach(() => {
      runScriptStateMachine.removeAllListeners();
    });

    it('emits run_script_status_changed after successful transition', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'IDLE' };
      const updatedWorkspace = { ...workspace, runScriptStatus: 'STARTING' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const events: RunScriptStatusChangedEvent[] = [];
      runScriptStateMachine.on(RUN_SCRIPT_STATUS_CHANGED, (event: RunScriptStatusChangedEvent) => {
        events.push(event);
      });

      await runScriptStateMachine.transition('ws-1', 'STARTING');

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        workspaceId: 'ws-1',
        fromStatus: 'IDLE',
        toStatus: 'STARTING',
      });
    });

    it('does NOT emit on CAS failure', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'IDLE' };

      mockFindUnique
        .mockResolvedValueOnce(workspace) // initial read
        .mockResolvedValueOnce({ ...workspace, runScriptStatus: 'STARTING' }); // refetch after CAS fail
      mockUpdateMany.mockResolvedValue({ count: 0 });

      const events: RunScriptStatusChangedEvent[] = [];
      runScriptStateMachine.on(RUN_SCRIPT_STATUS_CHANGED, (event: RunScriptStatusChangedEvent) => {
        events.push(event);
      });

      await expect(runScriptStateMachine.transition('ws-1', 'STARTING')).rejects.toThrow(
        RunScriptStateMachineError
      );

      expect(events).toHaveLength(0);
    });

    it('does NOT emit on invalid transition', async () => {
      const workspace = { id: 'ws-1', runScriptStatus: 'IDLE' };
      mockFindUnique.mockResolvedValue(workspace);

      const events: RunScriptStatusChangedEvent[] = [];
      runScriptStateMachine.on(RUN_SCRIPT_STATUS_CHANGED, (event: RunScriptStatusChangedEvent) => {
        events.push(event);
      });

      await expect(runScriptStateMachine.transition('ws-1', 'RUNNING')).rejects.toThrow(
        RunScriptStateMachineError
      );

      expect(events).toHaveLength(0);
    });

    it('emits event for each transition in a multi-step flow', async () => {
      const events: RunScriptStatusChangedEvent[] = [];
      runScriptStateMachine.on(RUN_SCRIPT_STATUS_CHANGED, (event: RunScriptStatusChangedEvent) => {
        events.push(event);
      });

      // Step 1: IDLE -> STARTING
      mockFindUnique.mockResolvedValueOnce({ id: 'ws-1', runScriptStatus: 'IDLE' });
      mockUpdateMany.mockResolvedValueOnce({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValueOnce({ id: 'ws-1', runScriptStatus: 'STARTING' });

      await runScriptStateMachine.transition('ws-1', 'STARTING');

      // Step 2: STARTING -> RUNNING
      mockFindUnique.mockResolvedValueOnce({ id: 'ws-1', runScriptStatus: 'STARTING' });
      mockUpdateMany.mockResolvedValueOnce({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValueOnce({ id: 'ws-1', runScriptStatus: 'RUNNING' });

      await runScriptStateMachine.transition('ws-1', 'RUNNING');

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        workspaceId: 'ws-1',
        fromStatus: 'IDLE',
        toStatus: 'STARTING',
      });
      expect(events[1]).toEqual({
        workspaceId: 'ws-1',
        fromStatus: 'STARTING',
        toStatus: 'RUNNING',
      });
    });
  });

  describe('invalid transitions are exhaustively rejected', () => {
    const invalidTransitions: [string, string][] = [
      ['IDLE', 'RUNNING'],
      ['IDLE', 'STOPPING'],
      ['IDLE', 'COMPLETED'],
      ['IDLE', 'FAILED'],
      ['IDLE', 'IDLE'],
      ['STARTING', 'STARTING'],
      ['STARTING', 'IDLE'],
      ['RUNNING', 'STARTING'],
      ['RUNNING', 'RUNNING'],
      ['RUNNING', 'IDLE'],
      ['STOPPING', 'RUNNING'],
      ['STOPPING', 'STARTING'],
      ['STOPPING', 'STOPPING'],
      ['STOPPING', 'COMPLETED'],
      ['STOPPING', 'FAILED'],
      ['COMPLETED', 'RUNNING'],
      ['COMPLETED', 'STOPPING'],
      ['COMPLETED', 'COMPLETED'],
      ['COMPLETED', 'FAILED'],
      ['FAILED', 'RUNNING'],
      ['FAILED', 'STOPPING'],
      ['FAILED', 'COMPLETED'],
      ['FAILED', 'FAILED'],
    ];

    for (const [from, to] of invalidTransitions) {
      it(`should reject ${from} -> ${to}`, () => {
        expect(runScriptStateMachine.isValidTransition(from as never, to as never)).toBe(false);
      });
    }
  });
});
