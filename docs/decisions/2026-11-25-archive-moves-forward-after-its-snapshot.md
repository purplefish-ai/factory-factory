# Archive moves forward after its snapshot

Decided on 2026-11-25, after 48 concurrent archives timed out in the middle of
`git worktree remove`.

## Context

Archive stopped runtimes, committed uncommitted work (`git add -A`, then
`git commit`), removed the worktree and marked the workspace ARCHIVED. Any
failure rolled the workspace back to its previous status. When removal timed out
half way, the gutted worktree came back as READY; archiving it again committed
thousands of file deletions onto the user's branch. A detached HEAD's archive
commit became unreachable once the worktree was gone, and a HEAD on another
branch had that branch advanced.

## Decision

- One snapshot per attempt, before anything destructive. When HEAD is on the
  workspace's own branch (`branchName`), uncommitted work is committed onto it
  as before. Otherwise it is committed aside through a copy of the index
  (`GIT_INDEX_FILE`, `add -A`, `write-tree`, `commit-tree -p HEAD`), moving no
  branch, HEAD or index. In every case `refs/factory-factory/archive/<id>`
  points at the snapshot; a clean tree's snapshot is HEAD. The committed paths
  are logged, bounded to 50 with counts per status.
- Before removal starts, a failure rolls back to the previous status. Once it
  has started, a failure moves the workspace to FAILED with an
  `Archive incomplete: <reason>. Archive again to finish.` message, never READY.
  The boundary is "removal attempted", so it holds however removal works.
- Removal may have started when the row carries that marker, or when an
  interrupted ARCHIVING row (startup recovery, or an in-process resume) already
  has its ref, which is written just before removal. Such an attempt skips the
  snapshot, and any failure keeps the marker.
- Setup retry refuses a FAILED row with the marker (availability, router, state
  machine and the conditional write). Every setup retry clears
  `initErrorMessage`, so the marker cannot outlive a workspace becoming active,
  and an ARCHIVED workspace has no path back.

The ref rule applies only to ARCHIVING rows: a READY or FAILED row without the
marker is always snapshotted, so a ref left by an older attempt can never stop a
later snapshot of an active workspace.

Rejected: a schema column recording that removal started. The marker and the ref
answer the same question without a migration, and the marker is already what the
user sees.

Rejected: committing deletions only below a threshold. Agents delete files
legitimately; the snapshot must instead never run on a worktree that removal may
have touched.

## Consequences

- Archive refs accumulate under `refs/factory-factory/archive/`; removing them
  belongs with branch cleanup.
- A workspace rolled back to READY by an incomplete archive before this change
  carries neither marker nor ref, so archiving it again still snapshots it.
- Deletion uses the same snapshot rule before removing the worktree.
