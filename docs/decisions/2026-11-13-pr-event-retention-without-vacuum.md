# The PR event ledger prunes unread facts in bounded batches, without VACUUM

Originally decided on 2026-11-03 in #2858; settled deliveries and old review
lists were added on 2026-11-22.

## Context

`WorkspacePREvent` grew without limit. On a copy of a real 109 MB database the
ledger's payloads were 56 MB across 2,153 rows, mostly superseded review facts
that each copy the whole observation (32–80 KB). About 72% of those bytes were
in rows that no reader would use again. Delivered facts and their
`WorkspacePRDelivery` rows were then kept forever, and facts written before
#3288 still carry every review body of their PR in `payload.observation`.

## Decision

A `pr-event-retention` job, registered beside `pr-event-poll`, runs every 30
minutes in three passes. Each works in batches of separate short writes, at most
20 per run, yields between batches and stops on shutdown.

1. Unclaimed SUPERSEDED and CANCELLED facts, and PENDING facts of ARCHIVED
   workspaces, older than 24 hours: 100 per delete, oldest first, read through
   the `(state, createdAt)` index.
2. Settled delivery units, 25 per transaction: a DELIVERED, CANCELLED or
   SUPERSEDED delivery whose `claimedAt` and `deliveredAt` are unset or over 24
   hours old goes with all its members, or not at all, when its membership is
   exactly what `getFrozenDeliveryMembers` accepts and every member is a PR fact
   older than 24 hours, has no legacy receipt column, and belongs to an ARCHIVED
   workspace or has a `<prId>:epoch:<n>:` key with `n` below its workspace's
   `eventEpoch`. Candidates come from `Workspace.status`, `(workspaceId, state)`
   and two ranges of `(prId, deduplicationKey)` either side of the current
   prefix.
3. Review lists: facts that parse as PR facts get
   `observation.actionableReviews` set to `[]` and
   `observation.resolvedReviewIds` removed, in SQL, so the rest of the stored
   text is unchanged. One pass in ID order, 100 rows a window, is done once it
   reaches the end, since facts are no longer written with the list, until a
   PR-event backup restore starts it again.

Only rows no reader uses are eligible. The reducer (`listForPR`) reads only its
PR's current-epoch prefix and the epoch only grows. Turning monitoring off, or
changing the recipient while it is off, renews nothing: facts from before stay
in the current epoch, and are kept, until monitoring next turns on and renews it
(stating afresh every fact that holds). ARCHIVED is final, and polling and
claims require READY. Every key embeds the PR's transition sequence, which only
grows, so no pruned key is regenerated. Pending counts, `listPending`, receipt
recovery and claim transitions read only PENDING, DISPATCHING and BLOCKED
deliveries, and treat a missing delivery as settled. Backup export rejects a
delivery with missing members, so the delete re-checks each unit and rolls back
on a count mismatch. Nothing in tRPC or the client shows delivered history.
(`CI_RECOVERED` was keyed by head and failure, and so kept, until its key gained
the sequence on 2026-11-22.)

Kept: live, BLOCKED, DISMISSED and unknown-state deliveries, legacy receipt or
frozen metadata and legacy `MONITORING_ENABLED` rows. In a workspace that is not
ARCHIVED (ARCHIVING can roll back to READY), the current epoch is kept too,
including for detached PRs, because re-attaching reuses the row and its epoch;
and every fact is kept when the workspace has no monitoring row, since its epoch
is then unknown.

The app does not run `VACUUM`. It rewrites the whole database under an exclusive
lock and needs temporary space about the size of the database, and enabling
incremental vacuum would itself require a full `VACUUM` first.

## Consequences

- Deleted pages return to SQLite's free list for later writes; the file does not
  shrink. Compact a large database manually while the app is stopped.
- Logical backups omit pruned facts and deliveries; an import cancels unclaimed
  pending facts anyway.
- A live workspace keeps every delivered fact of its current epoch: about one
  row per CI failure, recovery, conflict change and review comment sent, plus
  one delivery per update. They go once the epoch renews (monitoring turns on,
  the recipient changes while it is on, or the mode changes) or the workspace is
  archived; slimmed, each is a few KB.
- A unit with a `recovered:` member (receipt recovery after a detach) is kept
  until its workspace is archived.
- The review-list pass reads every payload once per process start and again
  after each PR-event backup restore.
