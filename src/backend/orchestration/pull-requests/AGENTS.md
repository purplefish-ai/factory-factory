# Pull request orchestration

PR monitoring (when to observe attached PRs, and how accepted facts reach an
agent conversation as a PR update), PR status sync, discovery and review-request
visibility. The [services guide](../../services/AGENTS.md) covers the capsules
this code coordinates. Bare file names below are in this directory; paths that
start with `src/` are from the repository root.

## Owns, and does not own

This directory owns the coordination: the PR event poll and ledger retention
jobs, observation pacing and coalescing, monitoring enablement and recipient
binding, dedicated-conversation bootstrap, delivery preparation, claim, final
guards, receipt recovery and the legacy Ratchet fixer cutover. It does not own:

- GitHub reads, `gh` spawn limits, read caches and normalized observation
  fetching: `src/backend/services/github/`.
- PR rows, the monitoring binding, the event ledger, frozen deliveries and the
  discovery schedule: the workspace capsule's `WorkspacePR*` accessors in
  `src/backend/services/workspace/resources/`.
- Which observations become events: the pure `src/shared/pr-trigger-policy.ts`.
- The session queue, dispatch, receipt lookup and failure classification:
  `src/backend/services/session/`.
- Update wording: `src/backend/prompts/pr-event.ts`.
- Snapshot projection and PR side effects (Linear completion, PR-opened
  notices): `src/backend/orchestration/snapshots/`.
- Attaching PR URLs that agents print: `src/backend/interceptors/`.

## Public surface

There is no barrel. Production code elsewhere imports only these:

- Composition in `src/backend/app-context.ts`: `createRatchetService`
  (`ratchet-dependencies.ts`), `schedulerService`, `bindIssueMonitoringSession`
  and `listVisibleReviewRequests`. Other code uses the built `RatchetService`.
- `src/backend/orchestration/domain-bridges.orchestrator.ts`: the delivery and
  observation ports (`pr-*-dependencies.ts`, `pr-event-delivery-port.ts`),
  `wakePRDelivery`, `observeMonitoredPR`, `resetStablePRBackoff` and
  `listVisibleReviewRequests`.
- `src/backend/orchestration/snapshots/`: the `RATCHET_*` events and the
  `RatchetService` type (`ratchet.service.ts`).

## Invariants

- The observation producer imports no runtime backend module and receives five
  function capabilities and a cache scope. The `pr-observation-*` rules in the
  root [`.dependency-cruiser.cjs`](../../../../.dependency-cruiser.cjs),
  `pr-observation.dependency-boundary.test.ts`,
  `pr-observation.import-boundary.test.ts`.
- Only an observation accepted by the revision and epoch guard publishes a
  transition, and only after its transaction commits.
  `pr-observation.orchestrator.test.ts`.
- Poll, refresh and delivery ports composed from one services object share one
  observation cache scope; separately composed graphs share none.
  `pr-event-flow.integration.test.ts`, `pr-observation.orchestrator.test.ts`.
- Unforced observations honour the 90-second reuse window and the terminal and
  stable backoff; forced ones always read GitHub and restart the stable count.
  `pr-observation.orchestrator.test.ts`, `ratchet-observation-watcher.test.ts`.
- Delivery forces a fresh observation before freezing an update and rechecks the
  binding afterwards. `pr-event-delivery.orchestrator.test.ts`.
- A workspace has at most one claimed PR delivery at a time, whichever
  destination each targets.
  `src/backend/services/workspace/resources/workspace-pr-delivery-modes.accessor.integration.test.ts`,
  `pr-event-flow.integration.test.ts`.
- A retry resends the frozen text and event set and never reads GitHub.
  `pr-event-delivery.batching.test.ts`.
- After an uncertain exit, only the delivery marker in provider-owned history
  proves receipt; unreadable history pauses delivery, and a frozen message is
  never sent to another conversation. `pr-event-delivery.orchestrator.test.ts`,
  `src/backend/services/session/service/delivery/session-pr-receipt.test.ts`.
- Delivery state follows the typed failure reason, never message text.
  `pr-event-delivery-port.test.ts`.
- Only ordinary conversations become the main recipient, and binding one adds no
  message of its own. `pr-monitoring.orchestrator.test.ts`,
  `src/backend/services/workspace/resources/workspace-pr-delivery-modes.accessor.integration.test.ts`.
- Stopping the service invalidates its in-flight workspace checks, so none goes
  on to deliver or publish, and drains every delivery wake it started.
  `ratchet-observation-watcher.test.ts`.
- The poll checks at most three workspaces at once.
  `ratchet-observation-watcher.test.ts`.
- A project-scoped review-request list holds only that project's repository and
  fails, rather than searching globally, when the project is missing, unlinked
  or invalid; the unscoped workspace review count searches every repository.
  `src/backend/trpc/pr-review.router.test.ts`,
  `review-requests.orchestrator.integration.test.ts`.

## Map

- `ratchet.service.ts`: the PR event poll and retention jobs, per-workspace
  checks and wake tracking. "Ratchet" is the legacy name for PR monitoring.
- `ratchet-dependencies.ts`, `pr-monitoring-dependencies.ts`,
  `pr-delivery-dependencies.ts`: composition of one graph's services into ports.
  `pr-monitoring-ports.ts` and `pr-observation-ports.ts` declare them.
- `pr-observation.orchestrator.ts`: coalescing, reuse window and terminal and
  stable backoff around one observation.
- `pr-event-delivery.orchestrator.ts`: recipient, preparation, claim and final
  guard. `pr-event-delivery-port.ts` is the session capsule's callback port.
  `pr-delivery-recovery.ts` recovers uncertain claims;
  `pr-delivery-readiness.ts` and `pr-delivery-recipient.ts` check the recipient.
- `pr-monitoring.orchestrator.ts`: enable, destination and recipient changes.
- `pr-dedicated-session.orchestrator.ts`: lazy dedicated conversations.
- `pr-monitoring-cutover.orchestrator.ts`: legacy fixer retirement at startup.
- `scheduler.service.ts`: PR status sync and branch discovery.
- `review-requests.orchestrator.ts`: repository scoping, then the workspace
  filter that hides PRs attached only to archived or archiving workspaces.

## Decisions

- [PR updates go to the workspace's own conversations](../../../../docs/decisions/2026-11-13-pr-updates-go-to-workspace-conversations.md)
- [PR updates do not grant merge authorization](../../../../docs/decisions/2026-11-13-pr-updates-do-not-grant-merge-authorization.md)
- [Deliveries are frozen and proven by receipt](../../../../docs/decisions/2026-11-13-pr-deliveries-are-frozen-and-proven-by-receipt.md)
- [Delivery resumes the exact conversation](../../../../docs/decisions/2026-11-13-pr-delivery-resumes-the-exact-conversation.md)
- [Delivery failures are typed](../../../../docs/decisions/2026-11-13-pr-delivery-failures-are-typed.md)
- [Observation receives explicit capabilities](../../../../docs/decisions/2026-11-13-pr-observation-receives-explicit-capabilities.md)
- [Terminal PR polling backoff](../../../../docs/decisions/2026-11-13-terminal-pr-polling-backoff.md)
- [Stable PR polling backoff](../../../../docs/decisions/2026-11-13-stable-pr-polling-backoff.md)
- [Core-only observation while monitoring is off](../../../../docs/decisions/2026-11-13-core-only-pr-observation-while-monitoring-is-off.md)
- [Polling reads observation presence only](../../../../docs/decisions/2026-11-13-pr-polling-reads-observation-presence-only.md)
- [Event retention without VACUUM](../../../../docs/decisions/2026-11-13-pr-event-retention-without-vacuum.md)
- [Review-request and gh health caching](../../../../docs/decisions/2026-11-13-review-request-and-gh-health-caching.md)
