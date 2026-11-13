# Background polling stops merged PRs and backs off closed ones

Originally decided on 2026-11-02 in #2810.

## Context

READY workspaces kept fully observing PRs that were already merged or closed,
every two minutes from the PR event poll and every three minutes from the
stale-data scheduler. Each observation spawns several `gh` processes and spends
the user's GitHub budget, yet a merged PR cannot change and a closed PR rarely
does. Terminal events (merge, close) still had to reach the agent.

## Decision

Both background schedulers pace terminal PRs from the stored per-association
observation. Once a MERGED observation has committed its transition and events
for the current monitoring epoch, background observations of that association
stop. CLOSED PRs are observed again after 30 minutes, so a reopened PR returns
to the normal cadence on a later pass. A new monitoring epoch (enabling, or
changing the destination or recipient) first initializes the PR's facts, then
applies the backoff.

Forced observations stay unrestricted: explicit refreshes (Kanban sync, PR
attachment) and delivery preparation's freshness check always read GitHub.

## Consequences

- Every poll still wakes pending deliveries, so terminal events, receipt
  recovery and frozen retries are delivered even when no association is observed
  any more. Monitoring stays enabled and open siblings keep their cadence.
- A merge is observed once, because the committed state stays open until a
  MERGED observation is accepted.
- A PR reopened on GitHub can take up to 30 minutes to appear without an
  explicit refresh.
