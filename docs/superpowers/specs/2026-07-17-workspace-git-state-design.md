# Centralized Workspace Git State Design

## Problem and goals

Workspace Git state is currently recomputed independently by snapshot reconciliation, project summaries, `hasChanges`, and three workspace UI endpoints. A single user-visible refresh can therefore run overlapping `status`, `merge-base`, and `diff` commands for the same worktree, while periodic reconciliation repeats the full scan for idle worktrees.

The change must provide one coherent, reusable snapshot per worktree and base branch; coalesce concurrent requests; invalidate on file or Git metadata changes; fall back safely where recursive file watching is unavailable; remove entries when worktrees disappear; and preserve the existing endpoint response shapes.

## Considered approaches

1. **Short-TTL caching in each existing caller.** This is small, but caches remain independent, cross-endpoint requests cannot share work, and periodic reconciliation still scans every worktree. It does not meet the consistency requirement.
2. **One process-global Git-state service with watcher invalidation.** All consumers request the same snapshot keyed by normalized worktree path and default branch. The service owns single-flight, cache generations, watchers, fallback freshness, and cleanup. This meets the acceptance criteria with a focused infrastructure boundary and is the selected approach.
3. **Persist Git snapshots in the database and push updates over WebSockets.** This could provide stronger cross-process coordination, but the application currently runs one backend process, the state is derived and ephemeral, and persistence would add schema, migration, and synchronization complexity that the issue does not require.

## Architecture

Add `workspace-git-state.service.ts` as a cross-cutting backend infrastructure service. Its public API accepts `worktreePath` and `defaultBranch` and returns a `WorkspaceGitStateSnapshot` containing:

- parsed porcelain status and `hasUncommitted`;
- the selected merge base and whether no base exists;
- aggregate file count, additions, and deletions derived from one `diff --numstat` result;
- base-relative added, modified, and deleted file metadata;
- upstream presence/ref and files changed by local, unpushed commits;
- computation timestamp and section-specific errors.

Status, base-relative, and upstream sections retain independent error state. An upstream lookup failure that means “no configured upstream” produces an empty successful upstream section. A genuine upstream diff failure is recorded for that section but does not make status or aggregate stats unavailable. Existing tRPC endpoints translate only their relevant section error into their existing thrown error behavior.

The cache key is the normalized worktree path plus default branch. A per-key generation increments on invalidation. Concurrent misses share one promise. If invalidation happens while a calculation is in flight, that result is returned to its original callers but is not installed as the new cached value, preventing a stale calculation from repopulating the cache.

## Invalidation and freshness

The first request for a worktree installs recursive file-system watching for the worktree plus Git metadata where available. Events are debounced briefly and invalidate every base-branch variant for that worktree. App-owned Git mutations explicitly invalidate after successful commits, worktree creation/removal, merges, pushes, fetches, auto-iteration Git mutations, and branch renames. App-owned file deletion invalidates after success.

When recursive watching cannot be installed or later reports an error, the service marks that worktree as fallback-only. Fallback cache entries expire after five minutes and are refreshed only when a consumer asks for them. With a healthy watcher, warm entries have no time-based expiry. Active changes panels request the snapshot every 15 seconds, so external edits become visible within approximately 16 seconds (watch debounce plus the client interval). Archive confirmation requests status when the dialog opens. Hidden panels and inactive workspaces do not create 15-second polling traffic. Reconciliation may continue on its existing safety-net schedule, but it receives warm cached snapshots rather than spawning Git processes.

`remove(worktreePath)` closes watchers, removes all cached and in-flight bookkeeping for the path, and advances its generation. Worktree cleanup calls it whether removal uses Git or the file-system fallback. Server shutdown closes all watchers.

## Consumer migration

- Snapshot reconciliation and project sidebar summaries request aggregate stats from the shared snapshot.
- `workspaceQueryService.hasChanges` uses the same snapshot statistics/status.
- `getGitStatus`, `getUnstagedChanges`, `getDiffVsMain`, and `getUnpushedFiles` project their existing response shapes from one snapshot.
- Per-file diff remains an on-demand operation because its cache key includes an arbitrary file and its content can be large; it may reuse the snapshot merge base but is not included in the shared aggregate calculation.
- The changes panel retains its three existing tRPC queries for compatibility, but all three share one backend in-flight calculation. Its mounted/visible state already controls whether it exists. The workspace-detail archive guard stops always-on polling and loads status only while the archive dialog is open.

## Error handling and edge cases

- A missing worktree continues returning the existing empty endpoint responses.
- Both `origin/<defaultBranch>` and the local default branch are tried for merge-base selection; changing `defaultBranch` selects a different cache key.
- No merge base yields `noMergeBase: true`; aggregate unstaged stats can still be computed with a no-base diff.
- A missing or detached upstream yields `hasUpstream: false` without throwing.
- Command failures are isolated to their section. Reconciliation and `hasChanges` retain their fail-safe `null`/`false` behavior.
- Watch setup failures never fail a request; they activate fallback expiry.
- Invalidating during an in-flight command cannot install stale data after the invalidation.

## Testing

Add focused service unit tests with injected Git and watcher dependencies for:

- concurrent single-flight requests and warm-cache reuse;
- explicit and watcher-driven invalidation, including invalidation during flight;
- watcher setup/error fallback and five-minute expiry;
- separate cache entries for different base branches;
- origin/local merge-base fallback and no merge base;
- missing upstreams and upstream diff failures;
- status/base command failures and parser behavior;
- worktree removal closing watchers and clearing cache entries.

Update router, workspace query, reconciliation, Git operation, lifecycle, and UI tests to assert delegation, cleanup, and visibility-aware polling. The full repository typecheck, formatting guard, test suite, and production build validate integration.
