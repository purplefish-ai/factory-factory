import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Prisma
const mockFindMany = vi.fn();
const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@/backend/db', () => ({
  prisma: {
    workspace: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
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

// Mock initializeWorkspaceWorktree
const mockInitializeWorkspaceWorktree = vi.fn();
vi.mock('@/backend/orchestration', () => ({
  initializeWorkspaceWorktree: (...args: unknown[]) => mockInitializeWorkspaceWorktree(...args),
}));

// Import after mocks are set up
import { workspaceAccessor } from '@/backend/resource_accessors/index';
import { reconciliationService } from './reconciliation.service';

describe('ReconciliationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('reconcile', () => {
    it('should initialize NEW workspaces', async () => {
      const newWorkspace = {
        id: 'ws-1',
        status: 'NEW',
        branchName: 'feature/test',
        project: { id: 'proj-1' },
      };

      mockFindMany.mockResolvedValue([newWorkspace]);
      mockInitializeWorkspaceWorktree.mockResolvedValue(undefined);

      await reconciliationService.reconcile();

      expect(mockInitializeWorkspaceWorktree).toHaveBeenCalledWith('ws-1', {
        branchName: 'feature/test',
      });
    });

    it('should mark stale PROVISIONING workspaces as FAILED', async () => {
      const now = new Date('2024-01-15T12:00:00Z');
      vi.setSystemTime(now);

      // Workspace that started provisioning 15 minutes ago (stale)
      const staleWorkspace = {
        id: 'ws-2',
        status: 'PROVISIONING',
        branchName: 'feature/stale',
        initStartedAt: new Date('2024-01-15T11:40:00Z'), // 20 minutes ago
        project: { id: 'proj-1' },
      };

      mockFindMany.mockResolvedValue([staleWorkspace]);
      mockFindUnique.mockResolvedValue(staleWorkspace);
      mockUpdate.mockResolvedValue({ ...staleWorkspace, status: 'FAILED' });

      await reconciliationService.reconcile();

      // Should NOT call initializeWorkspaceWorktree for stale PROVISIONING
      expect(mockInitializeWorkspaceWorktree).not.toHaveBeenCalled();

      // Should transition to FAILED via state machine
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'ws-2' },
        data: expect.objectContaining({
          status: 'FAILED',
          initErrorMessage: expect.stringContaining('timed out'),
        }),
      });
    });

    it('should handle mixed NEW and stale PROVISIONING workspaces', async () => {
      const now = new Date('2024-01-15T12:00:00Z');
      vi.setSystemTime(now);

      const newWorkspace = {
        id: 'ws-1',
        status: 'NEW',
        branchName: 'feature/new',
        project: { id: 'proj-1' },
      };

      const staleWorkspace = {
        id: 'ws-2',
        status: 'PROVISIONING',
        branchName: 'feature/stale',
        initStartedAt: new Date('2024-01-15T11:40:00Z'),
        project: { id: 'proj-1' },
      };

      mockFindMany.mockResolvedValue([newWorkspace, staleWorkspace]);
      mockFindUnique.mockResolvedValue(staleWorkspace);
      mockUpdate.mockResolvedValue({ ...staleWorkspace, status: 'FAILED' });
      mockInitializeWorkspaceWorktree.mockResolvedValue(undefined);

      await reconciliationService.reconcile();

      // NEW workspace should be initialized
      expect(mockInitializeWorkspaceWorktree).toHaveBeenCalledWith('ws-1', {
        branchName: 'feature/new',
      });

      // Stale PROVISIONING should be marked as FAILED
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'ws-2' },
        data: expect.objectContaining({
          status: 'FAILED',
        }),
      });
    });

    it('should handle errors gracefully when initializing NEW workspaces', async () => {
      const newWorkspace = {
        id: 'ws-1',
        status: 'NEW',
        branchName: 'feature/test',
        project: { id: 'proj-1' },
      };

      mockFindMany.mockResolvedValue([newWorkspace]);
      mockInitializeWorkspaceWorktree.mockRejectedValue(new Error('Git clone failed'));

      // Should not throw
      await expect(reconciliationService.reconcile()).resolves.not.toThrow();
    });

    it('should handle errors gracefully when marking stale workspaces as failed', async () => {
      const now = new Date('2024-01-15T12:00:00Z');
      vi.setSystemTime(now);

      const staleWorkspace = {
        id: 'ws-2',
        status: 'PROVISIONING',
        branchName: 'feature/stale',
        initStartedAt: new Date('2024-01-15T11:40:00Z'),
        project: { id: 'proj-1' },
      };

      mockFindMany.mockResolvedValue([staleWorkspace]);
      mockFindUnique.mockRejectedValue(new Error('Database error'));

      // Should not throw
      await expect(reconciliationService.reconcile()).resolves.not.toThrow();
    });
  });
});

describe('workspaceAccessor.findNeedingWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return NEW workspaces', async () => {
    const now = new Date('2024-01-15T12:00:00Z');
    vi.setSystemTime(now);

    const newWorkspace = {
      id: 'ws-1',
      status: 'NEW',
      project: { id: 'proj-1' },
    };

    mockFindMany.mockResolvedValue([newWorkspace]);

    const result = await workspaceAccessor.findNeedingWorktree();

    expect(result).toContainEqual(newWorkspace);
    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { status: 'NEW' },
          {
            status: 'PROVISIONING',
            initStartedAt: { lt: expect.any(Date) },
          },
        ],
      },
      include: { project: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('should return stale PROVISIONING workspaces (>10 minutes)', async () => {
    const now = new Date('2024-01-15T12:00:00Z');
    vi.setSystemTime(now);

    const staleWorkspace = {
      id: 'ws-2',
      status: 'PROVISIONING',
      initStartedAt: new Date('2024-01-15T11:40:00Z'), // 20 minutes ago
      project: { id: 'proj-1' },
    };

    mockFindMany.mockResolvedValue([staleWorkspace]);

    const result = await workspaceAccessor.findNeedingWorktree();

    expect(result).toContainEqual(staleWorkspace);

    // Verify the threshold calculation
    const callArgs = mockFindMany.mock.calls[0]![0];
    const threshold = callArgs.where.OR[1].initStartedAt.lt;
    expect(threshold.getTime()).toBe(now.getTime() - 10 * 60 * 1000);
  });

  it('should NOT return recent PROVISIONING workspaces (<10 minutes)', async () => {
    const now = new Date('2024-01-15T12:00:00Z');
    vi.setSystemTime(now);

    // This workspace started 5 minutes ago - should NOT be returned
    // (The filtering is done by Prisma, so we just verify the query is correct)
    mockFindMany.mockResolvedValue([]);

    const result = await workspaceAccessor.findNeedingWorktree();

    expect(result).toEqual([]);

    // Verify the threshold is 10 minutes ago
    const callArgs = mockFindMany.mock.calls[0]![0];
    const threshold = callArgs.where.OR[1].initStartedAt.lt;
    const expectedThreshold = new Date(now.getTime() - 10 * 60 * 1000);
    expect(threshold.getTime()).toBe(expectedThreshold.getTime());
  });
});

describe('workspaceAccessor.findByProjectIdWithSessions filter validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw error when both status and excludeStatuses are specified', () => {
    expect(() =>
      workspaceAccessor.findByProjectIdWithSessions('proj-1', {
        status: 'READY',
        excludeStatuses: ['ARCHIVED'],
      })
    ).toThrow('Cannot specify both status and excludeStatuses filters');
  });

  it('should allow status filter alone', async () => {
    mockFindMany.mockResolvedValue([]);

    await expect(
      workspaceAccessor.findByProjectIdWithSessions('proj-1', {
        status: 'READY',
      })
    ).resolves.not.toThrow();

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: 'proj-1',
          status: 'READY',
        }),
      })
    );
  });

  it('should allow excludeStatuses filter alone', async () => {
    mockFindMany.mockResolvedValue([]);

    await expect(
      workspaceAccessor.findByProjectIdWithSessions('proj-1', {
        excludeStatuses: ['ARCHIVED'],
      })
    ).resolves.not.toThrow();

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: 'proj-1',
          status: { notIn: ['ARCHIVED'] },
        }),
      })
    );
  });

  it('should work with no filters', async () => {
    mockFindMany.mockResolvedValue([]);

    await expect(workspaceAccessor.findByProjectIdWithSessions('proj-1')).resolves.not.toThrow();

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'proj-1' },
      })
    );
  });
});
