import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist mock definitions
const mockGitCommand = vi.hoisted(() => vi.fn());
const mockTaskAccessor = vi.hoisted(() => ({
  findById: vi.fn(),
}));

vi.mock('../lib/shell.js', () => ({
  gitCommand: mockGitCommand,
  validateBranchName: vi.fn((name: string) => name),
}));

vi.mock('../resource_accessors/index.js', () => ({
  taskAccessor: mockTaskAccessor,
}));

// Import after mocking
import { WorktreeService } from './worktree.service';

describe('WorktreeService', () => {
  let service: WorktreeService;
  const originalEnv = process.env.GIT_WORKTREE_BASE;

  beforeEach(() => {
    vi.clearAllMocks();
    // Set up a known worktree base for tests
    process.env.GIT_WORKTREE_BASE = '/tmp/factoryfactory-worktrees';
    service = new WorktreeService('/test/repo');
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv === undefined) {
      process.env.GIT_WORKTREE_BASE = undefined;
    } else {
      process.env.GIT_WORKTREE_BASE = originalEnv;
    }
  });

  describe('listWorktrees', () => {
    it('should parse porcelain output correctly', async () => {
      mockGitCommand.mockResolvedValue({
        stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /tmp/factoryfactory-worktrees/task-abc
HEAD def456
branch refs/heads/factoryfactory/task-abc12345

`,
      });

      const result = await service.listWorktrees();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        path: '/test/repo',
        commit: 'abc123',
        branch: 'refs/heads/main',
        isDetached: false,
      });
      expect(result[1]).toEqual({
        path: '/tmp/factoryfactory-worktrees/task-abc',
        commit: 'def456',
        branch: 'refs/heads/factoryfactory/task-abc12345',
        isDetached: false,
      });
    });

    it('should handle detached HEAD worktrees', async () => {
      mockGitCommand.mockResolvedValue({
        stdout: `worktree /test/repo
HEAD abc123
detached

`,
      });

      const result = await service.listWorktrees();

      expect(result).toHaveLength(1);
      expect(result[0].isDetached).toBe(true);
      expect(result[0].branch).toBe('detached');
    });

    it('should return empty array on git command failure', async () => {
      mockGitCommand.mockRejectedValue(new Error('git failed'));

      const result = await service.listWorktrees();

      expect(result).toEqual([]);
    });
  });

  describe('findOrphanedWorktrees', () => {
    it('should skip the main repo worktree', async () => {
      mockGitCommand.mockResolvedValue({
        stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

`,
      });

      const result = await service.findOrphanedWorktrees();

      expect(result).toHaveLength(0);
      expect(mockTaskAccessor.findById).not.toHaveBeenCalled();
    });

    it('should ignore non-system worktrees (no factoryfactory prefix)', async () => {
      mockGitCommand.mockResolvedValue({
        stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /home/user/my-worktree
HEAD def456
branch refs/heads/my-feature-branch

`,
      });

      const result = await service.findOrphanedWorktrees();

      // The feature branch worktree should NOT be marked as orphaned
      expect(result).toHaveLength(0);
      expect(mockTaskAccessor.findById).not.toHaveBeenCalled();
    });

    it('should ignore worktrees with factoryfactory prefix but wrong path', async () => {
      // Worktree has the right branch prefix but is NOT in the system worktree directory
      mockGitCommand.mockResolvedValue({
        stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /home/user/random-location
HEAD def456
branch factoryfactory/task-abc12345

`,
      });

      const result = await service.findOrphanedWorktrees();

      // Should be ignored because path is not under GIT_WORKTREE_BASE
      expect(result).toHaveLength(0);
      expect(mockTaskAccessor.findById).not.toHaveBeenCalled();
    });

    it('should check system worktrees with factoryfactory prefix AND system path', async () => {
      mockGitCommand.mockResolvedValue({
        stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /tmp/factoryfactory-worktrees/task-abc
HEAD def456
branch factoryfactory/task-abc12345

`,
      });

      // Task doesn't exist
      mockTaskAccessor.findById.mockResolvedValue(null);

      const result = await service.findOrphanedWorktrees();

      expect(result).toHaveLength(1);
      expect(result[0].reason).toBe('no_task');
      expect(result[0].taskId).toBe('abc12345');
    });

    it('should recognize worktrees under /factoryfactory/worktrees/ pattern', async () => {
      // Clear env to test fallback pattern
      process.env.GIT_WORKTREE_BASE = undefined;

      mockGitCommand.mockResolvedValue({
        stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /tmp/factoryfactory/worktrees/task-abc
HEAD def456
branch factoryfactory/task-abc12345

`,
      });

      mockTaskAccessor.findById.mockResolvedValue(null);

      const result = await service.findOrphanedWorktrees();

      expect(result).toHaveLength(1);
      expect(result[0].reason).toBe('no_task');
    });

    it('should mark completed task worktrees as orphaned', async () => {
      mockGitCommand.mockResolvedValue({
        stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /tmp/factoryfactory-worktrees/task-xyz
HEAD def456
branch factoryfactory/task-xyz99999

`,
      });

      mockTaskAccessor.findById.mockResolvedValue({
        id: 'xyz99999',
        state: 'COMPLETED',
        parentId: 'parent-123',
      });

      const result = await service.findOrphanedWorktrees();

      expect(result).toHaveLength(1);
      expect(result[0].reason).toBe('completed_task');
      expect(result[0].taskId).toBe('xyz99999');
      expect(result[0].topLevelTaskId).toBe('parent-123');
    });

    it('should not mark active task worktrees as orphaned', async () => {
      mockGitCommand.mockResolvedValue({
        stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /tmp/factoryfactory-worktrees/task-active
HEAD def456
branch factoryfactory/task-active11

`,
      });

      mockTaskAccessor.findById.mockResolvedValue({
        id: 'active11',
        state: 'IN_PROGRESS',
      });

      const result = await service.findOrphanedWorktrees();

      expect(result).toHaveLength(0);
    });

    it('should check top-level task worktrees', async () => {
      mockGitCommand.mockResolvedValue({
        stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /tmp/factoryfactory-worktrees/top-level
HEAD def456
branch factoryfactory/top-level-epic123

`,
      });

      // Top-level task is completed/cancelled
      mockTaskAccessor.findById.mockResolvedValue({
        id: 'epic123',
        state: 'COMPLETED',
      });

      const result = await service.findOrphanedWorktrees();

      expect(result).toHaveLength(1);
      expect(result[0].reason).toBe('deleted_top_level_task');
      expect(result[0].topLevelTaskId).toBe('epic123');
    });

    it('should mark system worktrees with unrecognized patterns as orphaned', async () => {
      mockGitCommand.mockResolvedValue({
        stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /tmp/factoryfactory-worktrees/unknown
HEAD def456
branch factoryfactory/some-random-branch

`,
      });

      const result = await service.findOrphanedWorktrees();

      expect(result).toHaveLength(1);
      expect(result[0].reason).toBe('unknown');
    });

    it('should handle refs/heads/ prefix in branch names', async () => {
      mockGitCommand.mockResolvedValue({
        stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /tmp/factoryfactory-worktrees/task-ref
HEAD def456
branch refs/heads/factoryfactory/task-reftest1

`,
      });

      mockTaskAccessor.findById.mockResolvedValue(null);

      const result = await service.findOrphanedWorktrees();

      expect(result).toHaveLength(1);
      expect(result[0].reason).toBe('no_task');
    });
  });

  describe('getWorktreeStats', () => {
    it('should return correct stats', async () => {
      mockGitCommand.mockResolvedValue({
        stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /tmp/factoryfactory-worktrees/task1
HEAD def456
branch factoryfactory/task-abc12345

worktree /tmp/factoryfactory-worktrees/task2
HEAD ghi789
branch factoryfactory/task-def67890

`,
      });

      // First task doesn't exist, second is completed
      mockTaskAccessor.findById
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'def67890', state: 'COMPLETED', parentId: null });

      const stats = await service.getWorktreeStats();

      expect(stats.total).toBe(2); // Excludes main worktree
      expect(stats.orphaned).toBe(2);
      expect(stats.byReason).toEqual({
        no_task: 1,
        completed_task: 1,
      });
    });
  });

  describe('isSystemWorktree (defense in depth)', () => {
    it('should require BOTH branch prefix AND system path', async () => {
      // Has branch prefix but wrong path - should be ignored
      mockGitCommand.mockResolvedValue({
        stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /some/other/path
HEAD def456
branch factoryfactory/task-abc12345

`,
      });

      const result = await service.findOrphanedWorktrees();
      expect(result).toHaveLength(0);
    });

    it('should require BOTH branch prefix AND system path (path only)', async () => {
      // Has system path but wrong branch prefix - should be ignored
      mockGitCommand.mockResolvedValue({
        stdout: `worktree /test/repo
HEAD abc123
branch refs/heads/main

worktree /tmp/factoryfactory-worktrees/feature
HEAD def456
branch refs/heads/feature-branch

`,
      });

      const result = await service.findOrphanedWorktrees();
      expect(result).toHaveLength(0);
    });
  });
});
