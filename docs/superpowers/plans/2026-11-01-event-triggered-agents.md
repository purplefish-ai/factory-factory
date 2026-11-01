# Event-triggered agents implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` after the user approves this plan. Checkboxes
> describe proposed implementation work, not completed functionality.

**Goal:** Turn saved GitHub and Slack triggers into controlled, observable agent
runs, without duplicate workspaces after retries or restarts.

**Architecture:** Source adapters persist normalized events before advancing a
cursor or acknowledging delivery. The agent-definition capsule owns matching,
evaluation records, run admission and recovery. Orchestration connects its
narrow ports to GitHub, disposable inference, workspace creation and sessions;
those capsules retain their existing resource ownership.

**Tech stack:** TypeScript, Prisma/SQLite, Zod, jobRunner, existing gh request
budget, Express/tRPC, React, existing provider runtimes, Slack Socket Mode.

**Spec:**
[Issue #2772](https://github.com/purplefish-ai/factory-factory/issues/2772).
This document's scope and contracts are proposed decisions for user review.

## Scope and delivery decisions

Deliver two milestones under this issue, with GitHub usable before Slack ships:

1. GitHub `labeled` events, deterministic filters, durable execution,
   enable/pause, evaluation/run history and result links.
2. Slack human messages including replies, Socket Mode setup, bounded context,
   semantic filters, replay evaluation and operator recovery controls.

GitHub uses authenticated outbound polling of repository issue events through
GitHubCLIService. Reuse the existing `gh:<repository-id>` connection: it is not
a GitHub App installation. Polling avoids requiring a public endpoint, a cloud
relay or repository-admin webhook installation for the first use case. The
alternative, signed webhooks, gives broader action coverage but adds hosting and
setup requirements to a local application.

Only GitHub `labeled` is executable in this issue. Existing `opened`, `edited`
and `reopened` configurations remain saveable but cannot be enabled and show a
specific unsupported-action explanation. Do not approximate webhook actions with
issue `updated_at` snapshots. Supporting those actions is a follow-up; call this
limit out in the UI, release notes and issue completion comment.

Slack uses outbound Socket Mode, requiring a separately encrypted `xapp-` token
with `connections:write` in addition to the existing bot token. Bot credentials
alone do not start listening. Token validation, app/workspace binding,
subscribed message events and channel membership are prerequisites to
activation. Use the official `@slack/socket-mode` client behind a narrow
adapter; do not add Bolt or implement socket reconnect/refresh from scratch. Pin
its compatible version in pnpm-lock.yaml during implementation. SDK transport
timers are owned and stopped by that adapter; business polling and
reconciliation still use jobRunner. Use a dedicated Slack app for this
integration: Socket Mode connections for an app share event delivery and must
not compete with an unrelated listener.

No scheduler migration, public automation API, general OAuth installation flow,
actor discovery, automatic source replies, or cloud service is included. Legacy
PeriodicTask remains the only scheduler; SCHEDULE triggers in AgentDefinition
remain unavailable, with explicit UI copy. Existing agent settings are not
silently activated.

## Current implementation and gaps

- AgentDefinition, AgentConnection, AgentTrigger, AgentRun and AgentProposal
  exist, with paused-by-default authoring and frozen run JSON contracts.
- AgentRun's unique `(agentDefinitionId, idempotencyKey)` is a useful admission
  foundation, but there is no event/evaluation ledger or replayable launcher.
- Proposal updates currently force every trigger back to disabled. Editing an
  active definition needs deliberate version and activation semantics.
- The Agents page currently queries PeriodicTask exclusively. New records must
  be added explicitly; reusing the page does not make AgentDefinition visible.
- PERIODIC_TASK launch has a documented workspace-create/link crash gap. Do not
  reuse that policy and claim restart-safe execution.
- Session startup queues the initial prompt in memory. A durable workspace/run
  association alone cannot prove that the provider accepted that prompt.

## Global constraints

- Node 26.12.1 (`.node-version`), pnpm 12.15.0; Electron uses its bundled
  runtime.
- Read backend/client area guides and current architecture notes before edits.
- Capsule barrels across boundaries; cross-service coordination in
  orchestration.
- Register new Prisma models and single writers in `services/registry.ts`.
- Validate provider payloads and stored JSON with Zod; no parsed-data casts.
- All gh processes use GitHubCLIService; all new recurring jobs use jobRunner.
- Configuration comes through configService; secrets never enter public reads,
  run snapshots, error text or logs.
- External issue/message content is task data, never authority to change the
  trigger, execution settings, tool permissions or source access.
- Authoring remains paused by default; activation is a separate trusted-local
  user action, not an MCP mutation or an inferred conversational permission.

## Execution contracts

### Event ingestion and identity

Add AgentSourceState (connection cursor/health), AgentEvent (normalized
immutable event) and AgentEvaluation (per-trigger decision). The
agent-definition capsule owns all three. Add relation indexes and explicit
delete behavior in migrations.

An event identity is `(connectionId, providerEventId)`: GitHub's issue event ID
or Slack's outer event_id. Store provider IDs as strings. Event payloads have a
discriminated versioned schema with source identity, occurredAt, observedAt,
action, actor/creator IDs, source URL and bounded issue/message text. Do not
persist unrestricted raw provider JSON.

An evaluation is unique on
`(eventId, triggerId, definitionRevision, triggerRevision, activationGeneration)`.
Record MATCHED, SKIPPED or ERROR, a stable reason code, bounded explanation,
evaluated configuration snapshot and classifier identity when used. A run is
unique on `(agentDefinitionId, eventId)` even when two triggers of the same
definition match. All matching evaluation records point to that same run.
Different definitions may intentionally produce separate runs for one event. For
one definition/event, evaluate eligible triggers in stable trigger-ID order; the
first MATCHED trigger owns the run's context and trigger snapshot. Earlier ERROR
outcomes stop that definition/event from admitting until retried or explicitly
skipped, so timing cannot choose a different context. Later matches are recorded
as coalesced into the chosen run. Do not merge contexts implicitly.

Add monotonic definitionRevision as well as triggerRevision. An evaluation's
identity and validity include both: changing instructions/execution settings
invalidates pending decisions even when a trigger itself is unchanged. Admission
compares both revisions transactionally; admitted snapshots never change.

Activation is a two-step operation with a per-trigger generation: prepare a
provider baseline, then atomically activate that exact generation/revision if
the definition, connection and project still permit it. GitHub saves the actual
head event ID (or empty-repository marker); events ordered after that baseline
are eligible, including events between baseline preparation and commit. Events
at/before it are not. Establish this boundary separately for a newly enabled
trigger sharing an already-polled connection. Pending baseline preparation never
enables dispatch; pause cancels it.

Slack activation displays a short unique verification message for the user to
send in each selected channel. Store the ten-minute pending activation nonce,
expected connection/channel and revisions before listening. An authenticated
ordinary human message matching that nonce proves delivery and supplies that
channel's provider event_ts boundary. Verification messages never create runs.
Atomically enable after all selected channels are verified; messages ordered
after their channel's boundary are eligible, including those received while
other channels are being verified. Use exact provider timestamp strings, not
local clocks or observedAt. Show “Connected; waiting for test message” until
then. Expired/cancelled activation generations cannot be completed by a delayed
test event. Re-enable requires fresh verification, so delayed paused-time events
stay ineligible. This setup step trades convenience for a provider-established
boundary and observable subscription readiness.

Hold candidate messages for a STARTING activation generation unevaluated in the
durable event ledger. Do not record a terminal disabled-trigger SKIPPED decision
for them. After atomic activation evaluate them against their channel boundary;
cancelled/expired generations settle their held candidates as skipped. Other
active triggers sharing the connection continue evaluating independently.

Already active GitHub subscriptions catch up across restarts; Slack shows live
delivery gaps. Provider redelivery cannot change a stored event's eligibility.
Persist baseline/generation and evaluation ownership, including terminal skipped
decisions, so a new activation cannot revive earlier queued work.

Characterize the repository API's ordering before implementing its scan adapter;
do not infer ordering from issue IDs. For newest-first pages, scan until the
previous stable boundary is found. Persist each page idempotently, but advance
the committed high-water boundary only after the whole interval is captured.
Store the scan's fixed head identity and next page in AgentSourceState so a
ten-page budget resumes deeper next cycle instead of rereading the same first
1,000 events forever. Resume with a one-page overlap; newly inserted head events
are captured in the next interval after the fixed scan head is committed. Page
records and continuation update in one transaction. Budget exhaustion leaves the
committed boundary unchanged and exposes catching-up state. Never quietly skip
the middle of an interval. A missing boundary requires an explicit recovery
decision, not advancing to the newest event. Exclude PRs. Follow provider
pagination and shared rate-limit backoff. Source identity must still match the
project's repository ID, including repository renames/transfers.

Slack acknowledges a supported event only after the AgentEvent insert commits;
duplicate inserts are successful acknowledgments. Unsupported envelope types are
acknowledged and ignored without storing their content. Verify the team, app and
channel against the configured connection before matching. A database failure
leaves a supported event unacknowledged for redelivery. Socket reconnect is not
an unlimited provider replay guarantee: expose disconnect gaps and the limits of
recovery rather than promising capture while the app is offline.

### Matching and classification

Pure deterministic matching runs before inference. GitHub requires action
`labeled`, repository scope, and, when labels are configured, the added label to
be one of them. Slack requires a selected channel and an ordinary human message;
reject bot messages, edits/deletes and system subtypes. Apply messageContains as
a case-insensitive literal substring. Existing senderIds and creatorIds remain
unsupported by authoring/activation until actor discovery is implemented; never
silently ignore them.

If filterInstructions is absent, deterministic matches need no model. Otherwise
classify using a disposable, tools-disabled session with a strict output schema
`{ decision: 'match' | 'skip' | 'uncertain', reason: string }`. Treat uncertain,
malformed or failed inference as non-dispatching outcomes with visible reasons.
Use the existing disposable-inference authentication/process cleanup pattern; do
not call the metadata generator with an incompatible result schema.

Provider/model/effort defaults are resolved into a validated execution snapshot
before admission. Classifier settings are separate configService settings
(default small model for the selected provider), not an accidental override of
the execution model. Limit classification to 30 seconds and two concurrent
requests globally. Do not provide tools, MCP servers, repo instructions or
credential-bearing content. Persist classifier/model/prompt version and input
hash for reproducibility, not chain-of-thought.

### Admission, pause and concurrency

Atomic admission rechecks definition, trigger revision/enabled state, connection
enabled/readiness state, project active state and event eligibility. Freeze
instruction/configuration/input snapshots and create one QUEUED run. Concurrent
edits invalidate stale evaluations; they cannot mutate an admitted run's
snapshot. Do not reuse the proposal JSON's literal false flags as the runtime
activation state. Definition instruction/execution edits cancel
admitted-but-unclaimed runs and invalidate evaluations from the old definition
revision. Trigger edits/pause cancel corresponding unclaimed runs. Launch claims
compare both revisions and activation generation. Claims committed before an
edit retain frozen settings and finish as in-flight work; no later launch may
use the old snapshot.

Instruction/execution edits also pause all of that definition's triggers and
require fresh provider baselines on explicit re-enable. Do not re-evaluate
historical SKIPPED/ERROR events under the new revision or move an old event/run
to a new activation generation. A cosmetic name edit alone does not advance the
execution definitionRevision. This avoids a separate event/revision cohort
subsystem while preserving a clear no-retroactive-execution rule.

Defaults: one active run per definition, four globally, 100 waiting runs per
definition, waiting-run expiry at 24 hours. Capacity shortage defers FIFO work;
overflow/expiry produces an explicit evaluation/run reason. Values live in
configService and SERVICE_INTERVAL_MS/constants as appropriate.

The atomic launch claim is the linearization point for pause: pausing before the
claim cancels queued work; a claim committed first is an in-flight run and may
finish provisioning. Pause and claim share database serialization; UI copy says
active work continues. Include provisioning and ambiguous dispatches in capacity
accounting. A lease/fencing generation protects worker writes; the supported
deployment remains one backend owner per database.

### Restart-safe launch and initial delivery

Extend AgentRun with reservedWorkspaceId, reservedSessionId, initialMessageId,
launch phase, attempt/retry timestamps and worker generation. Allocate these
identities once before side effects. Add an EVENT_AGENT workspace creation
source that carries these identities plus frozen execution/input and issue link.

The workspace capsule owns a WorkspaceLaunchOrigin row with unique runId and
reserved workspaceId scalars, project provenance and createdAt. Insert that row
and Workspace atomically in its resource transaction. Do not cascade the origin
away when the workspace/run is removed. On retry, an origin with no surviving
workspace means previously created then deleted: refuse recreation even if run
linkage never committed. An archived workspace is likewise not reinitialized. An
existing origin must match the requested project/run/reserved identity. Register
this model's sole writer under workspace, not agent-definition. The session
capsule similarly creates or returns the reserved default session and rejects
mismatched workspace/configuration ownership. Resource writers remain in their
owning capsules; no direct AgentRun writes from workspace resources and no
cross-capsule Prisma-resource imports.

The event launch path links run/workspace/session before setup/agent dispatch.
It reuses existing worktree initialization and session startup settings through
an explicit EVENT_AGENT policy. Do not route it through the interactive
best-effort-session or legacy PERIODIC_TASK policies. Explicit provider/model/
effort must reach createAgentSession; unattended startup uses the existing
non_interactive policy. Ratchet is off by default for event runs to avoid
silently adding a second automation loop.

EVENT_AGENT initialization must bypass the existing random-ID auto-init message
path. Its durable initialMessageId and full resolved launch settings must flow
through the outbox instead: the current enqueueAutoMessage helper resets
reasoningEffort and plan controls. Never enqueue both the legacy initialPrompt
and the outbox task, or re-resolve defaults on recovery. Select
reservedSessionId explicitly rather than the first IDLE session, even if the
user opens another conversation during setup. Dispatch the initial outbox
message in its own batch and pin its settings; human follow-ups and PR events
must not be combined with or replace that first task. Ordinary later queue/steer
behavior stays unchanged. Normal queue retry, steering and manual-resume
controls cannot bypass an outbox SENDING/AMBIGUOUS fence. An initial provider
turn never absorbs a human follow-up queued during provisioning; the normal
queue drains only after its outcome.

Add a durable initial-prompt outbox owned by agent-definition, with one row per
run, and an injected session dispatch observation port. States are PENDING,
SENDING, ACCEPTED, FINISHED and AMBIGUOUS. The session dispatcher records
SENDING immediately before the initial provider request; claim/generation checks
happen before sending. Queue insertion alone is not acceptance. Acceptance/turn
outcome observations are recorded durably using the stable initialMessageId
where the provider permits reconciliation. Locally persisted user-message text
is not acceptance evidence: current dispatch writes it immediately after
invoking send. ACCEPTED requires provider-originated turn activity/identity
correlated to this attempt, or conclusive provider history. The complete prompt
RPC response proves a terminal outcome, not an early ack.

On restart: resume PENDING setup/delivery in the same workspace/session; never
send SENDING/ACCEPTED again just because the queue is empty. Reconcile provider
history and durable lifecycle facts; absent conclusive evidence mark AMBIGUOUS,
stop automatic retries and show “Delivery uncertain—inspect conversation”. A
human-authorized retry reuses the workspace/session and explicitly warns that
prior effects may have occurred. It increments attemptGeneration, records a new
sendAttemptId/messageId under the same logical outbox/run, and fences all old
callbacks. No exactly-once external-effect claim.

Transient reads/provisioning retry at 30 seconds, 2 minutes and 10 minutes
(three retries after the first attempt), respecting provider Retry-After. This
same retry budget covers event enrichment/classification and provisioning;
uncertain decisions are terminal skips, not model retries. Permanent
auth/configuration failures fail immediately. Never automatically rerun a task
that has reached the provider. Setup timeout is 15 minutes, running turn timeout
is 4 hours. A pre-send setup timeout releases capacity after owned process
cleanup. A running timeout first requests stop and confirms provider
termination; uncertain termination retains capacity and needs resolution.
Shutdown stops source intake and new claims first, drains database writes, and
marks interrupted dispatches for reconciliation before stopping runtime
dependencies.

Run completion depends on the initial task session's durable outcome, not an
idle workspace or PR appearance alone. Persist COMPLETED, PR_CREATED, FAILED or
CANCELLED and compact PR/result metadata. Preserve those result links when the
workspace is deleted. Never auto-archive workspaces. Deliberate user stops are
CANCELLED; unexpected provider exits are FAILED.

Settlement transitions (all writes compare run and attempt generation):

- QUEUED/RESERVED, no outbox send: no active slot; pause/edit/expiry ->
  CANCELLED.
- RUNNING/PROVISIONING + PENDING: owns slot; safe provisioning retries preserve
  identities; exhausted/permanent errors -> FAILED after process cleanup.
- RUNNING/READY + PENDING -> RUNNING/DISPATCHING + SENDING immediately before
  provider invocation. Normal dispatcher retry cannot reverse this transition.
- Provider evidence -> RUNNING/ACTIVE + ACCEPTED; final response/outcome ->
  terminal run + FINISHED, releasing slot after owned runtime work has stopped.
- Crash/timeout with inconclusive send/termination -> RUNNING/NEEDS_ATTENTION +
  AMBIGUOUS; retain slot, expose inspect/stop-and-resolve/explicit-retry
  actions.
- Confirmed stopped + user resolves abandoned -> FAILED or CANCELLED + FINISHED;
  release slot. User retry requires confirmed stopped first, advances attempt
  generation, writes a fresh PENDING send attempt, and retains the same slot,
  logical run, workspace and session. Old callbacks cannot settle the new
  attempt.

Definition deletion is rejected while nonterminal runs exist; user must pause
and stop/resolve those runs first. Workspace deletion is reconciled to terminal
run state through the retained origin fact and initial-session outcome.

### Operational UI and retention

Extend the existing project Agents page with typed scheduled/event records;
legacy operations continue calling PeriodicTask, event operations call agent
runtime APIs. Include enabled state, source health, evaluations, queued/active
runs, paused/capacity/error reasons, workspace links and retained PR results.
The workspace Agent origin panel must resolve event runs as well as periodic
runs. Saved event definitions survive deletion of the authoring workspace and
must be editable/pausable without that proposal.

Activation validates capabilities, connection identity/credentials, supported
actions and execution configuration; do not render a misleading global
executionAvailable boolean. Proposal edits bump revision and pause changed
triggers, with a visible re-enable requirement. Unchanged trigger IDs/configs
retain activation only when definition instructions/execution are unchanged;
instruction/execution edits pause all triggers and cancel unclaimed runs as
specified above. Already claimed runs retain their snapshots and finish.

Retain complete event text/evaluations for 30 days and identity tombstones for
90 days. Events older than 30 days cannot enter automatic admission or replay;
thus expired tombstones cannot reintroduce ancient work. Run history and compact
results survive event-payload pruning. Frozen AgentRun.input and provider chat
history have separate lifetime retention and may still contain source text: the
30-day policy is ledger cleanup, not deletion of every content copy. Display
this distinction in retention documentation. Manual reevaluation within
retention may retry ERROR decisions but never removes run idempotency. No
historical fan-out replay operation is included. The UI shows oldest retained
coverage and gaps. Database-file backup plus encryption.key remains the
supported complete backup; document that logical export still excludes these
tables/credentials.

## Review focus

1. Process death between workspace/session creation, linkage and provider send.
2. Pause/edit/disconnect racing evaluation, admission or a launch claim.
3. Multiple matching triggers, duplicate delivery and unstable pagination.
4. Wrong-team/repository payloads and hostile natural-language input.
5. Idle-before-first-dispatch, pending approvals, and deletion during a run.

Each condition has an owning task and failure-injection coverage below.

## Implementation tasks

### Task 1: Durable runtime schema and event ledger

**Files:** modify `prisma/schema.prisma`, `src/shared/core/enums.ts`,
`src/shared/schemas/agent-definition.schema.ts`,
`src/backend/services/registry.ts`; create `src/shared/agent-runtime.ts`,
`src/backend/services/agent-definition/resources/agent-event.accessor.ts`,
`agent-run.accessor.ts` and colocated integration tests; migration/generated
output.

**Interfaces:** export
`ingestEvent(event: AgentEventInput): Promise<{eventId: string; duplicate: boolean}>`,
`recordEvaluation(input: AgentEvaluationInput)` and
`admitRun(input: AgentAdmissionInput): Promise<AdmissionResult>` from the
capsule. Shared Zod schemas define all three inputs and discriminated outcomes;
admitRun accepts evaluation ID, expected definition/trigger revisions and
activation generation, not caller-provided eligibility booleans. Add explicit
phase/outbox schemas and retention fields.

- [ ] Write migration/resource tests: duplicate event and run, two matching
      triggers, cross-definition/connection ownership, invalid JSON, immutable
      snapshots, result retention, FIFO/capacity, pause/revision races.
- [ ] Run `pnpm test:integration` with focused Vitest file selection while
      iterating; confirm failures target missing behavior, then implement sole
      writers.
- [ ] Add DB transactions for admission/claim and model/index ownership;
      generate with `pnpm check:prisma-schema`; run resource tests and commit
      schema/ledger.

### Task 2: GitHub labeled-event ingestion

**Files:** modify `src/backend/services/github/service/github-cli.service.ts`
and barrel; create `github-cli/agent-issue-events.ts` and tests; create
`src/backend/services/agent-definition/service/agent-source-poll.service.ts`;
create `src/backend/orchestration/agent-runtime.orchestrator.ts` and wire it
into existing `app-context.ts`, `server.ts`, `services/constants.ts` and
configService.

**Interfaces:** GitHub capsule exposes
`listAgentIssueEvents({repository, page, perPage: 100}, signal): Promise<AgentIssueEventPage>`
and authoritative repository identity. The runtime receives these through an
injected source port; all source-state/event writes remain in agent-definition
accessors. Start with a 60-second cadence and at most ten pages per repository
per cycle.

- [ ] Test initial empty/nonempty baseline, labels added/removed/readded, PR
      exclusion, renamed repositories, overlapping pages, >1,000 new events,
      process death mid-interval, missing boundary, auth/rate-limit failure and
      archive.
- [ ] Run failing focused tests, implement ingestion and durable boundary logic,
      then pass tests. Add identity/readiness checks without treating `gh:` as
      an App.
- [ ] Verify start/stop/restart with server lifecycle tests; commit usable
      intake.

### Task 3: Deterministic evaluation and launch admission

**Files:** create `service/agent-event-matcher.ts`,
`agent-event-evaluation.service.ts`, `agent-runtime.service.ts` and tests in
agent-definition; export through its barrel; extend runtime orchestration,
shared runtime schemas and config settings.

**Interfaces:** `matchAgentEvent(event, trigger): MatchResult` is pure;
`evaluatePendingEvents(signal)` stores terminal or retryable decisions;
`claimNextRun(now): Promise<LaunchClaim | null>` atomically enforces all gates,
capacity and expected generation. Run a jobRunner cycle every five seconds.

- [ ] Test added-label semantics, explicit unsupported actions, same-event
      overlapping triggers, changed revisions, paused-time events, queue
      overflow/ expiry, FIFO and capacity races. No inference is needed in
      milestone 1; filterInstructions blocks activation until task 8 is
      available.
- [ ] Run failing matcher/admission tests; implement and pass them.
- [ ] Verify pause has the documented launch-claim boundary and SCHEDULE
      definitions never enter this worker; commit evaluation/admission.

### Task 4: Recoverable workspace/session launch and prompt outbox

**Files:** modify workspace `service/lifecycle/creation.service.ts` and
`resources/workspace.accessor.ts`; session
`service/data/session-data.service.ts` and its accessor;
`orchestration/workspace-launch.orchestrator.ts`,
`workspace-init.orchestrator.ts`, runtime orchestration; create
`resources/agent-prompt.accessor.ts` and session dispatch-observation
integration. Add EVENT_AGENT to every affected source/workflow validation union
and enum. Add WorkspaceLaunchOrigin and its workspace-owned accessor
writer/registry entry.

**Interfaces:** workspace capsule exports `createEventWorkspaceOnce(source)`;
session exports `createEventSessionOnce({id,workspaceId,runId,execution})` and
`dispatchAgentInitialPrompt({runId,sessionId,messageId,text}, observations)`.
Observation callbacks use strict SENDING/ACCEPTED/outcome contracts and
generations. `launchEventRun(claim, signal)` belongs to orchestration and
returns the existing identities on retry. No generic legacy launcher gains
replay semantics by accident.

- [ ] Write integration failure injection after each durable boundary: reserved
      IDs, workspace insert, session insert, linkage, setup, queue insertion,
      before/after provider invocation and before acceptance persistence. Cover
      a workspace deleted after its atomic creation/origin write but before run
      linkage; a retry must refuse resurrection. Cover human input and a second
      IDLE chat created during setup; only the reserved session gets the
      isolated initial turn.
- [ ] Test repeated launch returns one workspace/session, archive/delete never
      resurrects, explicit model/effort reaches both providers, stalled setup
      and ambiguous sends stop retrying, and legacy launch behavior stays
      identical.
- [ ] Run failures, implement owner-specific create-once APIs, outbox hooks and
      restart reconciliation, then pass. Cover supported Node and Electron
      runtimes.
- [ ] Commit launch/delivery with no provider-effect exactly-once claim.

### Task 5: Run outcome monitoring and recovery

**Files:** create `service/agent-run-monitor.service.ts`, resource settlement/
retention helpers and tests; modify runtime orchestration, `server.ts`,
`app-context.ts`; use existing session/workspace/PR public read APIs.

**Interfaces:** `observeRun({runId,initialSessionOutcome,workspaceState,prs})`
settles with generation checks; `reconcileRuns(signal)` recovers durable phases;
`resolveAmbiguousRun(input)` requires an explicit trusted-local user decision.

- [ ] Test idle before first prompt, provider acceptance before a crash, pending
      interactive requests, PR before session failure, deliberate stop, provider
      crash, worktree setup failure, archive/delete, 15-minute setup and 4-hour
      turn deadlines, and shutdown/restart. Never infer completion from
      workspace idle.
- [ ] Run failing tests; implement bounded retry/backoff, lifecycle monitoring,
      retained result metadata and payload/tombstone pruning; pass tests.
- [ ] Prove legacy periodic scheduling and PR monitoring still dispatch exactly
      as before with existing flow/composition suites; commit
      monitoring/recovery.

### Task 6: Enable/pause and history UI; ship GitHub milestone

**Files:** extend `src/backend/trpc/agent.trpc.ts` with project-owned list/get,
activation, pause, evaluations, runs and recovery procedures; create capsule
runtime-management service/accessor; update `src/client/features/agents/`,
`agent-authoring/`, source discovery and workspace Agent origin composition. Add
stories and focused component/integration tests.

**Interfaces:** discriminated page records `{kind:'scheduled'|'event', ...}`;
runtime RPCs accept projectId/agentId with revision guards; `setEnabled` checks
capabilities and establishes baselines before exposing enabled status.

- [ ] Test scheduled/event agents coexist, saved definitions without their
      proposal remain editable, pause races, changed versus unchanged triggers,
      unsupported GitHub/Slack/SCHEDULE/filter settings and stale edit
      protection.
- [ ] Test a skipped/error event followed by instruction/execution edit and
      re-enable: the old event never launches under the new revision. A fresh
      post-baseline event can launch; cosmetic rename preserves active state.
- [ ] Implement desktop/mobile list/detail, health, evaluations, run history,
      workspace origin links, queued-state reasons and explicit
      uncertain-delivery recovery. Preserve existing scheduled-agent URLs and
      footer badge semantics.
- [ ] Pass focused tests, Storybook states and mobile tests; update integration,
      background-job and agent-runtime notes plus setup docs; commit
      milestone 1.

### Task 7: Slack Socket Mode intake and bounded context

**Files:** extend `src/shared/slack-connection.ts`, capsule connection service/
accessor, `src/backend/trpc/slack.trpc.ts`, `src/client/features/slack/`; create
capsule `service/slack-event-source.ts`, `slack-event-context.ts` and tests;
extend runtime composition and server lifecycle. Add the selected official
Socket Mode client and update the lockfile.

**Interfaces:** `setSlackEventCredentials({connectionId,appToken})` uses
encrypted storage separate from the existing bot credential; runtime adapter
exposes `start/stop/reconcileConnections`, receives an injected ingestEvent port
and acks only its committed result. Expose credential presence and health, never
tokens. Resolve the bot with auth.test and bots.info to obtain its app ID;
require the authenticated Socket Mode event api_app_id and team_id to match that
app and connection. Do not infer app identity from a token prefix. Connected
without a matching test event is unverified, not ready. Configure SDK logs to
exclude tokens, socket ticket URLs and event bodies.

- [ ] Test human root/reply messages, bots/edits/subtypes ignored, wrong team/
      app/channel, redelivery, invalid/oversized payloads, failed commit before
      ack, token rotation/disconnect and overlapping socket reconnects.
- [ ] Characterize bot app metadata, manual ack timing, event_ts ordering and
      context API permissions with a dedicated test app before enabling the
      feature. Test shared connections, per-channel verification, delayed
      delivery, pause/re-enable during catch-up, nonce expiry and host-clock
      skew.
- [ ] Test a message after channel A verification while channel B remains
      pending: hold it unevaluated, process it only after successful activation,
      and settle skipped on activation cancellation/expiry.
- [ ] Test includeThread/nearbyMessageCount, pagination, rate limits, truncation
      and unavailable history scopes. Required context failures yield ERROR, not
      silent partial classification. Cap context at 100 messages and 100,000
      total characters; flag omissions. Retrieve only channels authorized by the
      trigger.
- [ ] Implement setup/readiness, listener and context using validated provider
      APIs; pass tests. Report downtime gaps and explain live-delivery
      limitations.
- [ ] Integrate shutdown draining, masked token UI and scope/setup
      documentation; commit Slack intake without automatically enabling old
      triggers.

### Task 8: Semantic matching and replay evaluation

**Files:** create
`src/backend/services/session/service/agent-event-classifier.ts`,
`src/backend/prompts/agent-event-classification.ts` and result schema; expose a
session barrel capability; inject into runtime orchestration. Add deterministic
fixtures under `src/backend/services/agent-definition/testing/` and a manual
provider integration evaluation alongside existing agent-authoring evaluations.

**Interfaces:**
`classifyAgentEvent({provider,accountId,filterInstructions, eventContext}, signal): Promise<ClassificationResult>`;
strict output parser, 30-second limit and disposable process cleanup;
agent-definition owns decision and retry persistence. Never import
session-private metadata helpers cross-capsule.

- [ ] Tests cover match/skip/uncertain, malformed output, timeout/rate limits,
      no tools/MCP/config hooks, scope violations and instruction-injection
      attempts.
- [ ] Write/publish replay fixtures with expected labels and no real private
      messages; include >=40 cases across GitHub and Slack plus >=10 adversarial
      negatives. Separate the tuning set from held-out cases before tuning
      prompts.
- [ ] Pass deterministic tests; evaluate both supported providers separately on
      the same held-out set. Require zero adversarial false-positive dispatches,
      all designated obvious-positive cases matched, positive-case recall >=90%,
      and combined error/uncertain rate <=10%. Freeze obvious-positive labels
      before tuning; always-skip and always-uncertain classifiers must fail the
      gate. Report precision/recall, decision counts, latency and model/prompt
      versions. These are fixture release gates, not population accuracy claims.
- [ ] Enable semantic-filter activation only after the gate passes; expose
      skipped/error reasons and bounded reevaluation; commit milestone 2.

### Task 9: End-to-end verification and release

**Files:** add
`src/backend/orchestration/agent-runtime-flow.integration.test.ts`, extend
`server.upgrade.test.ts` and app-context composition suites; update
`docs/architecture/integrations.md`, `background-jobs.md`, `agent-runtime.md`,
`docs/admin-settings.md`, README and documentation index where needed.

- [ ] End-to-end GitHub label -> evaluation -> one run/workspace/session ->
      initial prompt -> retained result, plus equivalent Slack root/reply flows.
- [ ] Replay duplicates and restart at every task-4 boundary; assert zero second
      workspaces/automatic second sends, visible ambiguous outcomes, pause
      behavior, bounded capacity and source isolation. Include no-PR success and
      failure paths.
- [ ] Verify auth scope loss, app shutdown during source commit, full pagination
      catch-up and mixed legacy scheduled/event definitions with disposable
      fixtures.
- [ ] Run `pnpm check:prisma-schema`, `pnpm check:fix`, `pnpm typecheck`,
      `pnpm test`, `pnpm test:integration`, relevant Storybook checks,
      `pnpm test:e2e:mobile`, and `pnpm check`. Inspect formatting diff for
      unrelated changes; verify desktop Electron smoke behavior and documented
      setup steps.
- [ ] Run live opt-in GitHub/Slack smoke tests against explicitly configured
      test sources and both providers; never use production messages as
      fixtures.
- [ ] Release disabled-by-default capabilities by milestone; user activation is
      explicit. Report provider capture gaps, unsupported GitHub actions, backup
      limits and the measured semantic-evaluation results. Close #2772 only
      after both milestones meet the in-scope acceptance checks.

## Review record

Round 1: independent review found missing definition revision fences, exact
initial-session/batch ownership, activation baselines, durable workspace origin,
Slack readiness proof, explicit retry settlement and overlapping-trigger context
selection. All were incorporated; ledger versus run-input retention is
clarified.

Round 2: review found pending Slack activation messages could be skipped too
early, definition edits could reinterpret historical events, and an always-skip
classifier could pass the rollout gate. Added held pending-generation events,
fresh-baseline requirements after instruction/execution edits and positive/
reliability thresholds.

Round 3: the independent reviewer verified those fixes and their regression/
release checks, found no remaining high- or medium-severity design concerns, and
marked the plan converged. Implementation awaits user review of this plan.

## Provider references

- [GitHub repository issue events](https://docs.github.com/en/rest/issues/events)
- [GitHub issue event types](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types)
- [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Slack thread history](https://docs.slack.dev/reference/methods/conversations.replies/)

These are transport references; existing saved authoring configuration does not
by itself establish event-delivery capability.
