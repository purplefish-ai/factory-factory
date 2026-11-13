# Worktree cleanup matches canonical paths only

Originally decided on 2026-09-08 in #2237.

## Context

Git records a worktree under its real path. Projects can configure a worktree
base directory that is a symlink, so the configured path and Git's registered
path differ. Comparing the two directly removed only the directory and left a
Git registration behind, which blocked reusing the branch.

## Decision

Cleanup and branch-resume validation resolve the base directory before matching
Git's registrations, separately from the worktree, so cleanup still works after
the worktree directory is gone. When the base symlink itself no longer resolves,
cleanup logs a warning and matches only the exact configured path.

Rejected: guessing the registration from the worktree's basename, or pruning
registrations that do not match. Either could remove another workspace's
worktree.

## Consequences

- A symlinked base no longer leaves registrations behind, and an already
  checked-out branch is rejected before a workspace is created.
- If the base symlink is missing, a canonical registration survives cleanup.
