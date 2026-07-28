# Always Commit Before Workspace Archive

## Problem and goal

Workspace archive currently exposes a `commitUncommitted` choice across the client, tRPC routers,
orchestration layer, and worktree services. The workspace-detail dialog also fetches a full Git
snapshot and disables archive while that request is running. This can prevent a user from
archiving even though the archive backend already defaults to preserving work.

Archiving must have one invariant: if a valid workspace worktree contains uncommitted changes,
Factory Factory stages and commits them before removing the worktree. Users will no longer choose
whether to commit during archive, and archive availability will not depend on a Git-status query.

Archive can also fail when Git cannot create its worktree-specific `index.lock`. Git lock files do
not contain an owning process identifier, so Factory Factory cannot prove that a lock is stale.
Instead of returning a generic Git error or deleting the lock automatically, the application must
identify this conflict and let the user retry normally or explicitly remove the lock and retry.

## Considered approaches

1. Remove the option end-to-end and enforce always-commit in the backend. This applies the invariant
   to workspace detail, Kanban cards, bulk archive, child archive, and startup recovery. This is the
   selected approach.
2. Remove the option only in the client and continue sending `commitUncommitted: true`. This is a
   smaller change, but it leaves an obsolete backend path that can still reject or discard a future
   archive request.
3. Keep the option and only remove the dialog's loading guard. This fixes the immediate disabled
   button but preserves inconsistent semantics and unnecessary Git-status work.

For Git lock recovery:

1. Return a structured conflict and offer Retry or Remove Lock and Archive. This preserves the safe
   default while making stale locks recoverable in the application. This is the selected approach.
2. Automatically remove locks older than a chosen threshold. This is smoother, but lock age cannot
   prove that no legitimate Git process still relies on it.
3. Keep returning a generic failure and require manual command-line cleanup. This is safe but does
   not provide an acceptable archive experience.

## Design

`ArchiveWorkspaceDialog` will become a confirmation-only component. It will no longer own checkbox
state, accept Git-status or commit-option props, or pass a Boolean to `onConfirm`. Its description
will state that uncommitted changes are committed before the worktree is removed. Child-workspace
warnings and caller-supplied bulk descriptions remain supported.

Workspace detail will stop loading Git status solely for archive confirmation. Kanban card and
bulk archive callbacks will no longer thread a commit choice. The first archive request will send
only the workspace or column identity.

The workspace and child tRPC archive inputs will remove `commitUncommitted`. The archive
orchestrator and worktree lifecycle APIs will remove `WorktreeCleanupOptions`. `commitIfNeeded`
will retain its existing repository validation, status check, staging, archive commit, and cache
invalidation behavior, but will no longer accept or branch on a Boolean. Any detected changes are
always committed.

Startup recovery uses the same option-free archive completion path, so an interrupted archive
continues preserving changes before cleanup.

## Git index-lock recovery

If staging fails, the Git service will resolve the worktree's own index-lock path and check whether
that exact lock exists. A staging failure with a present lock becomes an application conflict with
a machine-readable `GIT_INDEX_LOCKED` discriminator and a specific user-facing explanation. The
tRPC error boundary will preserve that discriminator alongside its standard `CONFLICT` code so
clients do not identify the condition by parsing prose. Other staging failures retain their
existing internal error behavior. The archive orchestrator still rolls the workspace status back
after either failure.

Single-workspace archive callers will recognize the conflict after their normal optimistic rollback
and open a recovery dialog. The dialog explains that another Git operation may be active or a
previous operation may have stopped unexpectedly. It offers:

- **Cancel**, which leaves the workspace unchanged;
- **Retry**, which repeats archive without touching the lock;
- **Remove Lock and Archive**, which makes a one-time recovery request.

The recovery request contains only the workspace identity and an explicit lock-resolution action;
it never accepts a path from the client. Immediately before staging, the backend resolves the
worktree's index-lock path again, removes only that file if present, and continues through the
normal always-commit archive path. The action is not persisted as a preference.

Bulk archive will continue processing independent workspaces. Its result will distinguish
index-locked workspaces from other failures. If any are locked, the Kanban UI will offer the same
recovery choice for that failed subset. Retry and Remove Lock and Archive will issue individual
archive requests only for those workspace IDs, so successfully archived workspaces are not
processed again and locks are never removed from workspaces that did not report the conflict.

Child archive uses the same explicit recovery input and backend path. Startup recovery never
removes a lock automatically because no user is present to make the choice; it reports the
conflict and leaves the workspace failed for manual recovery.

## Error handling

Invalid repositories continue to skip the commit attempt so corrupt or already-removed worktrees
can follow the existing cleanup path. Failures from Git status, add, commit, or worktree removal
continue aborting archive and rolling the workspace status back. The obsolete
`PRECONDITION_FAILED` error for disabling commit-before-archive is removed.

The archive dialog closes after confirmation as it does today. Mutation failures continue restoring
optimistically removed workspaces and displaying the underlying error.

Removing a lock is best effort only in the sense that a lock may disappear between detection and
the recovery request. A missing lock is treated as already resolved and archive proceeds. A file
removal error aborts archive, preserves the workspace, and is shown to the user. If another Git
process recreates the lock, staging returns the same recoverable conflict again.

## Testing

Tests will prove that:

- an archive confirmation is enabled without waiting for Git status and invokes a no-argument
  confirmation callback;
- workspace-detail, Kanban card, and bulk archive flows send option-free mutations;
- workspace and child archive routers call orchestration without a commit option;
- worktree cleanup always stages and commits detected changes before removal;
- clean worktrees and invalid repositories retain their current behavior;
- Git add or commit failures still fail archive and preserve rollback behavior;
- a staging failure with the exact index lock present becomes a conflict, while unrelated staging
  failures do not;
- ordinary retry does not remove a lock;
- explicit recovery resolves and removes only the server-derived worktree index lock before
  retrying staging;
- a lock that disappears before recovery is harmless, while lock-removal failure preserves the
  workspace;
- single, child, and bulk archive surfaces offer recovery only for index-lock conflicts;
- bulk recovery retries only the locked failed subset;
- startup recovery uses the always-commit path but never removes locks automatically.

Focused tests will run first, followed by type checking and the repository guardrails.
