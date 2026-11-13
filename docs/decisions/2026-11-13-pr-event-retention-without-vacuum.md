# The PR event ledger prunes unread facts in bounded batches, without VACUUM

Originally decided on 2026-11-03 in #2858.

## Context

`WorkspacePREvent` grew without limit. On a copy of a real 109 MB database the
ledger's payloads were 56 MB across 2,153 rows, mostly superseded review facts
that each copy the whole observation (32–80 KB). About 72% of those bytes were
in rows that no reader would use again.

## Decision

A `pr-event-retention` job, registered beside `pr-event-poll`, runs every 30
minutes. It deletes unclaimed SUPERSEDED and CANCELLED facts, and PENDING facts
of ARCHIVED workspaces, older than 24 hours, in batches of 100, oldest first, at
most 20 batches per run. Each batch is a separate short write that re-checks the
predicate; the loop yields between batches and stops on shutdown. A
`(state, createdAt)` index serves this cross-workspace query so it reads only
old rows in those states.

Only facts no reader uses are eligible. Delivery members, legacy receipt or
frozen metadata, DISPATCHING and DELIVERED rows, `CI_RECOVERED` and legacy
`MONITORING_ENABLED` rows are kept. Eligible kinds are those whose deduplication
key includes the PR's transition sequence, which only increases, so the reducer
can never regenerate a pruned key. ARCHIVED workspaces cannot return to READY
and claims require READY, so their pending facts can never be delivered.
ARCHIVING workspaces keep theirs, because a failed archive rolls back to READY.

The app does not run `VACUUM`. It rewrites the whole database under an exclusive
lock and needs temporary space about the size of the database, and enabling
incremental vacuum would itself require a full `VACUUM` first.

## Consequences

- Deleted pages return to SQLite's free list for later writes; the file does not
  shrink. Compact a large database manually while the app is stopped.
- Logical backups omit pruned facts; an import cancels unclaimed pending facts
  anyway.
