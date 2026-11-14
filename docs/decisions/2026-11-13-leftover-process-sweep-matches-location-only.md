# The leftover process sweep matches location only

Originally decided on 2026-11-09 in #3121.

## Context

Archive and delete stop a workspace's sessions, run script and terminals, but a
process an agent detached, such as a dev server started from a background shell,
is reparented to PID 1 and outlives the worktree.

## Decision

After the owned runtime cleanup succeeds and before the worktree is removed, a
best-effort sweep terminates the current user's processes without a controlling
terminal whose working directory or executable lies on a path boundary inside
the worktree, checking both the configured and the realpath-resolved spelling.
It never signals the server, its ancestors or PID 0 and 1. It sends SIGTERM,
lists again after a grace period, and sends SIGKILL only to survivors that still
match with the same start time, so a reused PID is never killed.

Rejected: matching command-line arguments, which would kill a process that only
names the worktree, such as an editor opened on it; and making the sweep part of
the cleanup contract: the owned cleanups are the contract, and a failed sweep
leaves the same leftovers as no sweep.

## Consequences

- A sweep failure is logged and never blocks the operation; a sweep that fails
  partway may have stopped some processes and left others running.
- Only macOS (`ps`, `lsof`) and Linux (`/proc`) are swept; other platforms skip
  it.
- Workspaces archived before the sweep existed keep their leftover processes
  until they exit or are stopped by hand.
