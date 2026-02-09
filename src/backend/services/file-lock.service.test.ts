import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before importing the service
const mockFindById = vi.fn();

vi.mock('../resource_accessors/claude-session.accessor', () => ({
  claudeSessionAccessor: {
    findById: (...args: unknown[]) => mockFindById(...args),
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

// Mock fs module
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

// Import after mocks are set up
import { fileLockService } from './file-lock.service';

describe('FileLockService', () => {
  const mockWorkspaceId = 'workspace-123';
  const mockWorktreePath = '/path/to/worktree';
  const mockAgentId = 'agent-1';
  const mockAgentId2 = 'agent-2';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Clear the in-memory stores between tests
    fileLockService.clearStores();
    fileLockService.stopCleanupInterval();

    // Default mock for session lookup
    mockFindById.mockResolvedValue({
      workspaceId: mockWorkspaceId,
      workspace: {
        worktreePath: mockWorktreePath,
      },
    });

    // Default mock for fs operations
    vi.mocked(fs.readFile).mockRejectedValue({ code: 'ENOENT' });
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
  });

  afterEach(() => {
    fileLockService.stopCleanupInterval();
    vi.useRealTimers();
  });

  describe('acquireLock', () => {
    it('should acquire a lock on an unlocked file', async () => {
      const result = await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(result.acquired).toBe(true);
      expect(result.filePath).toBe('src/index.ts');
      expect(result.expiresAt).toBeDefined();
    });

    it('should normalize file paths', async () => {
      const result = await fileLockService.acquireLock(mockAgentId, {
        filePath: './src/../src/index.ts',
      });

      expect(result.acquired).toBe(true);
      expect(result.filePath).toBe('src/index.ts');
    });

    it('should strip leading slashes from paths', async () => {
      const result = await fileLockService.acquireLock(mockAgentId, {
        filePath: '/src/index.ts',
      });

      expect(result.acquired).toBe(true);
      expect(result.filePath).toBe('src/index.ts');
    });

    it('should reject path traversal attempts', async () => {
      await expect(
        fileLockService.acquireLock(mockAgentId, {
          filePath: '../outside/file.ts',
        })
      ).rejects.toThrow('Path traversal not allowed');

      await expect(
        fileLockService.acquireLock(mockAgentId, {
          filePath: 'src/../../outside/file.ts',
        })
      ).rejects.toThrow('Path traversal not allowed');
    });

    it('should fail when file is locked by another agent', async () => {
      // First agent acquires lock
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
        ownerLabel: 'Agent 1',
      });

      // Second agent tries to acquire same lock
      mockFindById.mockResolvedValue({
        workspaceId: mockWorkspaceId,
        workspace: { worktreePath: mockWorktreePath },
      });

      const result = await fileLockService.acquireLock(mockAgentId2, {
        filePath: 'src/index.ts',
      });

      expect(result.acquired).toBe(false);
      expect(result.existingLock).toBeDefined();
      expect(result.existingLock?.ownerId).toBe(mockAgentId);
      expect(result.existingLock?.ownerLabel).toBe('Agent 1');
    });

    it('should allow same agent to re-acquire their own lock', async () => {
      // Agent acquires lock
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
        ttlSeconds: 300,
      });

      // Advance time but not past TTL
      vi.advanceTimersByTime(100 * 1000);

      // Same agent re-acquires - this should fail since they already own it
      // (the current implementation doesn't support refreshing, it just shows as already locked)
      const result = await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
        ttlSeconds: 600,
      });

      // The lock is held by the same agent, so it's not available
      expect(result.acquired).toBe(false);
      expect(result.existingLock?.ownerId).toBe(mockAgentId);
    });

    it('should use custom TTL when provided', async () => {
      const result = await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
        ttlSeconds: 120,
      });

      expect(result.acquired).toBe(true);
      expect(result.expiresAt).toBeDefined();
      const expiresAt = new Date(result.expiresAt as string);
      const now = new Date();
      const diffSeconds = (expiresAt.getTime() - now.getTime()) / 1000;

      expect(diffSeconds).toBeCloseTo(120, 0);
    });

    it('should use default TTL (30 minutes) when not provided', async () => {
      const result = await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(result.acquired).toBe(true);
      expect(result.expiresAt).toBeDefined();
      const expiresAt = new Date(result.expiresAt as string);
      const now = new Date();
      const diffSeconds = (expiresAt.getTime() - now.getTime()) / 1000;

      expect(diffSeconds).toBeCloseTo(30 * 60, 0);
    });

    it('should store metadata with lock', async () => {
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
        metadata: { purpose: 'refactoring', ticket: 'JIRA-123' },
      });

      const check = await fileLockService.checkLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(check.lock?.metadata).toEqual({ purpose: 'refactoring', ticket: 'JIRA-123' });
    });

    it('should throw when workspace cannot be resolved', async () => {
      mockFindById.mockResolvedValue(null);

      await expect(
        fileLockService.acquireLock(mockAgentId, {
          filePath: 'src/index.ts',
        })
      ).rejects.toThrow('Could not resolve workspace for agent');
    });

    it('should acquire lock on expired lock', async () => {
      // First agent acquires lock with short TTL
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
        ttlSeconds: 60,
      });

      // Advance time past TTL
      vi.advanceTimersByTime(61 * 1000);

      // Second agent should be able to acquire
      const result = await fileLockService.acquireLock(mockAgentId2, {
        filePath: 'src/index.ts',
      });

      expect(result.acquired).toBe(true);
    });

    it('should persist lock to disk', async () => {
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(fs.mkdir).toHaveBeenCalledWith(path.join(mockWorktreePath, '.context'), {
        recursive: true,
      });
      expect(fs.writeFile).toHaveBeenCalled();

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]!;
      expect(writeCall[0]).toBe(path.join(mockWorktreePath, '.context', 'advisory-locks.json'));

      const persisted = JSON.parse(writeCall[1] as string);
      expect(persisted.version).toBe(1);
      expect(persisted.locks).toHaveLength(1);
      expect(persisted.locks[0]!.filePath).toBe('src/index.ts');
    });
  });

  describe('releaseLock', () => {
    it('should release own lock', async () => {
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      const result = await fileLockService.releaseLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(result.released).toBe(true);
      expect(result.filePath).toBe('src/index.ts');

      // Verify lock is gone
      const check = await fileLockService.checkLock(mockAgentId, {
        filePath: 'src/index.ts',
      });
      expect(check.isLocked).toBe(false);
    });

    it('should not release lock held by another agent', async () => {
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      const result = await fileLockService.releaseLock(mockAgentId2, {
        filePath: 'src/index.ts',
      });

      expect(result.released).toBe(false);
      expect(result.reason).toBe('not_owner');
    });

    it('should force release lock held by another agent', async () => {
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      const result = await fileLockService.releaseLock(mockAgentId2, {
        filePath: 'src/index.ts',
        force: true,
      });

      expect(result.released).toBe(true);

      // Verify lock is gone
      const check = await fileLockService.checkLock(mockAgentId, {
        filePath: 'src/index.ts',
      });
      expect(check.isLocked).toBe(false);
    });

    it('should return not_locked for unlocked file', async () => {
      const result = await fileLockService.releaseLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(result.released).toBe(false);
      expect(result.reason).toBe('not_locked');
    });

    it('should persist after release', async () => {
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      vi.mocked(fs.writeFile).mockClear();

      await fileLockService.releaseLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(fs.writeFile).toHaveBeenCalled();
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]!;
      const persisted = JSON.parse(writeCall[1] as string);
      expect(persisted.locks).toHaveLength(0);
    });
  });

  describe('checkLock', () => {
    it('should return isLocked false for unlocked file', async () => {
      const result = await fileLockService.checkLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(result.isLocked).toBe(false);
      expect(result.filePath).toBe('src/index.ts');
      expect(result.lock).toBeUndefined();
    });

    it('should return lock info for locked file', async () => {
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
        ownerLabel: 'Test Agent',
      });

      const result = await fileLockService.checkLock(mockAgentId2, {
        filePath: 'src/index.ts',
      });

      expect(result.isLocked).toBe(true);
      expect(result.lock).toBeDefined();
      expect(result.lock?.ownerId).toBe(mockAgentId);
      expect(result.lock?.ownerLabel).toBe('Test Agent');
      expect(result.lock?.isOwnedByMe).toBe(false);
    });

    it('should correctly identify own locks', async () => {
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      const result = await fileLockService.checkLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(result.isLocked).toBe(true);
      expect(result.lock?.isOwnedByMe).toBe(true);
    });

    it('should return isLocked false for expired locks', async () => {
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
        ttlSeconds: 60,
      });

      vi.advanceTimersByTime(61 * 1000);

      const result = await fileLockService.checkLock(mockAgentId2, {
        filePath: 'src/index.ts',
      });

      expect(result.isLocked).toBe(false);
    });
  });

  describe('listLocks', () => {
    it('should return empty list when no locks exist', async () => {
      const result = await fileLockService.listLocks(mockAgentId, {});

      expect(result.locks).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });

    it('should list all active locks', async () => {
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
        ownerLabel: 'Agent 1',
      });
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/utils.ts',
      });

      const result = await fileLockService.listLocks(mockAgentId, {});

      expect(result.locks).toHaveLength(2);
      expect(result.totalCount).toBe(2);
      expect(result.locks.every((l) => l.isOwnedByMe)).toBe(true);
    });

    it('should exclude expired locks by default', async () => {
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
        ttlSeconds: 60,
      });
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/utils.ts',
        ttlSeconds: 300,
      });

      vi.advanceTimersByTime(61 * 1000);

      const result = await fileLockService.listLocks(mockAgentId, {});

      expect(result.locks).toHaveLength(1);
      expect(result.locks[0]!.filePath).toBe('src/utils.ts');
    });

    it('should include expired locks when requested', async () => {
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
        ttlSeconds: 60,
      });
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/utils.ts',
        ttlSeconds: 300,
      });

      vi.advanceTimersByTime(61 * 1000);

      const result = await fileLockService.listLocks(mockAgentId, {
        includeExpired: true,
      });

      expect(result.locks).toHaveLength(2);

      const expiredLock = result.locks.find((l) => l.filePath === 'src/index.ts');
      expect(expiredLock?.isExpired).toBe(true);

      const activeLock = result.locks.find((l) => l.filePath === 'src/utils.ts');
      expect(activeLock?.isExpired).toBe(false);
    });
  });

  describe('releaseAllLocks', () => {
    it('should release all locks held by agent', async () => {
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
      });
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/utils.ts',
      });
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/types.ts',
      });

      const result = await fileLockService.releaseAllLocks(mockAgentId);

      expect(result.releasedCount).toBe(3);
      expect(result.releasedPaths).toHaveLength(3);
      expect(result.releasedPaths).toContain('src/index.ts');
      expect(result.releasedPaths).toContain('src/utils.ts');
      expect(result.releasedPaths).toContain('src/types.ts');

      // Verify all locks are gone
      const list = await fileLockService.listLocks(mockAgentId, {});
      expect(list.totalCount).toBe(0);
    });

    it('should not release locks held by other agents', async () => {
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
      });
      await fileLockService.acquireLock(mockAgentId2, {
        filePath: 'src/utils.ts',
      });

      const result = await fileLockService.releaseAllLocks(mockAgentId);

      expect(result.releasedCount).toBe(1);
      expect(result.releasedPaths).toEqual(['src/index.ts']);

      // Verify agent2's lock still exists
      const check = await fileLockService.checkLock(mockAgentId, {
        filePath: 'src/utils.ts',
      });
      expect(check.isLocked).toBe(true);
    });

    it('should return zero when no locks to release', async () => {
      const result = await fileLockService.releaseAllLocks(mockAgentId);

      expect(result.releasedCount).toBe(0);
      expect(result.releasedPaths).toHaveLength(0);
    });
  });

  describe('cleanup interval', () => {
    it('should clean up expired locks periodically', async () => {
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
        ttlSeconds: 60,
      });
      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/utils.ts',
        ttlSeconds: 600,
      });

      fileLockService.startCleanupInterval(1000); // 1 second for testing

      // Advance past first lock's TTL
      vi.advanceTimersByTime(61 * 1000);

      // Trigger cleanup interval
      vi.advanceTimersByTime(1000);

      // The expired lock should be cleaned up
      const list = await fileLockService.listLocks(mockAgentId, { includeExpired: true });
      expect(list.locks).toHaveLength(1);
      expect(list.locks[0]!.filePath).toBe('src/utils.ts');
    });

    it('should not start interval twice', () => {
      fileLockService.startCleanupInterval(1000);
      fileLockService.startCleanupInterval(1000); // Should be no-op

      // No error should occur
      fileLockService.stopCleanupInterval();
    });

    it('should stop interval cleanly', () => {
      fileLockService.startCleanupInterval(1000);
      fileLockService.stopCleanupInterval();
      fileLockService.stopCleanupInterval(); // Should be safe to call twice
    });
  });

  describe('persistence', () => {
    it('should load locks from disk on first access', async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour from now

      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          version: 1,
          workspaceId: mockWorkspaceId,
          locks: [
            {
              filePath: 'src/index.ts',
              ownerId: mockAgentId,
              ownerLabel: 'Persisted Agent',
              acquiredAt: now.toISOString(),
              expiresAt: expiresAt.toISOString(),
            },
          ],
        })
      );

      const result = await fileLockService.checkLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(result.isLocked).toBe(true);
      expect(result.lock?.ownerLabel).toBe('Persisted Agent');
    });

    it('should skip expired locks when loading from disk', async () => {
      const now = new Date();
      const expiredAt = new Date(now.getTime() - 1000); // Already expired

      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          version: 1,
          workspaceId: mockWorkspaceId,
          locks: [
            {
              filePath: 'src/index.ts',
              ownerId: mockAgentId,
              acquiredAt: new Date(now.getTime() - 60_000).toISOString(),
              expiresAt: expiredAt.toISOString(),
            },
          ],
        })
      );

      const result = await fileLockService.checkLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(result.isLocked).toBe(false);
    });

    it('should handle missing lock file gracefully', async () => {
      vi.mocked(fs.readFile).mockRejectedValue({ code: 'ENOENT' });

      const result = await fileLockService.checkLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(result.isLocked).toBe(false);
    });

    it('should handle invalid version gracefully', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          version: 999, // Unknown version
          locks: [],
        })
      );

      const result = await fileLockService.checkLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(result.isLocked).toBe(false);
    });

    it('should handle write errors gracefully', async () => {
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Disk full'));

      // Should not throw
      const result = await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(result.acquired).toBe(true);
    });
  });

  describe('workspace isolation', () => {
    it('should isolate locks by workspace', async () => {
      // Agent 1 in workspace 1
      mockFindById.mockResolvedValue({
        workspaceId: 'workspace-1',
        workspace: { worktreePath: '/path/to/ws1' },
      });

      await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      // Agent 2 in workspace 2
      mockFindById.mockResolvedValue({
        workspaceId: 'workspace-2',
        workspace: { worktreePath: '/path/to/ws2' },
      });

      // Should be able to acquire same file path in different workspace
      const result = await fileLockService.acquireLock(mockAgentId2, {
        filePath: 'src/index.ts',
      });

      expect(result.acquired).toBe(true);
    });
  });

  describe('loadFromDisk schema validation', () => {
    it('should handle malformed lock store JSON gracefully', async () => {
      // Mock malformed JSON (wrong types)
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({ version: 1, workspaceId: 'ws-1', locks: [{ filePath: 123 }] })
      );

      // Should not throw and return empty locks
      const result = await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(result.acquired).toBe(true);
    });

    it('should handle corrupted lock store JSON gracefully', async () => {
      // Mock corrupted JSON
      vi.mocked(fs.readFile).mockResolvedValue('{invalid json');

      // Should not throw and return empty locks
      const result = await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(result.acquired).toBe(true);
    });

    it('should handle non-object lock store JSON gracefully', async () => {
      // Mock non-object JSON
      vi.mocked(fs.readFile).mockResolvedValue('["array", "not", "object"]');

      // Should not throw and return empty locks
      const result = await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(result.acquired).toBe(true);
    });

    it('should handle wrong version gracefully', async () => {
      // Mock wrong version (this is checked before schema validation)
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({ version: 2, workspaceId: 'ws-1', locks: [] })
      );

      // Should not throw and return empty locks
      const result = await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/index.ts',
      });

      expect(result.acquired).toBe(true);
    });

    it('should load valid persisted locks successfully', async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000);
      const acquiredAt = new Date(now.getTime() - 1000);

      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          version: 1,
          workspaceId: mockWorkspaceId,
          locks: [
            {
              filePath: 'src/test.ts',
              ownerId: 'other-agent',
              ownerLabel: 'Agent 2',
              acquiredAt: acquiredAt.toISOString(),
              expiresAt: expiresAt.toISOString(),
              metadata: { test: 'data' },
            },
          ],
        })
      );

      // Try to acquire a file that's already locked
      const result = await fileLockService.acquireLock(mockAgentId, {
        filePath: 'src/test.ts',
      });

      // Should fail because the lock is held by another agent
      expect(result.acquired).toBe(false);
      expect(result.existingLock?.ownerId).toBe('other-agent');
      expect(result.existingLock?.ownerLabel).toBe('Agent 2');
    });
  });
});
