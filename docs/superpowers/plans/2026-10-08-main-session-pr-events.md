# Main Session PR Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace separate Ratchet fixers with durable CI, review, and
merge-conflict events queued into the existing main conversation.

**Architecture:** Keep PR discovery and GitHub observation, replace fixer
dispatch history with an event ledger, and deliver through the ordinary session
queue. Workspace resources own configuration and event writes; orchestration
connects GitHub observations, lifecycle guards, and source-aware session
delivery. Both providers retain their conversation identities and settings.

**Tech Stack:** TypeScript, Prisma/SQLite, Express/tRPC, React, ACP, Vitest,
Storybook, Node >=26.8.1, and pnpm 12.4.2.

**Spec:**
[Approved design](../specs/2026-10-08-main-session-pr-events-design.md).

## Global Constraints

- This is the sole replacement for the current Ratchet implementation; there is
  no legacy/new mode selector.
- Events arriving during a turn queue for the next turn. Do not interrupt the
  active turn or add provider-specific steering.
- Observe every associated, non-detached PR.
- An explicit session stop durably pauses automated delivery until the user
  explicitly resumes that session.
- Tab focus, latest activity, provider defaults, and newly created sessions
  never change the binding.
- Background messages inherit current session settings at dispatch.
- Monitoring does not authorize automatic merging.
- Keep the existing two-minute polling cadence, `jobRunner` lifecycle, GitHub
  CLI rate budget, fetch coordination, shutdown cancellation, and review
  filtering. The inspected `SERVICE_INTERVAL_MS.ratchetPoll` is `120_000`; this
  corrects the architecture note's outdated one-minute description.
- Use Node >=26.8.1 and pnpm 12.4.2.
- Keep sole model writers in workspace resources, cross-service coordination in
  orchestration, and boundary validation in specific Zod schemas.
- Preserve parent/child notifications, auto-iteration, adversarial review,
  session stop barriers, and multi-PR aggregate archive rules.

## Review Focus

1. A stale enable/rebind request finishing after a stop must not unpause
   delivery or send to the old recipient; test in Tasks 1 and 4.
2. Incomplete check metadata must not invent reruns from poll times, and partial
   review pagination must not resolve omitted feedback; test in Task 2.
3. A cold session's resume failure must not call `newSession` or roll over its
   provider identity; test in Task 3 for both providers.
4. An optimistic local message followed by a crash must not count as provider
   receipt, while a provider-history marker must prevent duplicate delivery;
   test in Tasks 3 and 7.
5. Queue pressure and a second PR's merge must not lose another PR's pending
   events or stop the main session; test in Tasks 5 and 8.

## Dependency and file map

This plan depends on the multiple-PR storage and association work in
[the multiple-PR plan](2026-10-08-multiple-workspace-prs.md), Tasks 1 and 2.
Complete and verify those collection/discovery seams first. Its fixer Task 3 is
superseded entirely by this plan; its status and backup tasks must use the
interfaces below. Do not implement the obsolete single-fixer ownership design as
an intermediate product feature.

Run tasks sequentially: each produces interfaces used by the next. Developing
the new storage before switching runtime wiring is acceptable, but release only
the complete cutover. Do not add a user-selectable second mode or leave both
watcher jobs registered in the final tree. Preserve the unrelated work already
present in this worktree; stage only task-owned changes.

| Area                                    | Responsibility                                            |
| --------------------------------------- | --------------------------------------------------------- |
| `src/shared/schemas/pr-event.schema.ts` | Validated observation/event/delivery payloads             |
| `src/shared/pr-monitoring.ts`           | Shared types, eligibility, event reduction, IDs           |
| Workspace PR/monitoring/event resources | Atomic cache + ledger writes and guarded claims           |
| GitHub observation service              | One normalized full observation per PR                    |
| Session background-delivery service     | Source dispatch, settings inheritance, receipt recovery   |
| PR monitoring orchestration             | Recipient control, lifecycle fences, prepared delivery    |
| Ratchet service                         | Existing control name, new observation-only watcher       |
| Shared snapshots + client features      | Delivery status, recipient selection, PR update rows      |
| Backup orchestration + migrations       | Legacy import, safe fixer retirement, ledger preservation |

## Task 1: Event contracts and durable workspace state

**Files:**

- Create: `src/shared/schemas/pr-event.schema.ts`,
  `src/shared/pr-monitoring.ts`, and their co-located tests.
- Create:
  `src/backend/services/workspace/resources/workspace-pr-monitoring.accessor.ts`,
  `src/backend/services/workspace/resources/workspace-pr-event.accessor.ts`,
  `src/backend/services/workspace/service/lifecycle/workspace-pr-monitoring.service.ts`,
  and co-located tests.
- Modify: `prisma/schema.prisma`, `src/backend/services/registry.ts`,
  `src/backend/services/workspace/resources/workspace-pr.accessor.ts`,
  `src/backend/services/workspace/service/lifecycle/workspace-pr-snapshot.service.ts`,
  and `src/backend/services/workspace/service/index.ts`.
- Create: `prisma/migrations/20261008130000_pr_event_ledger/migration.sql` and
  `src/backend/pr-event-ledger.migration.test.ts`.
- Generate: `prisma/generated/` with `pnpm db:generate`.

**Interfaces:**

- `PRTarget = { workspaceId: string; prId: string }`.
- `PRObservation`: identity (`url`, `repository`, `number`, `headSha`,
  `headBranch`, `baseBranch`), `observedAt`, `prState`, `ciStatus`,
  `reviewState`, `hasMergeConflict`, `checks`, `actionableReviews`, and
  `reviewsComplete`. Infer its type from the strict observation schema.
- Each check has `identity`, nullable `attempt`, `name`, nullable
  `workflowName`, `status`, nullable `conclusion`, `detailsUrl`, `startedAt`,
  and `completedAt`. Each review has `identity`, `contentHash`, `author`,
  `body`, nullable `path`/`line`, `url`, and its activity time.
- `PRMonitoringEventPayload`: discriminated union of `CI_FAILED`,
  `CI_RECOVERED`, `REVIEW_FEEDBACK`, `CONFLICT_DETECTED`, `CONFLICT_CLEARED`,
  `PR_MERGED`, `PR_CLOSED`, and trusted `MONITORING_ENABLED` control data. The
  enable control has no PR; other variants carry a `PRTarget` and the matching
  normalized facts. Never infer a PR from the first association.
- `PRDeliveryRequest = { workspaceId: string; prId: string | null; bindingRevision: number }`.
  A null PR targets only the enable instruction.
- `ClaimedPRDelivery = { deliveryId: string; sessionId: string; bindingRevision: number; eventIds: string[]; text: string; attempt: number }`.
- `workspacePRMonitoringService.get(workspaceId)` returns monitoring config;
  `setBinding({workspaceId, recipientSessionId, enabled, expectedBindingRevision})`
  returns `{applied, bindingRevision}`.
- `workspacePrSnapshotService.acceptMonitoredObservation({target, expectedPrRevision, observation, expectedEventEpoch})`
  returns `{applied: boolean; eventIds: string[]}`. Task 2 supplies its reducer.
- `claimDelivery(request, {deliveryId, sessionId, eventIds, text})` returns a
  `ClaimedPRDelivery` or null;
  `settleDelivery({deliveryId, sessionId, bindingRevision, result: 'delivered' | 'retry' | 'failed'})`
  returns boolean. Expose both through `workspacePRMonitoringService`.

- [ ] **Write failing schema, resource, and SQLite migration tests.** Assert
      invalid/cross-workspace PR targets reject, duplicate event keys yield one
      row, two simultaneous claims yield one delivery, and a stale revision
      cannot overwrite disable/rebind/stop. Assert deleting a recipient nulls
      the binding and preserves config; deleting a workspace cascades event
      rows. Name the CAS regression `rejects a stale binding after stop` and
      assert `expect(result.applied).toBe(false)` with the original binding
      revision.
- [ ] **Run the new tests and confirm failure** with
      `pnpm test src/backend/pr-event-ledger.migration.test.ts` and the new
      workspace resource test files. Failure must be missing contracts/behavior,
      not a fixture or dependency error.
- [ ] **Define the shared schemas and types.** Use ISO datetime validation and
      nullable fields only where the contracts allow them. Control data contains
      the binding revision and reply policy, without GitHub text. Persist all
      JSON through these schemas, rejecting corrupt rows with a visible blocked
      state.
- [ ] **Add monitoring and event models in the additive migration.** Config
      stores `enabled`, `recipientSessionId`, `bindingRevision`, `eventEpoch`,
      nullable `deliveryPauseReason`, and `lastCheckedAt`. `eventEpoch`
      increments only on disabled-to-enabled transitions; binding revision
      changes on target, enable, pause, or resume changes. Copy old
      enabled/check values into config without selecting an ambiguous recipient;
      retain legacy tables until cutover. Event rows store workspace/nullable PR
      FK, kind, dedup key, payload, timestamps, state, attempt count, and
      nullable delivery ID/session/revision/text/claim time. Index foreign keys
      and pending delivery queries. Add uniqueness on `(prId, deduplicationKey)`
      and `(workspaceId, deduplicationKey)` for null-PR control-event
      deduplication. Use states `PENDING`, `DISPATCHING`, `DELIVERED`,
      `SUPERSEDED`, and `CANCELLED`. Exhausted transport retries retain a
      pending frozen group and pause the config; they do not create a sixth
      receipt state.
- [ ] **Implement sole-writer operations and atomic acceptance.** Add a nullable
      validated observation baseline and transition sequence to each PR. The
      existing PR accessor owns their writes. It composes sibling event resource
      transaction helpers so accepted cache + baseline + event inserts commit
      together. Rejected revisions insert nothing. Claims freeze the exact
      group/text; acknowledgements match its session/revision/delivery ID.
- [ ] **Run the tests, `pnpm check:ownership`, and `pnpm check:prisma-schema`;
      expect success.** Commit only Task 1 files with subject
      `Add durable PR monitoring events`.

## Task 2: Full observations, event reduction, and bounded messages

**Files:**

- Create: `src/backend/services/github/service/pr-observation.service.ts`,
  `src/backend/prompts/pr-event.ts`, and co-located tests.
- Modify: `src/backend/services/github/service/github-cli.service.ts`,
  `src/backend/services/github/service/github-cli/schemas.ts`,
  `src/backend/services/github/service/github-cli/types.ts`,
  `src/backend/services/github/service/pr-snapshot.service.ts`,
  `src/backend/services/github/service/bridges.ts`,
  `src/backend/services/github/service/index.ts`, and Task 1's shared/resource
  files.
- Extract reusable review filtering from
  `src/backend/services/ratchet/service/ratchet-pr-state.helpers.ts` into
  `src/backend/services/github/service/pr-actionable-review.ts` and tests.
- Test: existing GitHub full-detail, deleted-author, pagination, review-order,
  and adversarial-review-trigger tests with their retained assertions.

**Interfaces:**

- `prObservationService.fetch(target: PRTarget, signal?: AbortSignal): Promise<PRObservation>`
  uses the association's exact repository/number.
- `reducePRObservation({target: PRTarget, previous: PRObservation | null, current, transitionSequence, eventEpoch, pendingEvents, deliveredEvents}): {events: PREventDraft[]; supersededEventIds: string[]; nextTransitionSequence: number}`
  lives in `src/shared/pr-monitoring.ts`.
  `PREventDraft = {kind; deduplicationKey: string; payload: PRMonitoringEventPayload}`.
  `pendingEvents` and `deliveredEvents` are readonly lists of
  `{id: string; kind; payload: PRMonitoringEventPayload}` from this PR/epoch.
  Pending IDs permit supersession; delivered failures provide the evidence for
  recovery notifications.
- `buildPREventMessage({deliveryId, events, replyToPrComments}): string` formats
  one PR batch or one enable control, with no full CI log injection.
- `PR_EVENT_MESSAGE_ID_PREFIX = 'pr-event-'` and provider marker
  `<!-- factory-factory-pr-event:DELIVERY_ID -->` live in the shared module.

- [ ] **Write failing reducer/formatter and observation tests.** Include initial
      red, repeated red, new head, same-head rerun, failure-to-recovery before
      delivery, recovery after delivered failure, review edits/resolution,
      conflict-clear-conflict recurrence, and merged/closed/reopened recurrence.
      Assert null/missing run data does not become success; partial reviews do
      not remove omitted feedback; no event key contains `observedAt` alone.
      Name the duplicate regression `does not reemit unchanged failures` and
      assert `expect(reduction.events).toEqual([])` on the second identical
      observation.
- [ ] **Run the new shared, observation, and prompt tests; confirm red.**
- [ ] **Implement full GitHub observation collection.** Add `headRefOid` and
      preserve native check/run IDs and attempt metadata when available. Obtain
      missing identity/activity details through the existing `GitHubCLIService`
      API path and validate responses. Stable fallback identities use reported
      check details/run times, never poll time. If a run cannot be
      distinguished, do not manufacture a rerun. Keep check IDs, workflow names,
      status casing, and legacy status contexts through normalization.
      Incomplete fetches must not be accepted as a complete replacement
      observation.
- [ ] **Move and test review filtering within GitHub.** Keep existing review
      chronology, unresolved-thread exclusion, deleted authors, authenticated
      adversarial marker handling, caps, and trigger-mode semantics. Return
      feedback identities/content hashes, not only flattened prompt bodies.
      `reviewsComplete=false` preserves previously pending feedback omitted by
      pagination limits; explicitly fetched resolution can supersede it.
- [ ] **Implement reduction inside Task 1's accepted transaction.** Hash stable
      CI identities/head/attempt/outcome and review identity/content version
      with `target.prId` and `eventEpoch`; use persisted transition sequence for
      recurring conflict and terminal transitions. Seed current actionable facts
      once after enable or attachment. Cancel obsolete pending events, never
      alter delivered history. Review feedback can emit while CI is pending.
      Initial green and ordinary PR conversation comments emit nothing. Terminal
      PRs cancel their pending fixes but can retain one terminal information
      event.
- [ ] **Implement the formatter and persist frozen delivery text.** Include
      exact PR/repository/head/branch, observation time, changed facts, and
      links. Escape review JSON as the old prompt does and identify it as
      untrusted. Start enable controls with the spec's short keep-the-PRs-moving
      instruction plus the current reply policy; later messages carry changed
      facts. Use a 16,384 UTF-8 byte application cap, reserving space for
      marker, identity, links, and an explicit omitted-count notice. Truncate
      whole feedback/check items first, preserving Unicode boundaries and every
      member event ID in the ledger; large bodies can be inspected via their
      links. This cap is a new application bound, not a claim about provider
      limits.
- [ ] **Apply the latest trusted reply policy on review-feedback batches.** A
      preference change takes effect at the next review delivery, with a short
      policy line rather than repeating the enable workflow instruction.
- [ ] **Run new and retained review/GitHub tests plus `pnpm typecheck`; expect
      success.** Commit with subject
      `Derive PR events from shared observations`.

## Task 3: Source-aware queue dispatch and strict provider resume

**Files:**

- Create:
  `src/backend/services/session/service/lifecycle/session-background-delivery.service.ts`
  and co-located tests.
- Modify: `src/shared/acp-protocol/protocol/queued.ts`,
  `src/shared/websocket/chat-message.schema.ts`,
  `src/backend/services/session/service/store/session-queue.ts`,
  `src/backend/services/session/service/chat/chat-message-handlers.service.ts`,
  handler `types.ts`, `queue-message.handler.ts`, and `user-input.handler.ts`.
- Modify: lifecycle `session-core-services.ts`, `session-services.ts`,
  `session-startup.coordinator.ts`, `session.lifecycle.service.ts`, and session
  service barrels; ACP `types.ts` and `acp-client-factory.ts`.
- Test: new background delivery, existing session queue/handler/startup/factory,
  session notification delivery, and stop barrier tests.

**Interfaces:**

- Add optional backend-owned
  `source: {type: 'pr_event'; request: PRDeliveryRequest}` to `QueuedMessage`;
  no source continues to mean the existing human-message path. Existing
  workspace notifications retain their existing mechanism. Validate source tags
  on backend snapshots; reject source tags and reserved PR-event IDs on client
  input.
- `PRBackgroundDeliveryPort.prepare({sessionId, request}): Promise< {status: 'ready'; delivery: ClaimedPRDelivery} | {status: 'blocked'; reason: string} | {status: 'discard'}>`.
- Port methods `complete(delivery): Promise<void>` and
  `fail(delivery, error: unknown): Promise<void>` settle Task 1's claims.
  `recover(sessionId): Promise<void>` reconciles provider-history markers.
  Configure this port through session composition/orchestration.
- `sessionBackgroundDeliveryService.enqueue(sessionId, request): {queued: boolean; reason?: string}`
  reserves at most one queue token for each workspace/PR/binding revision.
  `invalidate(workspaceId, bindingRevision): void` removes only matching
  unstarted PR-event tokens.
- Add `resumePolicy?: 'allow_fallback' | 'require_existing'` to
  `AcpClientOptions` and session startup options. Omission preserves ordinary
  user startup. Background startup always passes `require_existing`.

- [ ] **Write failing source dispatch and ACP factory tests.** Use deferred
      turn/startup promises. Assert no send while busy, one send after
      completion, FIFO human-message order, preserved config, and rejection of
      spoofed source tags. Parameterize Claude/Codex resume failure and
      unsupported load: `expect(newSession).not.toHaveBeenCalled()`;
      `expect(onProviderIdentityRollover).not.toHaveBeenCalled()`.
- [ ] **Run the session queue/handler, background, startup, and factory tests;
      confirm the new assertions fail.**
- [ ] **Implement PR-source dispatch through the existing queue.** Prepare only
      after runtime/interactive/stop gates permit a new turn. Coalesce using the
      returned frozen delivery; replace the placeholder text before emitting
      dispatched-message state. Give already queued human messages precedence,
      preserve their relative order, and leave normal notification handling
      alone. Never call the raw prompt API while a turn is active or clear human
      work when invalidating PR-event tokens.
- [ ] **Implement config inheritance and required resume.** Skip composer
      model/mode/effort/thinking configuration for PR-source sends. Cold startup
      restores persisted ACP config and permission metadata without applying
      current defaults over it. In the ACP factory, `require_existing` rejects
      missing identity, failed load, or unsupported load before `newSession`.
      Propagate the option through lifecycle composition; an already-running
      conversation uses its existing client. Ordinary user-requested rollover
      retains its existing behavior.
- [ ] **Implement receipt-aware failure/recovery.** Confirm a delivery on normal
      prompt completion or an exact marker in provider-owned history. Local
      optimistic transcript commits alone are not evidence. Preserve the frozen
      delivery ID/text through uncertain retry. Busy deferrals do not count as
      failures; permit three actual send attempts, then pause with a visible
      transport error until explicit recovery. Stop generation changes leave
      durable work pending and cannot schedule another send. A retry group
      retains its original members; newly observed events wait for a subsequent
      group rather than changing the provider-visible marker/text.
- [ ] **Run all focused tests, including existing parent/child notification
      regressions and normal user startup fallback; expect success.** Commit
      with subject `Deliver PR updates through the existing session queue`.

## Task 4: Recipient binding, durable pause, and dispatch preparation

**Files:**

- Create: `src/backend/orchestration/pr-monitoring.orchestrator.ts`,
  `src/backend/orchestration/pr-event-delivery.orchestrator.ts`, and tests.
- Modify: `src/backend/orchestration/domain-bridges.orchestrator.ts`,
  `src/backend/services/session/service/bridges.ts`, lifecycle
  `session-termination.coordinator.ts`, `session-runtime-exit.coordinator.ts`,
  `session.prompt-turn-completion.service.ts`, and explicit start/resume/user
  input handlers.
- Modify: `src/backend/trpc/workspace.trpc.ts`, workspace creation/session
  startup wiring in `domain-bridges.orchestrator.ts`, and Task 1 services.
- Test: orchestration plus session stop/runtime-exit/workspace-init regressions.

**Interfaces:**

- `setPRMonitoring({workspaceId, enabled, recipientSessionId?, expectedBindingRevision}): Promise<{status: 'updated'; bindingRevision: number} | {status: 'recipient_required'; candidates: {id: string; name: string | null; provider: SessionProvider}[]}>`.
- `pausePRDelivery({workspaceId, sessionId, reason: 'USER_STOP' | 'SESSION_FAILURE' | 'TRANSPORT_ERROR', expectedBindingRevision}): Promise<boolean>`
  and
  `resumePRDelivery({workspaceId, sessionId, expectedBindingRevision}): Promise<boolean>`
  are workspace-owned CAS writes.
- `preparePRDelivery({sessionId, request})` implements Task 3's `prepare` port;
  `wakePRDelivery(workspaceId): Promise<void>` queues eligible requests quickly,
  without awaiting the whole model turn.

- [ ] **Write failing binding and lifecycle races.** Assert enable-from-chat
      binds that session, sole-eligible workspace enable binds
      deterministically, multiple sessions require selection, and
      automation/subagent/cross-workspace IDs reject. Tab focus/new sessions do
      not redirect events. Hold a prepare await, then
      stop/disable/archive/rebind/detach; assert no send after release. Name the
      race `does not deliver after rebind during refresh` and assert
      `expect(sendSessionMessage).not.toHaveBeenCalled()` for the old recipient.
- [ ] **Run new orchestration and existing session lifecycle tests; confirm the
      new assertions fail.**
- [ ] **Implement validated binding and trusted enable events.** Existing
      bindings take precedence for workspace controls. New issue-workspace
      defaults bind the `implement` session created by the ordinary startup
      path. Create one `MONITORING_ENABLED` ledger event per new binding/enable
      revision. The event's null PR target permits delivery even before a PR is
      attached. Closing/deleting the recipient invalidates its tokens and
      requires selection; never silently pick the most recently active session.
- [ ] **Implement stop/failure/resume bridges.** Establish durable pause before
      stop cleanup can dispatch completion callbacks. A failed runtime pauses
      its bound recipient. Explicit user start/resume or a deliberate new user
      turn can clear the pause through the matched revision; background startup
      cannot. Preserve pause across restart. Leave pending
      permission/question/plan state untouched and wait while another workspace
      session is working.
- [ ] **Implement prepare with final guards and observation revalidation.**
      Re-read config, workspace lifecycle, association, pending interactions,
      and session identity after every asynchronous startup/refresh boundary.
      Refresh PR facts before claiming its oldest pending events; supersede
      stale facts with Task 2's reducer. Control events need no PR refresh.
      Claim only current bindings and still-attached PRs. Allocate the delivery
      UUID before building the frozen text, then pass that UUID to
      `claimDelivery`. Return discard for invalidated work and blocked for
      transient gates. Complete/fail settles only the captured delivery.
      Disabling cancels pending events/tokens and never calls `stopSession` on
      the main conversation. A dispatched turn finishes under ordinary lifecycle
      rules.
- [ ] **Run the focused binding, lifecycle, and preparation tests plus
      `pnpm check:ownership` and `pnpm typecheck`; expect success.** Commit with
      subject `Bind PR monitoring to a resumable main conversation`.

## Task 5: Watcher cutover and removal of separate fixer dispatch

**Files:**

- Replace internals of
  `src/backend/services/ratchet/service/ratchet.service.ts`, `ratchet.types.ts`,
  `bridges.ts`, `ratchet-workspace-check-coordinator.ts`, and capsule barrels.
  Keep the public Ratchet name for the existing control.
- Modify: `src/backend/orchestration/scheduler.service.ts`,
  `src/backend/services/github/service/pr-fetch-coordinator.ts`,
  `src/backend/orchestration/domain-bridges.orchestrator.ts`,
  `src/backend/app-context.ts`, `src/backend/server.ts`, and constants.
- Remove: `fixer-session.service.ts`, `ratchet-fixer-dispatch.helpers.ts`,
  `ratchet-active-session.helpers.ts`, provider resolver/selection modules,
  `src/backend/prompts/ratchet-dispatch.ts`, and `prompts/ratchet/dispatch.md`.
- Modify: session `session-workflow-finalizer.ts`, session resource acquisition
  API, and obsolete Ratchet workspace service/accessor callers.
- Test: replace fixer-centric tests with watcher tests; retain review filter,
  coordination, shutdown, rate-budget, and session lifecycle regressions.

**Interfaces:**

- `ratchetService.checkWorkspaceById(workspaceId, options?): Promise<{observed: number; eventsCreated: number; deliveryQueued: number}>`.
- `ratchetService.checkAllWorkspaces()` aggregates those counts. Its bridge
  exposes full-observation fetch/accept and a fast `wakePRDelivery`; there are
  no acquire/start/restart/stop-fixer or fixer-outcome methods.
- Both scheduler refresh and watcher call the same full-observation acceptance
  pipeline for monitored PRs; disabled workspaces retain lightweight cache sync.

- [ ] **Write failing two-PR/no-fixer watcher tests.** Assert both PRs are
      observed while the main session works, each inserts its own ledger events,
      and no session creation/restart/cancellation occurs. Repeat observations:
      `expect(eventsCreated).toBe(0)`. Saturate all 100 existing queue slots:
      `expect(pendingEvents).toHaveLength(2)`, with no new session created.
- [ ] **Run watcher, scheduler, and fetch-coordination tests; confirm red.**
- [ ] **Replace dispatch decisions with observation + ledger wakeups.** Keep the
      existing workspace concurrency, cancellation, shutdown, and rate-limit
      backoff. Rename the registered job to `pr-monitoring-poll`, retaining the
      `120_000` interval and existing dynamic backoff. Register only the
      replacement job. Terminal associations stop active observation after their
      final event; reattachment/reopen can make them eligible again. A queued
      event is not an active fixer and never blocks observation of siblings.
- [ ] **Unify scheduler/watcher reads and wire delivery recovery.** Key fetch
      coordination by PR association. Full acceptance happens inside the
      coordinated callback, so its completion already persisted facts/events. A
      cooldown skip triggers delivery of existing pending events rather than
      implying no work. Poll retries queue pressure and viewerless pending work.
      Startup, prompt completion, explicit resume, and accepted observation also
      wake delivery. A failed refresh starts no successful-fetch cooldown and
      cancels no facts. Enable/rebind must request a full refresh with
      completed-fetch cooldown bypass while still respecting a fetch actually in
      flight. A lightweight read racing enable must not suppress the next full
      observation.
- [ ] **Remove obsolete fixer code and callers.** Remove acquire/restart,
      provider mismatch, fixer crash retry/stall, and prompt paths from runtime
      APIs. Keep only narrowly scoped legacy retirement code needed by Task 7;
      legacy history input is compatibility data, not an operational mode.
      Update admin/manual-check responses to event counts. Do not weaken review
      assertions when moving their tests into the new ownership area.
- [ ] **Run watcher/scheduler/coordination, session runtime, bridge, shutdown,
      and queue-pressure regressions plus `pnpm typecheck`; expect success.**
      Commit with subject
      `Replace ratchet fixer dispatch with PR event monitoring`.

## Task 6: Recipient controls, chat rows, and truthful workspace status

**Files:**

- Modify: `src/client/hooks/use-toggle-ratcheting.ts`, toggle cache and header
  toggle/provider settings,
  `src/client/features/workspace/ratchet-toggle-button.tsx`,
  `src/client/routes/admin/RatchetSettingsSection.tsx`, and tests/stories.
- Create: `src/client/features/workspace/pr-monitoring-recipient-dialog.tsx` and
  `src/client/features/chat/agent-activity/message-renderers/pr-update-renderer.tsx`,
  with co-located tests and stories.
- Modify: `src/shared/acp-protocol/protocol/messages.ts`, shared snapshots,
  `src/shared/workspace-status-reason.ts`,
  `src/shared/kanban-column-projection.ts`,
  `src/shared/workspace-flow-state.ts`, client display/snapshot/reducer code,
  message renderer registry, and backend
  event-collector/projection/reconciliation.
- Modify: settings schema/accessor/service and `user-settings.trpc.ts`, session
  workflow permissions and their tests, `prisma/schema.prisma`.
- Create: `prisma/migrations/20261008140000_pr_monitoring_cutover/migration.sql`
  and its migration tests; Task 7 completes legacy-row and backup coverage.

**Interfaces:**

- `PRMonitoringSummary = {enabled: boolean; recipientSessionId: string | null; bindingRevision: number; pendingEventCount: number; deliveryStatus: 'off' | 'watching' | 'queued' | 'needs_recipient' | 'paused' | 'error'}`.
  Expose it on authoritative workspace snapshots, beside the multi-PR facts.
- Add `pr_update` application rows with `deliveryId`, member `eventIds`,
  nullable `prId`, summary, links, timestamp, and delivery state. Match provider
  markers when rebuilding history so the injected provider prompt and its
  application row do not appear as two human messages.
- Add `autoIterationPermissions: SessionPermissionPreset` to settings. Migrate
  the previous `ratchetPermissions` value exactly; main-session monitoring uses
  the session's existing permission state.

- [ ] **Write failing UI/projection/settings tests and stories.** Cover no, one,
      and several eligible recipients; enable/disable pending and error;
      explicit resume needed; long PR titles; mixed terminal/open PRs; queued,
      delivered, cancelled, and failed chat rows. Assert tab focus cannot
      rebind; `getWorkflowPermissionPreset('auto-iteration')` retains the
      migrated value.
- [ ] **Run the affected tests and confirm the new assertions fail.**
- [ ] **Implement the recipient dialog and existing Ratchet controls.** Pass the
      active ordinary chat session ID when enabling there. Workspace controls
      use the saved binding/sole candidate, opening
      `ConfirmDialog`/`AlertDialog` based selection for multiple candidates.
      Show the saved recipient and why delivery is blocked. Replace fixer
      descriptions/provider/permission controls with queued-PR-update copy,
      retaining enable/review/reply preferences.
- [ ] **Implement settings migration and remove obsolete fields.** Copy
      auto-iteration permissions before dropping the shared old permission
      column. Drop separate ratchet provider selectors and old fixer
      tables/relations only after enabled flags, binding candidates, and legacy
      sessions are retained for Task 7. Regenerate Prisma. Keep adversarial
      review's read-only contract. If a retained session has
      `workflow='ratchet'`, migrate that workspace's pause reason to
      `LEGACY_FIXER`. Only Task 7's successful retirement can clear this
      migration-only guard; ordinary resume cannot bypass it.
- [ ] **Implement ledger-backed chat/projections.** Reconstruct cards from
      durable delivery metadata and markers on startup/reconnect; update one
      card per delivery rather than append one each poll. Preserve snapshot
      worker retries, stale-read invalidation, and archive suppression.
      Permission/plan/ question/lifecycle status wins; queued/watching
      monitoring is working, needs-recipient/paused/error and
      delivered-but-still-red facts are waiting. Remove `RATCHET_STALLED` and
      fixer-outcome inputs. An old failed check alone must not claim that the
      agent is fixing it. Keep aggregate PR/CI/conflict and multi-PR archive
      calculations independent of selected chat tabs.
- [ ] **Run UI/settings/status/snapshot tests and visually verify desktop,
      mobile, keyboard focus, truncation, and scroll.** Commit with subject
      `Show PR event delivery in chat and workspace controls`.

## Task 7: Legacy fixer retirement and backup compatibility

**Files:**

- Create: `src/backend/orchestration/pr-monitoring-cutover.orchestrator.ts` and
  co-located tests.
- Modify: `src/backend/server.ts`, Task 6's migration/tests,
  `src/backend/orchestration/data-backup.service.ts`,
  `src/backend/services/settings/resources/data-backup.accessor.ts`,
  `src/shared/schemas/export-data.schema.ts`, and their tests.
- Test: `src/backend/pr-event-ledger.migration.test.ts`, background receipt
  recovery, closed-session persistence, and backup round trips.

**Interfaces:**

- `retireLegacyRatchetSessions(): Promise<{retired: number; blockedWorkspaceIds: string[]}>`
  runs before the replacement poller starts.
- Export schema version 6 with monitoring configuration, PR observation
  baselines, and the event ledger. Accept version 4's singleton and version 5's
  collection format from the multiple-PR work. Convert them to version 6 before
  ordinary import; legacy hashes/outcomes never become delivery receipts.
- `reconcilePRDeliveryClaims(workspaceId): Promise<void>` examines frozen claim
  groups against provider-owned history before resetting to pending.

- [ ] **Write failing migration/cutover/backup tests.** Include enabled and
      disabled workspaces, zero/one/multiple eligible ordinary sessions, active
      legacy fixers, missing provider history, mismatched imported session IDs,
      corrupt event JSON, and a retained delivered marker with a dispatching
      row. Assert old permissions copy exactly, transcripts survive cleanup,
      ambiguous binding needs selection, optimistic local messages do not
      confirm receipt, and confirmed provider markers prevent redelivery. Name
      the ambiguous-binding test `does not choose between two main sessions` and
      assert `expect(config.recipientSessionId).toBeNull()`. Name the receipt
      test `does not acknowledge an optimistic local message` and assert
      `expect(event.state).not.toBe('DELIVERED')` until provider evidence is
      loaded.
- [ ] **Run migration, cutover, closed-session, and backup tests; confirm red.**
- [ ] **Complete the cutover migration and startup retirement.** Preserve legacy
      session records and provider identity long enough to load history, stop
      surviving fixer runtimes, persist closed-session history, and only then
      delete obsolete session rows. Initialize recipient binding only from a
      verifiable ordinary startup identity or a sole eligible ordinary session;
      retain an explicit blocked state otherwise. Cleanup failures exclude that
      workspace from delivery. Retrying retirement is idempotent and never
      targets the main conversation. Remove old dispatch tables after their
      enable flags and configuration were transferred; no old dispatch history
      is needed live.
- [ ] **Implement versioned export/import and claim recovery.** Export only
      version 6; include every PR, discovery cursor, monitoring state/pause,
      observation, and event identity/state. Restore no runtime claims;
      reconcile uncertain sends against restored provider history, using stable
      markers and retaining already confirmed receipt. Validate/resolve
      recipient IDs after session restoration; missing targets require
      selection. Preserve PR/session history and preferences from versions 4/5
      while retiring fixer bookkeeping. Newly imported old-format workspaces
      seed current actionable facts after recipient binding, not historical
      review replay.
- [ ] **Run migration, backup, retirement, startup-order, and receipt recovery
      regressions plus `pnpm check:prisma-schema`; expect success.** Commit with
      subject `Migrate ratchet workspaces and preserve PR event backups`.

## Task 8: End-to-end replacement, documentation, and delivery checks

**Files:**

- Create: `src/backend/orchestration/pr-event-flow.integration.test.ts`.
- Modify: `docs/architecture/pull-requests.md`, `agent-runtime.md`,
  `background-jobs.md`, and `workspace-state.md` under the same directory.
- Reconcile: the multiple-PR spec and plan linked above; replace their active
  fixer claims/tests and automation/backup contracts with this plan's seams.
- Review: dependency rules, barrels, app context, prompts packaging, scripts,
  schemas, snapshots, and old test fixture references affected by removal.

**Interfaces:** Consume Tasks 1-7's public contracts; no new delivery mode.

- [ ] **Write the end-to-end integration regression.** Start one ordinary
      session and hold its turn. Observe failures for PR A/B, queue a human
      message, then release the turn. Assert the human queue order is preserved,
      both PRs reach the same provider conversation sequentially, and no fixer
      is created. Push a new head for A while its old event waits: the old
      failure never dispatches. Merge B: its pending fixes cancel, A remains
      deliverable, and the main session remains intact.
- [ ] **Add restart/stop/queue-pressure integration cases.** With no viewer,
      persist an event, restart the backend, and resume the same provider
      identity before delivery. Repeat with explicit stop: nothing dispatches
      until user resume. Inject disable/archive/rebind during delayed
      preparation and a completed marker before acknowledgement; assert final
      guards and receipt reconciliation. Fill the 100-message queue and verify
      delivery succeeds once capacity returns without losing events or adding
      sessions.
- [ ] **Run the new integration file with `pnpm test`; expect success.** Also
      run relevant existing session startup/termination, parent/child,
      adversarial-review, auto-iteration, multi-PR attachment/discovery/archive,
      backup, snapshot, and shared status tests.
- [ ] **Update documentation and reconcile the earlier plan.** Describe event
      selection, stable recipient binding, explicit stop/resume, settings
      inheritance, receipt uncertainty, two-minute polling, and legacy
      replacement. Replace all earlier multiple-PR instructions to build new
      fixers. Search runtime code for `fixerSessionService`,
      `acquireFixerSession`, `buildRatchetDispatchPrompt`,
      `ratchetSessionProvider`, `ratchetDispatchOutcome`, and old poll
      registrations; remaining matches may be confined to migrations/legacy
      import/retirement and their tests.
- [ ] **Run final required checks in order:** `pnpm check:fix`,
      `pnpm typecheck`, all affected `pnpm test` files, `pnpm check`, and
      `pnpm check:prisma-schema`. Each must exit zero; resolve relevant failures
      without weakening assertions. If reducing oversized files, run
      `pnpm check:file-length:update`. Inspect the final diff and desktop/mobile
      stories; repeat checks only after further edits or new failures.
- [ ] **Commit the final integration/docs changes** with subject
      `Verify main-session PR monitoring replaces ratchet fixers`. Report check
      outcomes and any unavailable checks. If a PR is subsequently requested,
      open it ready for review, never as a draft, and attach it to this task.

## Planning validation and execution handoff

### Focused test commands

Use the owning task's command for its red/green steps; the red run must fail on
its new behavior assertions. Existing neighboring regressions named in each task
remain part of that task's final green run.

```bash
# Task 1
pnpm test src/shared/schemas/pr-event.schema.test.ts \
  src/shared/pr-monitoring.test.ts \
  src/backend/services/workspace/resources/workspace-pr-monitoring.accessor.integration.test.ts \
  src/backend/orchestration/pr-event-flow.integration.test.ts \
  src/backend/pr-event-ledger.migration.test.ts

# Task 2
pnpm test src/shared/pr-monitoring.test.ts \
  src/backend/services/github/service/pr-observation.service.test.ts \
  src/backend/services/github/service/pr-actionable-review.test.ts \
  src/backend/prompts/pr-event.test.ts

# Task 3
pnpm test src/backend/services/session/service/lifecycle/session-background-delivery.service.test.ts \
  src/backend/services/session/service/chat/chat-message-handlers.service.test.ts \
  src/backend/services/session/service/acp/acp-client-factory.test.ts \
  src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts \
  src/backend/services/session/service/lifecycle/session-notification-delivery.service.test.ts

# Task 4
pnpm test src/backend/orchestration/pr-monitoring.orchestrator.test.ts \
  src/backend/orchestration/pr-event-delivery.orchestrator.test.ts \
  src/backend/services/session/service/lifecycle/session-termination.coordinator.test.ts

# Task 5
pnpm test src/backend/services/ratchet/service/ratchet-observation-watcher.test.ts \
  src/backend/orchestration/scheduler.service.test.ts \
  src/backend/services/github/service/pr-fetch-coordinator.test.ts

# Task 6
pnpm test src/client/features/workspace/pr-recipient-picker.test.tsx \
  src/client/features/chat/agent-activity/message-renderers/pr-update-renderer.test.tsx \
  src/shared/workspace-status-reason.test.ts \
  src/backend/services/session/service/lifecycle/session-context.service.test.ts

# Task 7
pnpm test src/backend/pr-event-ledger.migration.test.ts \
  src/backend/orchestration/pr-monitoring-cutover.orchestrator.test.ts \
  src/backend/orchestration/data-backup.service.test.ts

# Task 8
pnpm test src/backend/orchestration/pr-event-flow.integration.test.ts
```

### Handoff

The design was approved on 2026-10-08. This document defines implementation
tasks only; no application code has been changed for this replacement. Before
execution, restore the workspace dependencies: earlier formatting, typecheck,
and repository check attempts could not run because automatic dependency
downloads could not reach the registry. Do not treat those attempts as passing
checks or bypass the pre-commit hook.

Recommended execution is native, sequential work in this session, because
resource transactions, observation acceptance, and session delivery share
interfaces that need to move together. A whole-branch independent review should
follow implementation. Subagent-driven implementation with review after each
task is also supported if the user chooses it. Review this plan and select an
execution approach before product implementation.
