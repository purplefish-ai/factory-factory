# Worktree removal detaches, then reclaims

## Context

On 2026-11-25 the owner archived about 50 workspaces within two minutes. Each
archive removed its worktree with `git worktree remove --force`, which deletes
the directory under the five-minute command deadline
(`LIB_LIMITS.execCommandDefaultTimeoutMs`). With about 50 recursive deletions of
roughly 90,000 files each (mostly `node_modules`) running at once, 48 reached
the deadline; Git was killed part-way and left the worktrees half-deleted. One
at a time, the same deletion takes about 8 seconds.

## Decision

`gitOpsService.removeWorktree` takes a worktree off its path in one atomic step
and leaves disk reclamation to a background job with no deadline.

- The directory is renamed into `<canonical worktree base>/.ff-trash/` as
  `<name>.<base-36 time>-<8 hex>`. Inside the base it is on the same filesystem,
  so the path is either intact or gone. Then the registration Git lists for the
  canonical path is removed with a targeted `git worktree remove --force`, which
  succeeds once the directory is gone; the branch is kept. A locked worktree is
  refused before anything moves.
- Never `git worktree prune`: other tools (Claude Code, Codex, temporary
  checkouts) register worktrees in the same repositories.
- When the rename fails (another device, a trash that is a symlink or outside
  the base), the directory is deleted in place with `fs.rm`, which has no
  deadline.
- A failed Git step is reported to the caller as before. A retry finds the
  directory gone and only removes the registration, so it converges.
- The `worktree-trash-reclaim` job deletes direct trash entries that match the
  name pattern, one at a time, with `rm -rf` and no deadline. It runs at start,
  when a worktree is moved (the owner chose to reclaim at once, with no grace
  period), and every 30 minutes. Shutdown kills the `rm` in flight (on Windows,
  which has no `rm`, a tree walk stops between removals); the next run resumes
  the entry. It only reads a trash that is a real directory whose real path is
  inside the canonical base.
- To be woken, `jobRunner` gained `wake()`. This reverses the rejection of a
  "run this job now" API in
  [recurring work runs on one sequential job runner](2026-11-13-recurring-work-runs-on-one-sequential-job-runner.md):
  this job's work becomes due on an event. A wake never overlaps runs and never
  starts a stopped job.
- The workspace `delete` procedure runs inside `withArchiveExcluded`: it waits
  for this process's in-flight archive of the workspace, and archives requested
  while it runs are refused with a conflict.

Rejected: a longer or no deadline on `git worktree remove` (killing it still
half-deletes, and the user-facing step stays slow); deleting with bounded
concurrency in the request (still slow and still interruptible by shutdown).

## Consequences

- Archive and delete no longer wait for the disk; the worktree path is free at
  once and its branch can be checked out again.
- Disk space returns after the reclaimer finishes, seconds to minutes later; a
  shutdown can postpone it to the next start.
- A trash entry the reclaimer cannot delete (for example read-only files) is
  logged and retried every run.
- Held by `git-ops.trash.integration.test.ts`,
  `git-ops.symlink.integration.test.ts`, `worktree-trash.test.ts` and
  `git-ops.service.test.ts` in
  `src/backend/services/workspace/service/worktree/`, and by
  `src/backend/services/job-runner.service.test.ts`.
