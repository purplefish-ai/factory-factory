import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Prisma
const mockFindUnique = vi.fn();
const mockFindUniqueOrThrow = vi.fn();
const mockUpdate = vi.fn();
const mockUpdateMany = vi.fn();

vi.mock('@/backend/db', () => ({
  prisma: {
    workspace: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      findUniqueOrThrow: (...args: unknown[]) => mockFindUniqueOrThrow(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
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
  WORKSPACE_STATE_CHANGED,
  type WorkspaceStateChangedEvent,
  WorkspaceStateMachineError,
  workspaceStateMachine,
} from './state-machine.service';

describe('WorkspaceStateMachineService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isValidTransition', () => {
    it('should allow NEW → PROVISIONING', () => {
      expect(workspaceStateMachine.isValidTransition('NEW', 'PROVISIONING')).toBe(true);
    });

    it('should allow PROVISIONING → READY', () => {
      expect(workspaceStateMachine.isValidTransition('PROVISIONING', 'READY')).toBe(true);
    });

    it('should allow PROVISIONING → FAILED', () => {
      expect(workspaceStateMachine.isValidTransition('PROVISIONING', 'FAILED')).toBe(true);
    });

    it('should allow FAILED → PROVISIONING (retry)', () => {
      expect(workspaceStateMachine.isValidTransition('FAILED', 'PROVISIONING')).toBe(true);
    });

    it('should allow FAILED → ARCHIVING', () => {
      expect(workspaceStateMachine.isValidTransition('FAILED', 'ARCHIVING')).toBe(true);
    });

    it('should allow FAILED → NEW (reset for worktree retry)', () => {
      expect(workspaceStateMachine.isValidTransition('FAILED', 'NEW')).toBe(true);
    });

    it('should allow READY → ARCHIVING', () => {
      expect(workspaceStateMachine.isValidTransition('READY', 'ARCHIVING')).toBe(true);
    });

    it('should allow ARCHIVING → ARCHIVED', () => {
      expect(workspaceStateMachine.isValidTransition('ARCHIVING', 'ARCHIVED')).toBe(true);
    });

    it('should allow ARCHIVING → READY rollback', () => {
      expect(workspaceStateMachine.isValidTransition('ARCHIVING', 'READY')).toBe(true);
    });

    it('should allow ARCHIVING → FAILED rollback', () => {
      expect(workspaceStateMachine.isValidTransition('ARCHIVING', 'FAILED')).toBe(true);
    });

    it('should not allow NEW → READY (skipping PROVISIONING)', () => {
      expect(workspaceStateMachine.isValidTransition('NEW', 'READY')).toBe(false);
    });

    it('should not allow NEW → FAILED (skipping PROVISIONING)', () => {
      expect(workspaceStateMachine.isValidTransition('NEW', 'FAILED')).toBe(false);
    });

    it('should not allow READY → PROVISIONING', () => {
      expect(workspaceStateMachine.isValidTransition('READY', 'PROVISIONING')).toBe(false);
    });

    it('should not allow ARCHIVING → NEW', () => {
      expect(workspaceStateMachine.isValidTransition('ARCHIVING', 'NEW')).toBe(false);
    });

    it('should not allow ARCHIVED → any state', () => {
      expect(workspaceStateMachine.isValidTransition('ARCHIVED', 'NEW')).toBe(false);
      expect(workspaceStateMachine.isValidTransition('ARCHIVED', 'PROVISIONING')).toBe(false);
      expect(workspaceStateMachine.isValidTransition('ARCHIVED', 'READY')).toBe(false);
      expect(workspaceStateMachine.isValidTransition('ARCHIVED', 'FAILED')).toBe(false);
    });

    it('should not allow NEW → ARCHIVED (must go through PROVISIONING first)', () => {
      expect(workspaceStateMachine.isValidTransition('NEW', 'ARCHIVED')).toBe(false);
    });
  });

  describe('transition', () => {
    it('should transition from NEW to PROVISIONING', async () => {
      const workspace = { id: 'ws-1', status: 'NEW' };
      const updatedWorkspace = { ...workspace, status: 'PROVISIONING' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await workspaceStateMachine.transition('ws-1', 'PROVISIONING');

      expect(result.status).toBe('PROVISIONING');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ws-1', status: 'NEW' },
        data: expect.objectContaining({
          status: 'PROVISIONING',
          initStartedAt: expect.any(Date),
          initErrorMessage: null,
        }),
      });
    });

    it('should transition from PROVISIONING to READY with worktreePath', async () => {
      const workspace = { id: 'ws-1', status: 'PROVISIONING' };
      const updatedWorkspace = { ...workspace, status: 'READY', worktreePath: '/path/to/worktree' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await workspaceStateMachine.transition('ws-1', 'READY', {
        worktreePath: '/path/to/worktree',
      });

      expect(result.status).toBe('READY');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ws-1', status: 'PROVISIONING' },
        data: expect.objectContaining({
          status: 'READY',
          initCompletedAt: expect.any(Date),
          worktreePath: '/path/to/worktree',
        }),
      });
    });

    it('should transition from PROVISIONING to FAILED with error message', async () => {
      const workspace = { id: 'ws-1', status: 'PROVISIONING' };
      const updatedWorkspace = {
        ...workspace,
        status: 'FAILED',
        initErrorMessage: 'Git clone failed',
      };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await workspaceStateMachine.transition('ws-1', 'FAILED', {
        errorMessage: 'Git clone failed',
      });

      expect(result.status).toBe('FAILED');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ws-1', status: 'PROVISIONING' },
        data: expect.objectContaining({
          status: 'FAILED',
          initCompletedAt: expect.any(Date),
          initErrorMessage: 'Git clone failed',
        }),
      });
    });

    it('should throw WorkspaceStateMachineError for invalid transition', async () => {
      const workspace = { id: 'ws-1', status: 'NEW' };
      mockFindUnique.mockResolvedValue(workspace);

      await expect(workspaceStateMachine.transition('ws-1', 'READY')).rejects.toThrow(
        WorkspaceStateMachineError
      );

      await expect(workspaceStateMachine.transition('ws-1', 'READY')).rejects.toThrow(
        /Invalid workspace state transition: NEW → READY/
      );
    });

    it('should throw error for non-existent workspace', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(
        workspaceStateMachine.transition('non-existent', 'PROVISIONING')
      ).rejects.toThrow('Workspace not found: non-existent');
    });

    it('should throw error when status changes during transition (CAS failure)', async () => {
      const workspace = { id: 'ws-1', status: 'PROVISIONING' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 0 }); // CAS failed

      await expect(workspaceStateMachine.transition('ws-1', 'READY')).rejects.toThrow(
        WorkspaceStateMachineError
      );

      await expect(workspaceStateMachine.transition('ws-1', 'READY')).rejects.toThrow(
        /Transition failed: status changed by another process/
      );
    });

    it('should prevent race condition: concurrent transitions from same state', async () => {
      // Both callers read PROVISIONING state
      const workspace = { id: 'ws-1', status: 'PROVISIONING' };

      mockFindUnique
        .mockResolvedValueOnce(workspace) // First caller reads PROVISIONING
        .mockResolvedValueOnce(workspace); // Second caller reads PROVISIONING

      mockUpdateMany
        .mockResolvedValueOnce({ count: 1 }) // First updateMany succeeds
        .mockResolvedValueOnce({ count: 0 }); // Second updateMany fails (status already changed)

      mockFindUniqueOrThrow.mockResolvedValueOnce({ ...workspace, status: 'READY' }); // First caller re-reads READY

      // Run transitions in parallel
      const [result1, result2Promise] = await Promise.allSettled([
        workspaceStateMachine.transition('ws-1', 'READY'),
        workspaceStateMachine.transition('ws-1', 'FAILED'),
      ]);

      // First transition should succeed
      expect(result1.status).toBe('fulfilled');
      if (result1.status === 'fulfilled') {
        expect(result1.value.status).toBe('READY');
      }

      // Second transition should fail with CAS error
      expect(result2Promise.status).toBe('rejected');
      if (result2Promise.status === 'rejected') {
        expect(result2Promise.reason).toBeInstanceOf(WorkspaceStateMachineError);
        expect(result2Promise.reason.message).toContain(
          'Transition failed: status changed by another process'
        );
      }

      // Verify that both transitions attempted CAS with the same initial state
      expect(mockUpdateMany).toHaveBeenCalledTimes(2);
      expect(mockUpdateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'ws-1', status: 'PROVISIONING' },
        data: expect.objectContaining({ status: 'READY' }),
      });
      expect(mockUpdateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'ws-1', status: 'PROVISIONING' },
        data: expect.objectContaining({ status: 'FAILED' }),
      });
    });

    it('should transition from READY to ARCHIVING', async () => {
      const workspace = { id: 'ws-1', status: 'READY' };
      const updatedWorkspace = { ...workspace, status: 'ARCHIVING' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await workspaceStateMachine.transition('ws-1', 'ARCHIVING');

      expect(result.status).toBe('ARCHIVING');
    });

    it('should transition from FAILED to ARCHIVING', async () => {
      const workspace = { id: 'ws-1', status: 'FAILED' };
      const updatedWorkspace = { ...workspace, status: 'ARCHIVING' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await workspaceStateMachine.transition('ws-1', 'ARCHIVING');

      expect(result.status).toBe('ARCHIVING');
    });

    it('should transition from ARCHIVING to ARCHIVED', async () => {
      const workspace = { id: 'ws-1', status: 'ARCHIVING' };
      const updatedWorkspace = { ...workspace, status: 'ARCHIVED' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await workspaceStateMachine.transition('ws-1', 'ARCHIVED');

      expect(result.status).toBe('ARCHIVED');
    });

    it('should not set initCompletedAt when rolling back ARCHIVING to READY', async () => {
      const workspace = { id: 'ws-1', status: 'ARCHIVING' };
      const updatedWorkspace = { ...workspace, status: 'READY' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await workspaceStateMachine.transition('ws-1', 'READY');

      expect(result.status).toBe('READY');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ws-1', status: 'ARCHIVING' },
        data: expect.not.objectContaining({
          initCompletedAt: expect.any(Date),
        }),
      });
    });

    it('should not set initCompletedAt when rolling back ARCHIVING to FAILED', async () => {
      const workspace = { id: 'ws-1', status: 'ARCHIVING' };
      const updatedWorkspace = { ...workspace, status: 'FAILED' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await workspaceStateMachine.transition('ws-1', 'FAILED');

      expect(result.status).toBe('FAILED');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ws-1', status: 'ARCHIVING' },
        data: expect.not.objectContaining({
          initCompletedAt: expect.any(Date),
        }),
      });
    });
  });

  describe('startProvisioning', () => {
    it('should transition from NEW to PROVISIONING', async () => {
      const workspace = { id: 'ws-1', status: 'NEW', initRetryCount: 0 };
      const updatedWorkspace = { ...workspace, status: 'PROVISIONING' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await workspaceStateMachine.startProvisioning('ws-1');

      expect(result?.status).toBe('PROVISIONING');
    });

    it('should transition from FAILED to PROVISIONING (retry)', async () => {
      const workspace = { id: 'ws-1', status: 'FAILED', initRetryCount: 1 };
      const updatedWorkspace = { ...workspace, status: 'PROVISIONING', initRetryCount: 2 };

      mockFindUnique
        .mockResolvedValueOnce(workspace) // First call for status check
        .mockResolvedValueOnce(updatedWorkspace); // Second call after updateMany
      mockUpdateMany.mockResolvedValue({ count: 1 });

      const result = await workspaceStateMachine.startProvisioning('ws-1');

      expect(result?.status).toBe('PROVISIONING');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'ws-1',
          status: 'FAILED',
          initRetryCount: { lt: 3 },
        },
        data: expect.objectContaining({
          status: 'PROVISIONING',
          initRetryCount: { increment: 1 },
          initStartedAt: expect.any(Date),
          initErrorMessage: null,
        }),
      });
    });

    it('should return null when max retries exceeded', async () => {
      const workspace = { id: 'ws-1', status: 'FAILED', initRetryCount: 3 };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 0 }); // No update happened

      const result = await workspaceStateMachine.startProvisioning('ws-1');

      expect(result).toBeNull();
    });

    it('should respect custom maxRetries option', async () => {
      const workspace = { id: 'ws-1', status: 'FAILED', initRetryCount: 4 };
      const updatedWorkspace = { ...workspace, status: 'PROVISIONING', initRetryCount: 5 };

      mockFindUnique.mockResolvedValueOnce(workspace).mockResolvedValueOnce(updatedWorkspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });

      const result = await workspaceStateMachine.startProvisioning('ws-1', { maxRetries: 5 });

      expect(result?.status).toBe('PROVISIONING');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          initRetryCount: { lt: 5 },
        }),
        data: expect.any(Object),
      });
    });

    it('should throw error for invalid starting state', async () => {
      const workspace = { id: 'ws-1', status: 'READY' };
      mockFindUnique.mockResolvedValue(workspace);

      await expect(workspaceStateMachine.startProvisioning('ws-1')).rejects.toThrow(
        WorkspaceStateMachineError
      );

      await expect(workspaceStateMachine.startProvisioning('ws-1')).rejects.toThrow(
        /Cannot start provisioning from status: READY/
      );
    });

    it('should throw error for non-existent workspace', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(workspaceStateMachine.startProvisioning('non-existent')).rejects.toThrow(
        'Workspace not found: non-existent'
      );
    });
  });

  describe('markReady', () => {
    it('should transition workspace to READY', async () => {
      const workspace = { id: 'ws-1', status: 'PROVISIONING' };
      const updatedWorkspace = { ...workspace, status: 'READY' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await workspaceStateMachine.markReady('ws-1');

      expect(result.status).toBe('READY');
    });

    it('should accept optional worktreePath and branchName', async () => {
      const workspace = { id: 'ws-1', status: 'PROVISIONING' };
      const updatedWorkspace = {
        ...workspace,
        status: 'READY',
        worktreePath: '/path',
        branchName: 'feature/test',
      };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      await workspaceStateMachine.markReady('ws-1', {
        worktreePath: '/path',
        branchName: 'feature/test',
      });

      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ws-1', status: 'PROVISIONING' },
        data: expect.objectContaining({
          worktreePath: '/path',
          branchName: 'feature/test',
        }),
      });
    });
  });

  describe('markFailed', () => {
    it('should transition workspace to FAILED', async () => {
      const workspace = { id: 'ws-1', status: 'PROVISIONING' };
      const updatedWorkspace = { ...workspace, status: 'FAILED' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await workspaceStateMachine.markFailed('ws-1');

      expect(result.status).toBe('FAILED');
    });

    it('should accept optional error message', async () => {
      const workspace = { id: 'ws-1', status: 'PROVISIONING' };
      const updatedWorkspace = {
        ...workspace,
        status: 'FAILED',
        initErrorMessage: 'Timeout exceeded',
      };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      await workspaceStateMachine.markFailed('ws-1', 'Timeout exceeded');

      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ws-1', status: 'PROVISIONING' },
        data: expect.objectContaining({
          initErrorMessage: 'Timeout exceeded',
        }),
      });
    });
  });

  describe('startArchiving', () => {
    it('should transition workspace to ARCHIVING from READY', async () => {
      const workspace = { id: 'ws-1', status: 'READY' };
      const updatedWorkspace = { ...workspace, status: 'ARCHIVING' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await workspaceStateMachine.startArchiving('ws-1');

      expect(result.status).toBe('ARCHIVING');
    });

    it('should transition workspace to ARCHIVING from FAILED', async () => {
      const workspace = { id: 'ws-1', status: 'FAILED' };
      const updatedWorkspace = { ...workspace, status: 'ARCHIVING' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await workspaceStateMachine.startArchiving('ws-1');

      expect(result.status).toBe('ARCHIVING');
    });

    it('should throw error when trying to start archiving from NEW', async () => {
      const workspace = { id: 'ws-1', status: 'NEW' };
      mockFindUnique.mockResolvedValue(workspace);

      await expect(workspaceStateMachine.startArchiving('ws-1')).rejects.toThrow(
        WorkspaceStateMachineError
      );
    });

    it('should throw error when trying to start archiving from PROVISIONING', async () => {
      const workspace = { id: 'ws-1', status: 'PROVISIONING' };
      mockFindUnique.mockResolvedValue(workspace);

      await expect(workspaceStateMachine.startArchiving('ws-1')).rejects.toThrow(
        WorkspaceStateMachineError
      );
    });
  });

  describe('startArchivingWithSourceStatus', () => {
    it('should return previous READY status when starting archiving', async () => {
      const workspace = { id: 'ws-1', status: 'READY' };
      const updatedWorkspace = { ...workspace, status: 'ARCHIVING' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await workspaceStateMachine.startArchivingWithSourceStatus('ws-1');

      expect(result.previousStatus).toBe('READY');
      expect(result.workspace.status).toBe('ARCHIVING');
    });

    it('should return previous FAILED status when starting archiving', async () => {
      const workspace = { id: 'ws-1', status: 'FAILED' };
      const updatedWorkspace = { ...workspace, status: 'ARCHIVING' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await workspaceStateMachine.startArchivingWithSourceStatus('ws-1');

      expect(result.previousStatus).toBe('FAILED');
      expect(result.workspace.status).toBe('ARCHIVING');
    });

    it('should fail when status changes during start archiving CAS', async () => {
      const workspace = { id: 'ws-1', status: 'READY' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 0 });

      await expect(workspaceStateMachine.startArchivingWithSourceStatus('ws-1')).rejects.toThrow(
        /Transition failed: status changed by another process/
      );
    });
  });

  describe('markArchived', () => {
    it('should transition workspace to ARCHIVED from ARCHIVING', async () => {
      const workspace = { id: 'ws-1', status: 'ARCHIVING' };
      const updatedWorkspace = { ...workspace, status: 'ARCHIVED' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const result = await workspaceStateMachine.markArchived('ws-1');

      expect(result.status).toBe('ARCHIVED');
    });

    it('should throw error when trying to mark archived from READY', async () => {
      const workspace = { id: 'ws-1', status: 'READY' };
      mockFindUnique.mockResolvedValue(workspace);

      await expect(workspaceStateMachine.markArchived('ws-1')).rejects.toThrow(
        WorkspaceStateMachineError
      );
    });
  });

  describe('resetToNew', () => {
    it('should transition from FAILED to NEW', async () => {
      const workspace = { id: 'ws-1', status: 'FAILED', initRetryCount: 1 };
      const updatedWorkspace = { ...workspace, status: 'NEW', initRetryCount: 2 };

      mockFindUnique.mockResolvedValueOnce(workspace).mockResolvedValueOnce(updatedWorkspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });

      const result = await workspaceStateMachine.resetToNew('ws-1');

      expect(result?.status).toBe('NEW');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'ws-1',
          status: 'FAILED',
          initRetryCount: { lt: 3 },
        },
        data: expect.objectContaining({
          status: 'NEW',
          initRetryCount: { increment: 1 },
          initStartedAt: null,
          initCompletedAt: null,
          initErrorMessage: null,
        }),
      });
    });

    it('should return null when max retries exceeded', async () => {
      const workspace = { id: 'ws-1', status: 'FAILED', initRetryCount: 3 };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 0 }); // No update happened

      const result = await workspaceStateMachine.resetToNew('ws-1');

      expect(result).toBeNull();
    });

    it('should respect custom maxRetries option', async () => {
      const workspace = { id: 'ws-1', status: 'FAILED', initRetryCount: 4 };
      const updatedWorkspace = { ...workspace, status: 'NEW', initRetryCount: 5 };

      mockFindUnique.mockResolvedValueOnce(workspace).mockResolvedValueOnce(updatedWorkspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });

      const result = await workspaceStateMachine.resetToNew('ws-1', 5);

      expect(result?.status).toBe('NEW');
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          initRetryCount: { lt: 5 },
        }),
        data: expect.any(Object),
      });
    });

    it('should throw error when status is not FAILED', async () => {
      const workspace = { id: 'ws-1', status: 'READY' };
      mockFindUnique.mockResolvedValue(workspace);

      await expect(workspaceStateMachine.resetToNew('ws-1')).rejects.toThrow(
        WorkspaceStateMachineError
      );

      await expect(workspaceStateMachine.resetToNew('ws-1')).rejects.toThrow(
        /Can only reset to NEW from FAILED status/
      );
    });

    it('should throw error for non-existent workspace', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(workspaceStateMachine.resetToNew('non-existent')).rejects.toThrow(
        'Workspace not found: non-existent'
      );
    });
  });

  describe('event emission', () => {
    afterEach(() => {
      workspaceStateMachine.removeAllListeners();
    });

    it('emits workspace_state_changed after successful transition', async () => {
      const workspace = { id: 'ws-1', status: 'PROVISIONING' };
      const updatedWorkspace = { ...workspace, status: 'READY' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUniqueOrThrow.mockResolvedValue(updatedWorkspace);

      const events: WorkspaceStateChangedEvent[] = [];
      workspaceStateMachine.on(WORKSPACE_STATE_CHANGED, (event: WorkspaceStateChangedEvent) => {
        events.push(event);
      });

      await workspaceStateMachine.transition('ws-1', 'READY');

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        workspaceId: 'ws-1',
        fromStatus: 'PROVISIONING',
        toStatus: 'READY',
      });
    });

    it('does NOT emit on CAS failure', async () => {
      const workspace = { id: 'ws-1', status: 'PROVISIONING' };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 0 });

      const events: WorkspaceStateChangedEvent[] = [];
      workspaceStateMachine.on(WORKSPACE_STATE_CHANGED, (event: WorkspaceStateChangedEvent) => {
        events.push(event);
      });

      await expect(workspaceStateMachine.transition('ws-1', 'READY')).rejects.toThrow(
        WorkspaceStateMachineError
      );

      expect(events).toHaveLength(0);
    });

    it('does NOT emit on invalid transition', async () => {
      const workspace = { id: 'ws-1', status: 'NEW' };
      mockFindUnique.mockResolvedValue(workspace);

      const events: WorkspaceStateChangedEvent[] = [];
      workspaceStateMachine.on(WORKSPACE_STATE_CHANGED, (event: WorkspaceStateChangedEvent) => {
        events.push(event);
      });

      await expect(workspaceStateMachine.transition('ws-1', 'READY')).rejects.toThrow(
        WorkspaceStateMachineError
      );

      expect(events).toHaveLength(0);
    });

    it('emits event on startProvisioning FAILED->PROVISIONING retry', async () => {
      const workspace = { id: 'ws-1', status: 'FAILED', initRetryCount: 0 };
      const updatedWorkspace = { ...workspace, status: 'PROVISIONING', initRetryCount: 1 };

      mockFindUnique
        .mockResolvedValueOnce(workspace) // First call for status check
        .mockResolvedValueOnce(updatedWorkspace); // Second call after updateMany
      mockUpdateMany.mockResolvedValue({ count: 1 });

      const events: WorkspaceStateChangedEvent[] = [];
      workspaceStateMachine.on(WORKSPACE_STATE_CHANGED, (event: WorkspaceStateChangedEvent) => {
        events.push(event);
      });

      await workspaceStateMachine.startProvisioning('ws-1');

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        workspaceId: 'ws-1',
        fromStatus: 'FAILED',
        toStatus: 'PROVISIONING',
      });
    });

    it('does NOT emit on startProvisioning when max retries exceeded', async () => {
      const workspace = { id: 'ws-1', status: 'FAILED', initRetryCount: 3 };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 0 });

      const events: WorkspaceStateChangedEvent[] = [];
      workspaceStateMachine.on(WORKSPACE_STATE_CHANGED, (event: WorkspaceStateChangedEvent) => {
        events.push(event);
      });

      const result = await workspaceStateMachine.startProvisioning('ws-1');

      expect(result).toBeNull();
      expect(events).toHaveLength(0);
    });

    it('emits event on resetToNew', async () => {
      const workspace = { id: 'ws-1', status: 'FAILED', initRetryCount: 1 };
      const updatedWorkspace = { ...workspace, status: 'NEW', initRetryCount: 2 };

      mockFindUnique.mockResolvedValueOnce(workspace).mockResolvedValueOnce(updatedWorkspace);
      mockUpdateMany.mockResolvedValue({ count: 1 });

      const events: WorkspaceStateChangedEvent[] = [];
      workspaceStateMachine.on(WORKSPACE_STATE_CHANGED, (event: WorkspaceStateChangedEvent) => {
        events.push(event);
      });

      await workspaceStateMachine.resetToNew('ws-1');

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        workspaceId: 'ws-1',
        fromStatus: 'FAILED',
        toStatus: 'NEW',
      });
    });

    it('does NOT emit on resetToNew when max retries exceeded', async () => {
      const workspace = { id: 'ws-1', status: 'FAILED', initRetryCount: 3 };

      mockFindUnique.mockResolvedValue(workspace);
      mockUpdateMany.mockResolvedValue({ count: 0 });

      const events: WorkspaceStateChangedEvent[] = [];
      workspaceStateMachine.on(WORKSPACE_STATE_CHANGED, (event: WorkspaceStateChangedEvent) => {
        events.push(event);
      });

      const result = await workspaceStateMachine.resetToNew('ws-1');

      expect(result).toBeNull();
      expect(events).toHaveLength(0);
    });
  });

  describe('WorkspaceStateMachineError', () => {
    it('should include workspaceId, fromStatus, and toStatus', () => {
      const error = new WorkspaceStateMachineError('ws-1', 'NEW', 'READY');

      expect(error.workspaceId).toBe('ws-1');
      expect(error.fromStatus).toBe('NEW');
      expect(error.toStatus).toBe('READY');
      expect(error.name).toBe('WorkspaceStateMachineError');
    });

    it('should have default message', () => {
      const error = new WorkspaceStateMachineError('ws-1', 'NEW', 'READY');

      expect(error.message).toBe(
        'Invalid workspace state transition: NEW → READY (workspace: ws-1)'
      );
    });

    it('should accept custom message', () => {
      const error = new WorkspaceStateMachineError('ws-1', 'NEW', 'READY', 'Custom error');

      expect(error.message).toBe('Custom error');
    });
  });
});
