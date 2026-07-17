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

vi.mock('@/backend/services/terminal', () => ({
  terminalSessionService: {
    recoverOrphanedSessions: vi.fn(async () => 0),
  },
}));

const mockInitializeWorktree = vi.fn();

import { terminalSessionService } from '@/backend/services/terminal';
// Import after mocks are set up
import { workspaceMaintenanceService } from '@/backend/services/workspace';
import { reconciliationService } from './reconciliation.service';

describe('ReconciliationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    reconciliationService.configure({
      workspace: {
        markFailed: async (workspaceId: string, reason: string) => {
          const current = await mockFindUnique({ where: { id: workspaceId } });
          if (!current) {
            throw new Error('Not found');
          }
          await mockUpdate({
            where: { id: workspaceId },
            data: { status: 'FAILED', initErrorMessage: reason },
          });
        },
        initializeWorktree: (...args: unknown[]) => mockInitializeWorktree(...args),
        findNeedingWorktree: () => workspaceMaintenanceService.findNeedingWorktree(),
      },
      terminal: {
        recoverOrphanedSessions: () => terminalSessionService.recoverOrphanedSessions(),
      },
    });
  });

  afterEach(async () => {
    await reconciliationService.stopPeriodicCleanup();
    vi.restoreAllMocks();
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
      mockInitializeWorktree.mockResolvedValue(undefined);

      await reconciliationService.reconcile();

      expect(mockInitializeWorktree).toHaveBeenCalledWith('ws-1', {
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
        initScriptPid: null,
        project: { id: 'proj-1' },
      };

      mockFindMany.mockResolvedValue([staleWorkspace]);
      mockFindUnique.mockResolvedValue(staleWorkspace);
      mockUpdate.mockResolvedValue({ ...staleWorkspace, status: 'FAILED' });

      await reconciliationService.reconcile();

      // Should NOT call initializeWorktree for stale PROVISIONING
      expect(mockInitializeWorktree).not.toHaveBeenCalled();

      // Should transition to FAILED via state machine
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'ws-2' },
        data: expect.objectContaining({
          status: 'FAILED',
          initErrorMessage: expect.stringContaining('timed out'),
        }),
      });
    });

    it('should not fail stale PROVISIONING workspaces while init script PID is running', async () => {
      const staleWorkspace = {
        id: 'ws-running',
        status: 'PROVISIONING',
        branchName: 'feature/slow-startup',
        initStartedAt: new Date('2024-01-15T11:40:00Z'),
        initScriptPid: 12_345,
        project: { id: 'proj-1' },
      };

      mockFindMany.mockResolvedValue([staleWorkspace]);
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

      await reconciliationService.reconcile();

      expect(killSpy).toHaveBeenCalledWith(12_345, 0);
      expect(mockInitializeWorktree).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('should fail stale PROVISIONING workspaces when init script PID is not running', async () => {
      const staleWorkspace = {
        id: 'ws-dead',
        status: 'PROVISIONING',
        branchName: 'feature/dead-startup',
        initStartedAt: new Date('2024-01-15T11:40:00Z'),
        initScriptPid: 12_345,
        project: { id: 'proj-1' },
      };

      mockFindMany.mockResolvedValue([staleWorkspace]);
      mockFindUnique.mockResolvedValue(staleWorkspace);
      mockUpdate.mockResolvedValue({ ...staleWorkspace, status: 'FAILED' });
      vi.spyOn(process, 'kill').mockImplementation(() => {
        const error = new Error('No such process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      });

      await reconciliationService.reconcile();

      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'ws-dead' },
        data: expect.objectContaining({
          status: 'FAILED',
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
        initScriptPid: null,
        project: { id: 'proj-1' },
      };

      mockFindMany.mockResolvedValue([newWorkspace, staleWorkspace]);
      mockFindUnique.mockResolvedValue(staleWorkspace);
      mockUpdate.mockResolvedValue({ ...staleWorkspace, status: 'FAILED' });
      mockInitializeWorktree.mockResolvedValue(undefined);

      await reconciliationService.reconcile();

      // NEW workspace should be initialized
      expect(mockInitializeWorktree).toHaveBeenCalledWith('ws-1', {
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
      mockInitializeWorktree.mockRejectedValue(new Error('Git clone failed'));

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
        initScriptPid: null,
        project: { id: 'proj-1' },
      };

      mockFindMany.mockResolvedValue([staleWorkspace]);
      mockFindUnique.mockRejectedValue(new Error('Database error'));

      // Should not throw
      await expect(reconciliationService.reconcile()).resolves.not.toThrow();
    });
  });

  describe('periodic cleanup', () => {
    it('runs workspace reconciliation and orphan cleanup on the periodic timer', async () => {
      mockFindMany.mockResolvedValue([]);
      const cleanupSpy = vi.spyOn(reconciliationService, 'cleanupOrphans').mockResolvedValue();

      reconciliationService.startPeriodicCleanup();
      await vi.advanceTimersToNextTimerAsync();

      expect(mockFindMany).toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
    });

    it('still runs orphan cleanup when workspace reconciliation fails', async () => {
      vi.spyOn(reconciliationService, 'reconcile').mockRejectedValue(new Error('reconcile failed'));
      const cleanupSpy = vi.spyOn(reconciliationService, 'cleanupOrphans').mockResolvedValue();

      reconciliationService.startPeriodicCleanup();
      await vi.advanceTimersToNextTimerAsync();

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
    });

    it('preserves the reconciliation error when orphan cleanup also fails', async () => {
      vi.spyOn(reconciliationService, 'reconcile').mockRejectedValue(new Error('reconcile failed'));
      const cleanupSpy = vi
        .spyOn(reconciliationService, 'cleanupOrphans')
        .mockRejectedValue(new Error('cleanup failed'));
      const runPeriodicReconciliation = Reflect.get(
        reconciliationService,
        'runPeriodicReconciliation'
      ) as () => Promise<void>;

      await expect(runPeriodicReconciliation.call(reconciliationService)).rejects.toThrow(
        'reconcile failed'
      );
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
    });

    it('preserves falsy reconciliation errors after orphan cleanup runs', async () => {
      vi.spyOn(reconciliationService, 'reconcile').mockRejectedValue(undefined);
      const cleanupSpy = vi.spyOn(reconciliationService, 'cleanupOrphans').mockResolvedValue();
      const runPeriodicReconciliation = Reflect.get(
        reconciliationService,
        'runPeriodicReconciliation'
      ) as () => Promise<void>;

      await expect(runPeriodicReconciliation.call(reconciliationService)).rejects.toBeUndefined();
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
    });

    it('does not start overlapping reconciliation runs while one is in progress', async () => {
      const releaseReconciliation: { current: (() => void) | null } = { current: null };
      const reconciliationSpy = vi
        .spyOn(reconciliationService, 'reconcile')
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              releaseReconciliation.current = () => resolve();
            })
        )
        .mockResolvedValue(undefined);
      vi.spyOn(reconciliationService, 'cleanupOrphans').mockResolvedValue();

      reconciliationService.startPeriodicCleanup();
      await vi.advanceTimersToNextTimerAsync();
      await vi.advanceTimersToNextTimerAsync();

      expect(reconciliationSpy).toHaveBeenCalledTimes(1);

      if (releaseReconciliation.current) {
        releaseReconciliation.current();
      }
      await Promise.resolve();
      await vi.advanceTimersToNextTimerAsync();

      expect(reconciliationSpy).toHaveBeenCalledTimes(2);
    });

    it('waits for in-flight reconciliation before stopping', async () => {
      const releaseReconciliation: { current: (() => void) | null } = { current: null };
      const reconciliationSpy = vi
        .spyOn(reconciliationService, 'reconcile')
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              releaseReconciliation.current = () => resolve();
            })
        )
        .mockResolvedValue(undefined);
      vi.spyOn(reconciliationService, 'cleanupOrphans').mockResolvedValue();

      reconciliationService.startPeriodicCleanup();
      await vi.advanceTimersToNextTimerAsync();

      let stopped = false;
      const stopPromise = reconciliationService.stopPeriodicCleanup().then(() => {
        stopped = true;
      });

      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(reconciliationSpy).toHaveBeenCalledTimes(1);

      if (releaseReconciliation.current) {
        releaseReconciliation.current();
      }
      await stopPromise;
      expect(stopped).toBe(true);
      expect(reconciliationSpy).toHaveBeenCalledTimes(1);
    });
  });
});

describe('workspaceMaintenanceService.findNeedingWorktree', () => {
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

    const result = await workspaceMaintenanceService.findNeedingWorktree();

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

    const result = await workspaceMaintenanceService.findNeedingWorktree();

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

    const result = await workspaceMaintenanceService.findNeedingWorktree();

    expect(result).toEqual([]);

    // Verify the threshold is 10 minutes ago
    const callArgs = mockFindMany.mock.calls[0]![0];
    const threshold = callArgs.where.OR[1].initStartedAt.lt;
    const expectedThreshold = new Date(now.getTime() - 10 * 60 * 1000);
    expect(threshold.getTime()).toBe(expectedThreshold.getTime());
  });
});
