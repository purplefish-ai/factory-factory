/**
 * @deprecated Import from '@/backend/domains/workspace' instead.
 * This re-export shim will be removed in Phase 9 (Import Rewiring).
 */
import {
  assertWorktreePathSafe,
  WorktreePathSafetyError,
  worktreeLifecycleService,
} from '@/backend/domains/workspace/worktree/worktree-lifecycle.service';

export { worktreeLifecycleService, assertWorktreePathSafe, WorktreePathSafetyError };

// Backward-compatible wrapper: old code calls setWorkspaceInitMode() as a free function,
// but it's now an instance method on worktreeLifecycleService.
export const setWorkspaceInitMode = (
  ...args: Parameters<typeof worktreeLifecycleService.setInitMode>
) => worktreeLifecycleService.setInitMode(...args);

export const getWorkspaceInitMode = (
  ...args: Parameters<typeof worktreeLifecycleService.getInitMode>
) => worktreeLifecycleService.getInitMode(...args);
