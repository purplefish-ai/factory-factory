# Snapshot orchestration

What writes the workspace snapshot store: the event collector, which turns
domain events into store updates, and periodic reconciliation, which repairs the
store from the database, session runtime and Git. The
[snapshot store guide](../../services/workspace/service/snapshot/AGENTS.md)
covers how updates merge. Bare file names below are in this directory; paths
that start with `src/` are from the repository root.

## Owns, and does not own

This directory owns the collector's subscriptions and per-workspace coalescing,
the projection of committed creation and state-change rows, PR collection and
monitoring projection, PR side effects (Linear completion, PR-opened notices to
a parent), initial-metadata scheduling on committed user messages, and the
reconciliation pass with its seed barrier and drift log. It does not own:

- The store, its clocks and derived state: `src/backend/services/workspace/`.
- Git stats and their cache:
  `src/backend/services/workspace-git-state.service.ts`.
- Sending snapshots to clients:
  `src/backend/routers/websocket/snapshots.handler.ts`.
- Metadata inference and its queue:
  `src/backend/orchestration/workspace-lifecycle/`.
- Ratchet events and PR monitoring: `src/backend/orchestration/pull-requests/`.

## Public surface

There is no barrel. `src/backend/app-context.ts` composes the collector
(`event-collector.orchestrator.ts`) and `SnapshotReconciliationService` with
every runtime dependency; the snapshot socket waits on `waitForSeed()` before
its first full snapshot.

## Invariants

- Reconciliation seeds the database and runtime fields of every workspace it can
  project and releases the seed barrier before any Git work starts.
  `snapshot-reconciliation.streaming.test.ts`.
- A failed Git read keeps a workspace's cached stats, and a workspace without a
  worktree is cleared to null. `snapshot-reconciliation.streaming.test.ts`.
- A workspace whose runtime snapshot fails is skipped while the others seed,
  stale entries are removed and Git refreshes.
  `snapshot-reconciliation.orchestrator.test.ts`.
- Reconciliation removes an entry missing from its read only if the store has
  observed nothing for it since the read began.
  `snapshot-reconciliation.streaming.test.ts`.
- Every snapshot input field is either compared by drift detection or
  deliberately excluded. `snapshot-reconciliation-field-contract.test.ts`.
- The PR projection worker loads only `@/shared/core` at runtime; reads,
  publication and logging are injected, so it has no GitHub, delivery, session
  or Linear dependency. `ratchet-projection.worker.boundary.test.ts`.
- Stopping the collector detaches every listener it registered, and a restart
  registers each once. `event-collector.orchestrator.test.ts`,
  `event-collector-lifecycle.integration.test.ts`.

## Map

- `event-collector.orchestrator.ts`: subscriptions to the workspace state
  machine, activity, run-script, session domain, PR snapshot and ratchet events;
  `EventCoalescer` batches each workspace's fields for 150 ms unless an event is
  immediate.
- `ratchet-projection.worker.ts`: one worker per collector lifetime; it reads
  the authoritative PR collection and monitoring projection, retries, and drops
  results after archive or stop.
- `pr-event-projection.ts`: whether a PR switch needs that projection.
- `linear-merge-completion.orchestrator.ts`: completes a linked Linear issue
  once per merged PR and collector lifetime.
- `workspace-branch-publication.orchestrator.ts`: publishes accepted branches
  straight to the store, skipping coalescing.
- `snapshot-reconciliation.orchestrator.ts`: a `jobRunner` job that runs at
  start, then 60 seconds after each run completes, Git included. It is a repair
  path, not a staleness bound: slow Git work, the next database read or a failed
  run delay the next repair.

## Decisions

- [The board never waits for Git](../../../../docs/decisions/2026-11-13-the-board-never-waits-for-git.md)
