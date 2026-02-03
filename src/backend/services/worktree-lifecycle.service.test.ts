import { describe, expect, it } from 'vitest';
import { assertWorktreePathSafe, WorktreePathSafetyError } from './worktree-lifecycle.service';

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
