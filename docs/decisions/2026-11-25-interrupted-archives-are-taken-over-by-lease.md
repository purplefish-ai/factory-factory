# Interrupted archives are taken over by lease

Decided on 2026-11-25, after a mass archive interrupted by quitting the desktop
app left workspaces ARCHIVING.

## Context

Recovery of an ARCHIVING row ran once, at startup, for rows written over 10
minutes earlier. A request for an ARCHIVING row this process had not abandoned
was acknowledged without doing anything, because age alone could not prove that
another process sharing the database had stopped. A row interrupted less than 10
minutes before a restart stayed ARCHIVING, read-only, until a later restart.

## Decision

- An ARCHIVING row's `updatedAt` is its archive's lease. The archive that set
  ARCHIVING or claimed the row renews it every 15 seconds on a timer, so a slow
  step (a session stop, a snapshot of a large worktree) never delays renewal.
  The timer ends with its archive; it is not recurring work for `jobRunner`.
- A lease not renewed for 2 minutes is stale: eight renewals missed. With
  removal now a rename, an archive takes seconds, and renewal does not depend on
  its steps, so the old 10-minute margin bought nothing.
- Taking a row over needs a claim: a compare-and-swap that moves `updatedAt`
  from the value the claimer read to a later one, only while the row is
  ARCHIVING. Of several processes that read the same value, one wins. A row this
  process abandoned after a failed status write resumes at once, still through a
  claim, but only while `updatedAt` is the value its own lease last wrote; any
  other ARCHIVING row is claimed only once stale, and a fresh one is
  acknowledged as before.
- The `archive-recovery` job runs at start and every 2 minutes. It resumes up to
  10 stale rows, oldest first, through `archiveWorkspace`, so a user's request
  for the same row joins it and `withArchiveExcluded` refuses it during a
  delete; rows this process is archiving or deleting are skipped. A user's
  archive of a stale row claims it the same way.
- A takeover goes forward under the rules of
  [archive moves forward after its snapshot](2026-11-25-archive-moves-forward-after-its-snapshot.md):
  no snapshot once the ref exists, and a failure after removal may have started
  leaves FAILED with the marker. A taken-over row has no known previous status,
  so any other failure also leaves FAILED, as startup recovery did.
- At most every 30 minutes the job also removes up to 20 Git registrations left
  for ARCHIVED workspaces: registered at `<canonical base>/workspace-<id>` of
  the workspace's own project, unlocked, with nothing at that path. Each goes by
  deleting only its admin directory, `<git common dir>/worktrees/<name>` whose
  `gitdir` names that path, which is what `git worktree prune` does for one
  entry. Never a repo-wide prune (see
  [worktree removal](2026-11-25-worktree-removal-detaches-then-reclaims.md)),
  and never `git worktree remove`, which would delete a directory that reappears
  at the path between the check and the removal. A directory there stays with
  the admin orphaned-worktree cleanup.

Rejected: an owner column (process ID or instance token). It needs a migration
and still cannot tell a live owner from a dead one without a heartbeat, which
`updatedAt` already provides.

Rejected: renewing as a compare-and-swap on the lease's own last value, so an
owner notices a takeover. Any other write to the row also moves `updatedAt`, and
would abort a healthy archive.

Rejected: renewing from the recovery job. A run that resumes an archive can last
longer than the threshold, and the leases of archives running meanwhile would go
stale.

## Consequences

- An interrupted archive finishes within about 4 minutes of its last renewal
  once any process is running, without a restart.
- A process suspended for more than 2 minutes (a sleeping laptop, with a second
  process on the same database) can be overtaken mid-archive. Both then run;
  removal converges and status writes are compare-and-swap on status, so the row
  ends ARCHIVED, or FAILED for the user to archive again.
- Held by `workspace-archive-concurrency.test.ts`,
  `workspace-archive.orchestrator.test.ts` and
  `workspace-archive-recovery.orchestrator.test.ts` in
  `src/backend/orchestration/workspace-lifecycle/`; `archive-lease.*.test.ts` in
  `src/backend/services/workspace/service/lifecycle/`; and
  `archived-worktree-registration.integration.test.ts` and
  `worktree-registration-admin.integration.test.ts` in its `service/worktree/`.
