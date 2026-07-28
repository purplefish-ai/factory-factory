# Always Commit Before Workspace Archive

## Problem and goal

Workspace archive currently exposes a `commitUncommitted` choice across the client, tRPC
routers, orchestration layer, and worktree services. The workspace-detail dialog also fetches a
full Git snapshot and disables archive while that request is running. This can prevent a user from
archiving even though the archive backend already defaults to preserving work.

Archiving must have one invariant: if a valid workspace worktree contains uncommitted changes,
Factory Factory stages and commits them before removing the worktree. Users will no longer choose
whether to commit during archive, and archive availability will not depend on a Git-status query.

## Considered approaches

1. Remove the option end-to-end and enforce always-commit in the backend. This applies the invariant
   to workspace detail, Kanban cards, bulk archive, child archive, and startup recovery. This is the
   selected approach.
2. Remove the option only in the client and continue sending `commitUncommitted: true`. This is a
   smaller change, but it leaves an obsolete backend path that can still reject or discard a future
   archive request.
3. Keep the option and only remove the dialog's loading guard. This fixes the immediate disabled
   button but preserves inconsistent semantics and unnecessary Git-status work.

## Design

`ArchiveWorkspaceDialog` will become a confirmation-only component. It will no longer own checkbox
state, accept Git-status or commit-option props, or pass a Boolean to `onConfirm`. Its description
will state that uncommitted changes are committed before the worktree is removed. Child-workspace
warnings and caller-supplied bulk descriptions remain supported.

Workspace detail will stop loading Git status solely for archive confirmation. Kanban card and bulk
archive callbacks will no longer thread a commit choice. Client archive mutations will send only
the workspace or column identity.

The workspace and child tRPC archive inputs will remove `commitUncommitted`. The archive
orchestrator and worktree lifecycle APIs will remove `WorktreeCleanupOptions`. `commitIfNeeded`
will retain its existing repository validation, status check, staging, archive commit, and cache
invalidation behavior, but will no longer accept or branch on a Boolean. Any detected changes are
always committed.

Startup recovery uses the same option-free archive completion path, so an interrupted archive
continues preserving changes before cleanup.

## Error handling

Invalid repositories continue to skip the commit attempt so corrupt or already-removed worktrees
can follow the existing cleanup path. Failures from Git status, add, commit, or worktree removal
continue aborting archive and rolling the workspace status back. The obsolete
`PRECONDITION_FAILED` error for disabling commit-before-archive is removed.

The archive dialog closes after confirmation as it does today. Mutation failures continue restoring
optimistically removed workspaces and displaying the underlying error.

## Testing

Tests will prove that:

- an archive confirmation is enabled without waiting for Git status and invokes a no-argument
  confirmation callback;
- workspace-detail, Kanban card, and bulk archive flows send option-free mutations;
- workspace and child archive routers call orchestration without a commit option;
- worktree cleanup always stages and commits detected changes before removal;
- clean worktrees and invalid repositories retain their current behavior;
- Git add or commit failures still fail archive and preserve rollback behavior;
- startup recovery uses the same always-commit path.

Focused tests will run first, followed by type checking and the repository guardrails.
