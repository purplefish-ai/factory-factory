# PR observation receives explicit capabilities

Originally decided on 2026-10-27 in #2544.

## Context

Polling, manual refresh, attachment, discovery and delivery preparation all read
a PR's normalized facts from GitHub and accept them atomically. The observation
code accepted narrow-looking ports but imported the default monitoring graph,
which pulled session runtime, chat and delivery code into the producer and tied
its caches to a process-wide default.

## Decision

`pr-observation.orchestrator.ts` receives five function capabilities through
`PRObservationPorts`: find the PR, read the monitoring configuration, fetch a
normalized observation, accept it atomically, and publish an accepted
observation. It imports no runtime backend module and receives no service
objects or event emitters. Composition supplies an opaque `cacheScope`, keyed by
the application's services object, that every poll, refresh and delivery wrapper
of one application graph shares. There is no process-default services object for
the PR pipeline; each caller receives it explicitly.

## Consequences

- In-flight coalescing and the recent-observation window are shared within one
  application graph and isolated between graphs, so tests can compose several
  graphs in one process.
- Dependency-cruiser rules and the import-boundary tests in
  `src/backend/orchestration/pull-requests/` fail if the producer or its ports
  import application code.
- Delivery receives a `refreshObservation` callback from composition rather than
  calling the producer itself.
