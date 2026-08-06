import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import { workspaceGitStateService } from '@/backend/services/workspace-git-state.service';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { gitOpsService } from './git-ops.service';
import {
  assertWorktreePathSafe,
  WorktreePathSafetyError,
  worktreeLifecycleService,
} from './worktree-lifecycle.service';

describe('worktreeLifecycleService path safety', () => {
  it('allows worktree paths under the base path', async () => {
    await expect(assertWorktreePathSafe('/tmp/worktrees/ws-1', '/tmp/worktrees')).resolves.toBe(
      undefined
    );
  });

  it('rejects worktree paths that equal the base path', async () => {
    await expect(assertWorktreePathSafe('/tmp/worktrees', '/tmp/worktrees')).rejects.toThrow(
      WorktreePathSafetyError
    );
  });

  it('rejects worktree paths outside the base path', async () => {
    await expect(
      assertWorktreePathSafe('/tmp/worktrees/../other', '/tmp/worktrees')
    ).rejects.toThrow(WorktreePathSafetyError);
  });

  it('rejects a worktree root that has been replaced with a symlink', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ff-worktree-safety-'));
    const worktreeBasePath = path.join(tempRoot, 'worktrees');
    const victimWorktreePath = path.join(worktreeBasePath, 'victim');
    const swappedWorktreePath = path.join(worktreeBasePath, 'swapped');

    await mkdir(victimWorktreePath, { recursive: true });
    await symlink(victimWorktreePath, swappedWorktreePath, 'dir');

    try {
      await expect(assertWorktreePathSafe(swappedWorktreePath, worktreeBasePath)).rejects.toThrow(
        WorktreePathSafetyError
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('worktreeLifecycleService cleanup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses cleanup when the worktree root is a symlink to another worktree', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ff-worktree-cleanup-'));
    const worktreeBasePath = path.join(tempRoot, 'worktrees');
    const victimWorktreePath = path.join(worktreeBasePath, 'victim');
    const swappedWorktreePath = path.join(worktreeBasePath, 'swapped');
    const commitSpy = vi.spyOn(gitOpsService, 'commitIfNeeded').mockResolvedValue(undefined);
    const removeSpy = vi.spyOn(gitOpsService, 'removeWorktree').mockResolvedValue(undefined);

    await mkdir(victimWorktreePath, { recursive: true });
    await symlink(victimWorktreePath, swappedWorktreePath, 'dir');

    const workspace = unsafeCoerce<
      Parameters<typeof worktreeLifecycleService.cleanupWorkspaceWorktree>[0]
    >({
      name: 'Swapped workspace',
      worktreePath: swappedWorktreePath,
      project: {
        repoPath: path.join(tempRoot, 'repo'),
        worktreeBasePath,
      },
    });

    try {
      await expect(
        worktreeLifecycleService.cleanupWorkspaceWorktree(workspace, {})
      ).rejects.toThrow(WorktreePathSafetyError);
      expect(commitSpy).not.toHaveBeenCalled();
      expect(removeSpy).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('leaves successful removal eviction to GitOpsService', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ff-worktree-cleanup-'));
    const worktreeBasePath = path.join(tempRoot, 'worktrees');
    const worktreePath = path.join(worktreeBasePath, 'workspace');
    await mkdir(worktreePath, { recursive: true });
    vi.spyOn(gitOpsService, 'commitIfNeeded').mockResolvedValue(undefined);
    vi.spyOn(gitOpsService, 'removeWorktree').mockResolvedValue(undefined);
    const removeStateSpy = vi.spyOn(workspaceGitStateService, 'remove');
    const workspace = unsafeCoerce<
      Parameters<typeof worktreeLifecycleService.cleanupWorkspaceWorktree>[0]
    >({
      name: 'Workspace',
      worktreePath,
      project: { repoPath: path.join(tempRoot, 'repo'), worktreeBasePath },
    });

    try {
      await worktreeLifecycleService.cleanupWorkspaceWorktree(workspace, {});
      expect(gitOpsService.commitIfNeeded).toHaveBeenCalledWith(worktreePath, 'Workspace');
      expect(removeStateSpy).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('delegates registered worktree cleanup when the directory is already missing', async () => {
    const worktreePath = '/tmp/worktrees/missing-workspace';
    const project = { repoPath: '/tmp/repo', worktreeBasePath: '/tmp/worktrees' };
    vi.spyOn(gitOpsService, 'commitIfNeeded').mockResolvedValue(undefined);
    vi.spyOn(gitOpsService, 'removeWorktree').mockResolvedValue(undefined);
    const removeStateSpy = vi.spyOn(workspaceGitStateService, 'remove');
    const workspace = unsafeCoerce<
      Parameters<typeof worktreeLifecycleService.cleanupWorkspaceWorktree>[0]
    >({
      name: 'Missing workspace',
      worktreePath,
      project,
    });

    await worktreeLifecycleService.cleanupWorkspaceWorktree(workspace, {});

    expect(gitOpsService.commitIfNeeded).not.toHaveBeenCalled();
    expect(gitOpsService.removeWorktree).toHaveBeenCalledWith(worktreePath, project);
    expect(removeStateSpy).not.toHaveBeenCalled();
  });

  it('does not evict Git state when worktree removal fails', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ff-worktree-cleanup-'));
    const worktreeBasePath = path.join(tempRoot, 'worktrees');
    const worktreePath = path.join(worktreeBasePath, 'workspace');
    await mkdir(worktreePath, { recursive: true });
    vi.spyOn(gitOpsService, 'commitIfNeeded').mockResolvedValue(undefined);
    vi.spyOn(gitOpsService, 'removeWorktree').mockRejectedValue(new Error('remove failed'));
    const removeStateSpy = vi.spyOn(workspaceGitStateService, 'remove');
    const workspace = unsafeCoerce<
      Parameters<typeof worktreeLifecycleService.cleanupWorkspaceWorktree>[0]
    >({
      name: 'Workspace',
      worktreePath,
      project: { repoPath: path.join(tempRoot, 'repo'), worktreeBasePath },
    });

    try {
      await expect(
        worktreeLifecycleService.cleanupWorkspaceWorktree(workspace, {})
      ).rejects.toThrow('remove failed');
      expect(removeStateSpy).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('passes an explicit Git index-lock recovery action to Git operations', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ff-worktree-cleanup-'));
    const worktreeBasePath = path.join(tempRoot, 'worktrees');
    const worktreePath = path.join(worktreeBasePath, 'workspace');
    await mkdir(worktreePath, { recursive: true });
    const commitSpy = vi.spyOn(gitOpsService, 'commitIfNeeded').mockResolvedValue(undefined);
    vi.spyOn(gitOpsService, 'removeWorktree').mockResolvedValue(undefined);
    const workspace = unsafeCoerce<
      Parameters<typeof worktreeLifecycleService.cleanupWorkspaceWorktree>[0]
    >({
      name: 'Workspace',
      worktreePath,
      project: { repoPath: path.join(tempRoot, 'repo'), worktreeBasePath },
    });

    try {
      await worktreeLifecycleService.cleanupWorkspaceWorktree(workspace, {
        removeGitIndexLock: true,
      });

      expect(commitSpy).toHaveBeenCalledWith(worktreePath, 'Workspace', {
        removeGitIndexLock: true,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('removes the deterministic worktree left by interrupted provisioning', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ff-worktree-cleanup-'));
    const worktreeBasePath = path.join(tempRoot, 'worktrees');
    const worktreePath = path.join(worktreeBasePath, 'workspace-workspace-1');
    const project = {
      repoPath: path.join(tempRoot, 'repo'),
      worktreeBasePath,
    };
    await mkdir(worktreePath, { recursive: true });
    vi.spyOn(workspaceAccessor, 'findByIdWithProject').mockResolvedValue(
      unsafeCoerce({
        id: 'workspace-1',
        status: 'PROVISIONING',
        worktreePath: null,
        project,
      })
    );
    const removeSpy = vi.spyOn(gitOpsService, 'removeWorktree').mockResolvedValue(undefined);

    try {
      await expect(
        worktreeLifecycleService.prepareStaleProvisioningRecovery('workspace-1')
      ).resolves.toBe(true);

      expect(removeSpy).toHaveBeenCalledWith(worktreePath, project);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'the worktree path has been persisted',
      shouldRecover: true,
      workspace: {
        status: 'PROVISIONING',
        worktreePath: '/tmp/worktrees/workspace-workspace-1',
      },
    },
    {
      name: 'the workspace is no longer provisioning',
      shouldRecover: false,
      workspace: {
        status: 'FAILED',
        worktreePath: null,
      },
    },
  ])('does not remove a worktree when $name', async ({ shouldRecover, workspace }) => {
    vi.spyOn(workspaceAccessor, 'findByIdWithProject').mockResolvedValue(
      unsafeCoerce({
        id: 'workspace-1',
        ...workspace,
        project: {
          repoPath: '/tmp/repo',
          worktreeBasePath: '/tmp/worktrees',
        },
      })
    );
    const removeSpy = vi.spyOn(gitOpsService, 'removeWorktree').mockResolvedValue(undefined);

    await expect(
      worktreeLifecycleService.prepareStaleProvisioningRecovery('workspace-1')
    ).resolves.toBe(shouldRecover);

    expect(removeSpy).not.toHaveBeenCalled();
  });
});

describe('worktreeLifecycleService init mode', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('stores and clears init mode in memory', async () => {
    const workspaceId = 'workspace-memory-mode';

    await worktreeLifecycleService.setInitMode(workspaceId, true);
    await expect(worktreeLifecycleService.getInitMode(workspaceId)).resolves.toBe(true);

    await worktreeLifecycleService.setInitMode(workspaceId, false);
    await expect(worktreeLifecycleService.getInitMode(workspaceId)).resolves.toBe(false);

    await worktreeLifecycleService.clearInitMode(workspaceId);
    vi.spyOn(workspaceAccessor, 'findById').mockResolvedValue(null);
    await expect(worktreeLifecycleService.getInitMode(workspaceId)).resolves.toBeUndefined();
  });

  it('falls back to creation source when init mode is not cached', async () => {
    const workspaceId = 'workspace-db-fallback';

    await worktreeLifecycleService.clearInitMode(workspaceId);
    const findByIdSpy = vi.spyOn(workspaceAccessor, 'findById').mockResolvedValue(
      unsafeCoerce({
        id: workspaceId,
        creationSource: 'RESUME_BRANCH',
      })
    );

    await expect(worktreeLifecycleService.getInitMode(workspaceId)).resolves.toBe(true);
    expect(findByIdSpy).toHaveBeenCalledWith(workspaceId);
  });

  it('returns undefined when mode is not cached and creation source is not resume branch', async () => {
    const workspaceId = 'workspace-no-mode';

    await worktreeLifecycleService.clearInitMode(workspaceId);
    vi.spyOn(workspaceAccessor, 'findById').mockResolvedValue(
      unsafeCoerce({
        id: workspaceId,
        creationSource: 'MANUAL',
      })
    );

    await expect(worktreeLifecycleService.getInitMode(workspaceId)).resolves.toBeUndefined();
  });

  it('ignores undefined init mode updates', async () => {
    const workspaceId = 'workspace-undefined-mode';

    await worktreeLifecycleService.setInitMode(workspaceId, undefined);
    vi.spyOn(workspaceAccessor, 'findById').mockResolvedValue(null);

    await expect(worktreeLifecycleService.getInitMode(workspaceId)).resolves.toBeUndefined();
  });
});
