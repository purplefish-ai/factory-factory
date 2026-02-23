import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  assertWorktreePathSafe,
  WorktreePathSafetyError,
  worktreeLifecycleService,
} from './worktree-lifecycle.service';

describe('worktreeLifecycleService path safety', () => {
  it('allows worktree paths under the base path', () => {
    expect(() => assertWorktreePathSafe('/tmp/worktrees/ws-1', '/tmp/worktrees')).not.toThrow();
  });

  it('rejects worktree paths that equal the base path', () => {
    expect(() => assertWorktreePathSafe('/tmp/worktrees', '/tmp/worktrees')).toThrow(
      WorktreePathSafetyError
    );
  });

  it('rejects worktree paths outside the base path', () => {
    expect(() => assertWorktreePathSafe('/tmp/worktrees/../other', '/tmp/worktrees')).toThrow(
      WorktreePathSafetyError
    );
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
