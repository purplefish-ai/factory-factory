# Workspace Delete Worktree Cleanup Design

## Goal

Remove a workspace's git worktree directory and git metadata when the workspace is deleted, without preventing database deletion if worktree cleanup itself fails.

## Root Cause

The `workspace.delete` mutation cleans up runtime resources, evicts run-script buffers, deletes the workspace record, and clears workspace-scoped caches. It never loads the workspace with its project or calls `worktreeLifecycleService.cleanupWorkspaceWorktree`, even though that service needs the pre-delete workspace and project data to resolve and remove the worktree safely. Once the database row is deleted, the existing stale-provisioning recovery path cannot reconstruct that context.

## Considered Approaches

1. Load the workspace in the existing delete mutation and perform best-effort worktree cleanup before database deletion. Selected because it is the smallest change, preserves the established delete lifecycle, and uses the same cleanup service as archive.
2. Introduce a new delete orchestrator that owns runtime, worktree, persistence, and cache cleanup. This would improve transport separation, but it broadens a focused bug fix and duplicates migration work not required by the issue.
3. Add a reconciliation job that scans disk for orphaned worktrees. This could repair historical orphans, but it does not correct the faulty delete lifecycle by itself and introduces filesystem scanning and ownership questions outside issue #2162.

## Design

Before destructive cleanup starts, `workspace.delete` will load the workspace with its project through `getWorkspaceWithProjectOrThrow`. Runtime cleanup remains fail-fast: if sessions, run scripts, or terminals cannot be stopped, neither worktree cleanup nor database deletion runs.

After runtime cleanup and buffer eviction, the mutation will call `worktreeLifecycleService.cleanupWorkspaceWorktree(workspace, {})`. A cleanup failure will be logged with the workspace ID and normalized error text, then database deletion will continue. This best-effort policy ensures a filesystem problem does not strand a workspace database row that the user explicitly asked to delete. The database row will be removed only after the worktree cleanup attempt finishes, preserving the workspace and project data needed by the cleanup service.

Workspace-scoped caches remain cleared only after a successful database deletion. Existing runtime-cleanup failure behavior and buffer-eviction ordering remain unchanged.

## Edge Cases

- A workspace without a worktree path is accepted because `cleanupWorkspaceWorktree` already returns without filesystem work.
- A missing workspace is rejected before runtime or filesystem cleanup through the existing `NOT_FOUND` helper contract.
- Runtime cleanup failure remains fail-closed and prevents both worktree cleanup and database deletion.
- Worktree cleanup failure is logged but does not prevent database deletion or cache cleanup.
- Database deletion failure still prevents workspace-scoped cache cleanup, even if worktree cleanup already succeeded.
- Worktree cleanup must complete or reject before database deletion begins so the database context remains available throughout the attempt.

## Testing

Extend `src/backend/trpc/workspace.router.test.ts` with a typed worktree lifecycle double. The happy-path delete test will assert that the real mutation passes the fetched workspace and empty options to worktree cleanup and that the cleanup call occurs before database deletion. A second regression test will reject worktree cleanup and assert that deletion still resolves, caches are cleared, and the error is logged.

Run the focused router test before implementation to verify it fails because worktree cleanup is not called. After the minimal implementation, run the focused test and the repository-required typecheck, formatting, full test, build, and guardrail commands. This is backend-only behavior, so no UI screenshot is applicable.

## Scope

No database schema, API input/output shape, worktree service behavior, archive behavior, reconciliation job, or UI changes are required.
