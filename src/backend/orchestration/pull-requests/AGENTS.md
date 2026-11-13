# Pull request orchestration

PR monitoring: when to observe attached PRs, and how accepted facts reach an
agent conversation as a PR update; also PR status sync, discovery and
review-request visibility. The [services guide](../../services/AGENTS.md) covers
the capsules this code coordinates.

## Owns, and does not own

This directory owns the coordination: the PR event poll and ledger retention
jobs, observation pacing and coalescing, monitoring enablement and recipient
binding, dedicated-conversation bootstrap, delivery preparation, claim, final
guards and receipt recovery, and the cutover from the legacy Ratchet fixer. It
does not own:

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

There is no barrel. Other code calls only these:

- `createRatchetService` (`ratchet-dependencies.ts`): one graph's
  `RatchetService`, called by the server, the workspace router and the snapshot
  collector, which also consumes its `RATCHET_*` events.
- `schedulerService` (`scheduler.service.ts`): PR status sync and discovery.
- `bindIssueMonitoringSession` (`pr-monitoring.orchestrator.ts`).
- `listVisibleReviewRequests` (`review-requests.orchestrator.ts`).
- Delivery and observation wiring for
  `src/backend/orchestration/domain-bridges.orchestrator.ts`:
  `createPRDeliveryPorts`, `createPRBackgroundDeliveryPort`, `wakePRDelivery`,
  `createPRObservationPorts`, `observeMonitoredPR`, `resetStablePRBackoff`.

## Invariants

Paths below are in this directory unless they say otherwise.

- The observation producer imports no runtime backend module and receives
  exactly five capabilities. `.dependency-cruiser.cjs` (`pr-observation-*`),
  `pr-observation.import-boundary.test.ts`.
- Only an observation accepted by the revision and epoch guard publishes a
  transition, and its delivery wake runs after the transaction commits.
  `pr-observation.orchestrator.test.ts`.
- Poll, refresh and delivery wrappers of one application graph share one
  observation cache scope; separate graphs share none.
  `pr-observation.orchestrator.test.ts`.
- Unforced observations honour the reuse window and terminal and stable backoff;
  forced ones (explicit refresh, attachment, delivery preparation) always read
  GitHub. `pr-observation.orchestrator.test.ts`,
  `ratchet-observation-watcher.test.ts`.
- Delivery forces a fresh observation before freezing an update and rechecks the
  binding afterwards. `pr-event-delivery.orchestrator.test.ts`.
- A workspace has at most one claimed PR delivery, across main and dedicated
  conversations. `pr-event-flow.integration.test.ts`,
  `src/backend/services/workspace/resources/workspace-pr-delivery-modes.accessor.integration.test.ts`.
- A retry resends the frozen text and event set and never reads GitHub.
  `pr-event-delivery.batching.test.ts`.
- Only provider-owned history proves receipt; without proof, delivery pauses or
  retries in the same conversation and never resends elsewhere.
  `pr-event-delivery.orchestrator.test.ts`,
  `src/backend/services/session/service/delivery/session-pr-receipt.test.ts`.
- Delivery state follows the typed failure reason, never message text.
  `pr-event-delivery-port.test.ts`.
- Only ordinary conversations become the main recipient, and binding one queues
  no message. `pr-monitoring.orchestrator.test.ts`.
- Stopping the service invalidates and drains every in-flight observation and
  delivery wake. `ratchet-observation-watcher.test.ts`.
- The poll checks at most three workspaces at once.
  `ratchet-observation-watcher.test.ts`.
- Review requests are scoped to the project's repository and never fall back to
  a global search. `src/backend/trpc/pr-review.router.test.ts`,
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
- `review-requests.orchestrator.ts`: hides requests of archived workspaces.

## Decisions

Records in `docs/decisions/` hold the reasons:

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
