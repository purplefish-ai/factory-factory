# The board never waits for Git

Originally decided on 2026-07-28 in #2053, and extended on 2026-09-09 in #2232.

## Context

`workspace.listForProject` used to recompute Git stats for every live workspace
before it returned. Each worktree cost several `git` spawns and they ran a few
at a time, so the board stayed on its loading state until the last one finished:
about 20 seconds over 68 worktrees. Snapshot reconciliation, in turn, computed
every workspace's Git stats before it published the database and runtime fields,
so one slow worktree held back the rest of the board.

## Decision

`gitStats` is a reconciliation field. The list endpoint serves it from the Git
state cache and returns null on a miss, starting a background warm instead of
spawning `git` on the response path. Reconciliation publishes database and
runtime fields first, then computes Git stats with bounded concurrency and
publishes each workspace as its commands finish.

Rejected: awaiting the recompute in the list response, which the snapshot poll
already does every minute and streams into the same cache; and computing all Git
stats before seeding, which made the slowest worktree the latency of the whole
board.

## Consequences

- A card can lack its diff badge for a moment; before, the whole board was
  missing.
- A failed Git refresh keeps the last known stats rather than clearing a badge
  the user has seen.
- Git stats need their own optional timestamp group, so the seed and the later
  Git update can share one poll-start timestamp without weakening either field's
  stale-update protection.
