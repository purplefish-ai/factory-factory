import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Prisma before importing the state machine
const mockUpdateMany = vi.fn();
const mockFindUnique = vi.fn();

vi.mock('../db', () => ({
  prisma: {
    workspace: {
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
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
import type { Workspace, WorkspaceStatus } from '@prisma-gen/client';
import {
  archive,
  completeProvisioning,
  failProvisioning,
  isValidTransition,
  retryProvisioning,
  startProvisioning,
} from './workspace-state-machine';

// Helper to create a mock workspace
function createMockWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'workspace-123',
    projectId: 'project-456',
    name: 'Test Workspace',
    description: null,
    status: 'NEW' as WorkspaceStatus,
    worktreePath: null,
    branchName: null,
    errorMessage: null,
    provisioningStartedAt: null,
    provisioningCompletedAt: null,
    retryCount: 0,
    runScriptCommand: null,
    runScriptCleanupCommand: null,
    runScriptPid: null,
    runScriptPort: null,
    runScriptStartedAt: null,
    runScriptStatus: 'IDLE',
    prUrl: null,
    githubIssueNumber: null,
    githubIssueUrl: null,
    prNumber: null,
    prState: 'NONE',
    prReviewState: null,
    prCiStatus: 'UNKNOWN',
    prUpdatedAt: null,
    hasHadSessions: false,
    cachedKanbanColumn: 'BACKLOG',
    stateComputedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('WorkspaceStateMachine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =============================================================================
  // isValidTransition - pure function tests
  // =============================================================================

  describe('isValidTransition', () => {
    describe('valid transitions', () => {
      it('should allow NEW -> PROVISIONING', () => {
        expect(isValidTransition('NEW', 'PROVISIONING')).toBe(true);
      });

      it('should allow NEW -> ARCHIVED', () => {
        expect(isValidTransition('NEW', 'ARCHIVED')).toBe(true);
      });

      it('should allow PROVISIONING -> READY', () => {
        expect(isValidTransition('PROVISIONING', 'READY')).toBe(true);
      });

      it('should allow PROVISIONING -> FAILED', () => {
        expect(isValidTransition('PROVISIONING', 'FAILED')).toBe(true);
      });

      it('should allow PROVISIONING -> ARCHIVED', () => {
        expect(isValidTransition('PROVISIONING', 'ARCHIVED')).toBe(true);
      });

      it('should allow READY -> ARCHIVED', () => {
        expect(isValidTransition('READY', 'ARCHIVED')).toBe(true);
      });

      it('should allow FAILED -> PROVISIONING', () => {
        expect(isValidTransition('FAILED', 'PROVISIONING')).toBe(true);
      });

      it('should allow FAILED -> ARCHIVED', () => {
        expect(isValidTransition('FAILED', 'ARCHIVED')).toBe(true);
      });
    });

    describe('invalid transitions', () => {
      it('should not allow NEW -> READY', () => {
        expect(isValidTransition('NEW', 'READY')).toBe(false);
      });

      it('should not allow NEW -> FAILED', () => {
        expect(isValidTransition('NEW', 'FAILED')).toBe(false);
      });

      it('should not allow READY -> PROVISIONING', () => {
        expect(isValidTransition('READY', 'PROVISIONING')).toBe(false);
      });

      it('should not allow READY -> NEW', () => {
        expect(isValidTransition('READY', 'NEW')).toBe(false);
      });

      it('should not allow READY -> FAILED', () => {
        expect(isValidTransition('READY', 'FAILED')).toBe(false);
      });

      it('should not allow ARCHIVED -> any state', () => {
        expect(isValidTransition('ARCHIVED', 'NEW')).toBe(false);
        expect(isValidTransition('ARCHIVED', 'PROVISIONING')).toBe(false);
        expect(isValidTransition('ARCHIVED', 'READY')).toBe(false);
        expect(isValidTransition('ARCHIVED', 'FAILED')).toBe(false);
        expect(isValidTransition('ARCHIVED', 'ARCHIVED')).toBe(false);
      });

      it('should not allow self-transitions except for valid cases', () => {
        expect(isValidTransition('NEW', 'NEW')).toBe(false);
        expect(isValidTransition('PROVISIONING', 'PROVISIONING')).toBe(false);
        expect(isValidTransition('READY', 'READY')).toBe(false);
        expect(isValidTransition('FAILED', 'FAILED')).toBe(false);
      });
    });
  });

  // =============================================================================
  // startProvisioning
  // =============================================================================

  describe('startProvisioning', () => {
    it('should transition NEW -> PROVISIONING successfully', async () => {
      const mockWorkspace = createMockWorkspace({ status: 'PROVISIONING' });
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await startProvisioning('workspace-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.workspace.status).toBe('PROVISIONING');
      }
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'workspace-123',
          status: 'NEW',
        },
        data: {
          status: 'PROVISIONING',
          provisioningStartedAt: expect.any(Date),
          errorMessage: null,
        },
      });
    });

    it('should return not_found when workspace does not exist', async () => {
      mockUpdateMany.mockResolvedValue({ count: 0 });
      mockFindUnique.mockResolvedValue(null);

      const result = await startProvisioning('nonexistent-id');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('not_found');
      }
    });

    it('should return wrong_state when workspace is not in NEW state', async () => {
      const mockWorkspace = createMockWorkspace({ status: 'PROVISIONING' });
      mockUpdateMany.mockResolvedValue({ count: 0 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await startProvisioning('workspace-123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('wrong_state');
        expect(result.currentStatus).toBe('PROVISIONING');
      }
    });

    it('should return wrong_state when called on READY workspace', async () => {
      const mockWorkspace = createMockWorkspace({ status: 'READY' });
      mockUpdateMany.mockResolvedValue({ count: 0 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await startProvisioning('workspace-123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('wrong_state');
        expect(result.currentStatus).toBe('READY');
      }
    });
  });

  // =============================================================================
  // completeProvisioning
  // =============================================================================

  describe('completeProvisioning', () => {
    it('should transition PROVISIONING -> READY successfully', async () => {
      const mockWorkspace = createMockWorkspace({ status: 'READY' });
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await completeProvisioning('workspace-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.workspace.status).toBe('READY');
      }
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'workspace-123',
          status: 'PROVISIONING',
        },
        data: {
          status: 'READY',
          provisioningCompletedAt: expect.any(Date),
        },
      });
    });

    it('should update worktreePath and branchName when provided', async () => {
      const mockWorkspace = createMockWorkspace({
        status: 'READY',
        worktreePath: '/path/to/worktree',
        branchName: 'feature/new-branch',
      });
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await completeProvisioning('workspace-123', {
        worktreePath: '/path/to/worktree',
        branchName: 'feature/new-branch',
      });

      expect(result.success).toBe(true);
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'workspace-123',
          status: 'PROVISIONING',
        },
        data: {
          status: 'READY',
          provisioningCompletedAt: expect.any(Date),
          worktreePath: '/path/to/worktree',
          branchName: 'feature/new-branch',
        },
      });
    });

    it('should return not_found when workspace does not exist', async () => {
      mockUpdateMany.mockResolvedValue({ count: 0 });
      mockFindUnique.mockResolvedValue(null);

      const result = await completeProvisioning('nonexistent-id');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('not_found');
      }
    });

    it('should return wrong_state when workspace is in FAILED state', async () => {
      const mockWorkspace = createMockWorkspace({ status: 'FAILED' });
      mockUpdateMany.mockResolvedValue({ count: 0 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await completeProvisioning('workspace-123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('wrong_state');
        expect(result.currentStatus).toBe('FAILED');
      }
    });

    it('should return wrong_state when workspace is in NEW state', async () => {
      const mockWorkspace = createMockWorkspace({ status: 'NEW' });
      mockUpdateMany.mockResolvedValue({ count: 0 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await completeProvisioning('workspace-123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('wrong_state');
        expect(result.currentStatus).toBe('NEW');
      }
    });
  });

  // =============================================================================
  // failProvisioning
  // =============================================================================

  describe('failProvisioning', () => {
    it('should transition PROVISIONING -> FAILED successfully', async () => {
      const mockWorkspace = createMockWorkspace({
        status: 'FAILED',
        errorMessage: 'Git worktree creation failed',
      });
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await failProvisioning('workspace-123', 'Git worktree creation failed');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.workspace.status).toBe('FAILED');
      }
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'workspace-123',
          status: 'PROVISIONING',
        },
        data: {
          status: 'FAILED',
          provisioningCompletedAt: expect.any(Date),
          errorMessage: 'Git worktree creation failed',
        },
      });
    });

    it('should return not_found when workspace does not exist', async () => {
      mockUpdateMany.mockResolvedValue({ count: 0 });
      mockFindUnique.mockResolvedValue(null);

      const result = await failProvisioning('nonexistent-id', 'Error message');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('not_found');
      }
    });

    it('should return wrong_state when workspace is in NEW state', async () => {
      const mockWorkspace = createMockWorkspace({ status: 'NEW' });
      mockUpdateMany.mockResolvedValue({ count: 0 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await failProvisioning('workspace-123', 'Error message');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('wrong_state');
        expect(result.currentStatus).toBe('NEW');
      }
    });
  });

  // =============================================================================
  // retryProvisioning
  // =============================================================================

  describe('retryProvisioning', () => {
    it('should transition FAILED -> PROVISIONING successfully', async () => {
      const mockWorkspace = createMockWorkspace({
        status: 'PROVISIONING',
        retryCount: 1,
      });
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await retryProvisioning('workspace-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.workspace.status).toBe('PROVISIONING');
        expect(result.workspace.retryCount).toBe(1);
      }
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'workspace-123',
          status: 'FAILED',
          retryCount: { lt: 3 },
        },
        data: {
          status: 'PROVISIONING',
          retryCount: { increment: 1 },
          provisioningStartedAt: expect.any(Date),
          errorMessage: null,
        },
      });
    });

    it('should increment retryCount on successful retry', async () => {
      const mockWorkspace = createMockWorkspace({
        status: 'PROVISIONING',
        retryCount: 2,
      });
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await retryProvisioning('workspace-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.workspace.retryCount).toBe(2);
      }
    });

    it('should return not_found when workspace does not exist', async () => {
      mockUpdateMany.mockResolvedValue({ count: 0 });
      mockFindUnique.mockResolvedValue(null);

      const result = await retryProvisioning('nonexistent-id');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('not_found');
      }
    });

    it('should return wrong_state when workspace is not in FAILED state', async () => {
      const mockWorkspace = createMockWorkspace({ status: 'READY' });
      mockUpdateMany.mockResolvedValue({ count: 0 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await retryProvisioning('workspace-123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('wrong_state');
        expect(result.currentStatus).toBe('READY');
      }
    });

    it('should return wrong_state when workspace is in NEW state', async () => {
      const mockWorkspace = createMockWorkspace({ status: 'NEW' });
      mockUpdateMany.mockResolvedValue({ count: 0 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await retryProvisioning('workspace-123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('wrong_state');
        expect(result.currentStatus).toBe('NEW');
      }
    });

    it('should return max_retries_exceeded when retryCount >= maxRetries', async () => {
      const mockWorkspace = createMockWorkspace({
        status: 'FAILED',
        retryCount: 3,
      });
      mockUpdateMany.mockResolvedValue({ count: 0 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await retryProvisioning('workspace-123', 3);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('max_retries_exceeded');
        expect(result.currentStatus).toBe('FAILED');
      }
    });

    it('should respect custom maxRetries parameter', async () => {
      const mockWorkspace = createMockWorkspace({
        status: 'PROVISIONING',
        retryCount: 5,
      });
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await retryProvisioning('workspace-123', 10);

      expect(result.success).toBe(true);
      expect(mockUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            retryCount: { lt: 10 },
          }),
        })
      );
    });

    it('should fail with max_retries_exceeded when retryCount equals maxRetries', async () => {
      const mockWorkspace = createMockWorkspace({
        status: 'FAILED',
        retryCount: 5,
      });
      mockUpdateMany.mockResolvedValue({ count: 0 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await retryProvisioning('workspace-123', 5);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('max_retries_exceeded');
      }
    });
  });

  // =============================================================================
  // archive
  // =============================================================================

  describe('archive', () => {
    it('should transition NEW -> ARCHIVED successfully', async () => {
      const mockWorkspace = createMockWorkspace({ status: 'ARCHIVED' });
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await archive('workspace-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.workspace.status).toBe('ARCHIVED');
      }
    });

    it('should transition PROVISIONING -> ARCHIVED successfully', async () => {
      const mockWorkspace = createMockWorkspace({ status: 'ARCHIVED' });
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await archive('workspace-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.workspace.status).toBe('ARCHIVED');
      }
    });

    it('should transition READY -> ARCHIVED successfully', async () => {
      const mockWorkspace = createMockWorkspace({ status: 'ARCHIVED' });
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await archive('workspace-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.workspace.status).toBe('ARCHIVED');
      }
    });

    it('should transition FAILED -> ARCHIVED successfully', async () => {
      const mockWorkspace = createMockWorkspace({ status: 'ARCHIVED' });
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await archive('workspace-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.workspace.status).toBe('ARCHIVED');
      }
    });

    it('should accept any non-ARCHIVED status', async () => {
      const mockWorkspace = createMockWorkspace({ status: 'ARCHIVED' });
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      await archive('workspace-123');

      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'workspace-123',
          status: { in: ['NEW', 'PROVISIONING', 'READY', 'FAILED'] },
        },
        data: {
          status: 'ARCHIVED',
        },
      });
    });

    it('should return not_found when workspace does not exist', async () => {
      mockUpdateMany.mockResolvedValue({ count: 0 });
      mockFindUnique.mockResolvedValue(null);

      const result = await archive('nonexistent-id');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('not_found');
      }
    });

    it('should return wrong_state when workspace is already ARCHIVED', async () => {
      const mockWorkspace = createMockWorkspace({ status: 'ARCHIVED' });
      mockUpdateMany.mockResolvedValue({ count: 0 });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      const result = await archive('workspace-123');

      expect(result.success).toBe(false);
      if (!result.success) {
        // Note: Returns 'wrong_state' because ARCHIVED is not in the expected
        // from-states ['NEW', 'PROVISIONING', 'READY', 'FAILED'], even though
        // ARCHIVED -> ARCHIVED would also be an invalid transition
        expect(result.reason).toBe('wrong_state');
        expect(result.currentStatus).toBe('ARCHIVED');
      }
    });
  });

  // =============================================================================
  // Edge cases and race conditions
  // =============================================================================

  describe('edge cases', () => {
    it('should handle workspace disappearing between update and fetch', async () => {
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockFindUnique.mockResolvedValue(null);

      const result = await startProvisioning('workspace-123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('not_found');
      }
    });

    it('should handle concurrent update attempts (atomic operation)', async () => {
      // First attempt succeeds
      mockUpdateMany.mockResolvedValueOnce({ count: 1 });

      // Second attempt fails due to state change
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });

      const mockWorkspace = createMockWorkspace({ status: 'PROVISIONING' });
      mockFindUnique.mockResolvedValue(mockWorkspace);

      // First call succeeds
      const result1 = await startProvisioning('workspace-123');
      expect(result1.success).toBe(true);

      // Second call fails with wrong_state
      const result2 = await startProvisioning('workspace-123');
      expect(result2.success).toBe(false);
      if (!result2.success) {
        expect(result2.reason).toBe('wrong_state');
      }
    });
  });
});
