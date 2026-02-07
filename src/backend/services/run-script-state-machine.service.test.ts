import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Prisma
const mockFindUnique = vi.fn();
const mockUpdateMany = vi.fn();
const mockFindUniqueOrThrow = vi.fn();

vi.mock('../db', () => ({
  prisma: {
    workspace: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
      findUniqueOrThrow: (...args: unknown[]) => mockFindUniqueOrThrow(...args),
    },
  },
}));

vi.mock('./logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import after mocks are set up
import {
  RunScriptStateMachineError,
  runScriptStateMachine,
} from './run-script-state-machine.service';

describe('RunScriptStateMachineService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isValidTransition', () => {
    it('should allow IDLE → STARTING', () => {
      expect(runScriptStateMachine.isValidTransition('IDLE', 'STARTING')).toBe(true);
    });

    it('should allow STARTING → RUNNING', () => {
      expect(runScriptStateMachine.isValidTransition('STARTING', 'RUNNING')).toBe(true);
    });

    it('should allow STARTING → FAILED', () => {
      expect(runScriptStateMachine.isValidTransition('STARTING', 'FAILED')).toBe(true);
    });

    it('should allow STARTING → COMPLETED (fast process exit with code 0)', () => {
      expect(runScriptStateMachine.isValidTransition('STARTING', 'COMPLETED')).toBe(true);
    });

    it('should allow STARTING → STOPPING', () => {
      expect(runScriptStateMachine.isValidTransition('STARTING', 'STOPPING')).toBe(true);
    });

    it('should allow RUNNING → STOPPING', () => {
      expect(runScriptStateMachine.isValidTransition('RUNNING', 'STOPPING')).toBe(true);
    });

    it('should allow RUNNING → COMPLETED', () => {
      expect(runScriptStateMachine.isValidTransition('RUNNING', 'COMPLETED')).toBe(true);
    });

    it('should allow RUNNING → FAILED', () => {
      expect(runScriptStateMachine.isValidTransition('RUNNING', 'FAILED')).toBe(true);
    });

    it('should allow STOPPING → IDLE', () => {
      expect(runScriptStateMachine.isValidTransition('STOPPING', 'IDLE')).toBe(true);
    });

    it('should allow COMPLETED → IDLE', () => {
      expect(runScriptStateMachine.isValidTransition('COMPLETED', 'IDLE')).toBe(true);
    });

    it('should allow COMPLETED → STARTING (restart)', () => {
      expect(runScriptStateMachine.isValidTransition('COMPLETED', 'STARTING')).toBe(true);
    });

    it('should allow FAILED → IDLE', () => {
      expect(runScriptStateMachine.isValidTransition('FAILED', 'IDLE')).toBe(true);
    });

    it('should allow FAILED → STARTING (restart)', () => {
      expect(runScriptStateMachine.isValidTransition('FAILED', 'STARTING')).toBe(true);
    });

    it('should not allow IDLE → RUNNING (skipping STARTING)', () => {
      expect(runScriptStateMachine.isValidTransition('IDLE', 'RUNNING')).toBe(false);
    });

    it('should allow STARTING → STOPPING (for stop during startup)', () => {
      expect(runScriptStateMachine.isValidTransition('STARTING', 'STOPPING')).toBe(true);
    });

    it('should not allow STOPPING → RUNNING', () => {
      expect(runScriptStateMachine.isValidTransition('STOPPING', 'RUNNING')).toBe(false);
    });

    it('should not allow COMPLETED → RUNNING', () => {
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
        /Invalid run script state transition: IDLE → RUNNING/
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
        'Invalid run script state transition: IDLE → RUNNING (workspace: ws-1)'
      );
    });

    it('should accept custom message', () => {
      const error = new RunScriptStateMachineError('ws-1', 'IDLE', 'RUNNING', 'Custom error');

      expect(error.message).toBe('Custom error');
    });
  });
});
