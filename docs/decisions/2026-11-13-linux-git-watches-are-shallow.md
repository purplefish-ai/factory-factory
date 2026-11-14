# Linux Git watches are shallow

Originally decided on 2026-11-05 in #3054.

## Context

The Git state cache keeps each worktree's snapshot warm by watching the
worktree, its private Git directory and the repository's shared `.git`
directory. Recursive watches on Linux are installed directory by directory, so
installing them traversed dependency trees, Git objects, logs and other
worktrees, and stalled the backend.

## Decision

On Linux every watch is nonrecursive, and snapshots expire after five seconds
even while the watches are healthy, so ordinary snapshot readers pick up nested
working-tree edits and ref changes that shallow watches cannot see. Watch
failures keep the same five-second limit there. Other platforms keep recursive
watching, with the five-minute fallback expiry after a watch failure.

Rejected: recursive watching on Linux, whose installation cost grows with
everything under the worktree.

## Consequences

- On Linux a nested edit can take up to five seconds to show in Git stats.
- Linux recomputes warm snapshots more often than other platforms.
