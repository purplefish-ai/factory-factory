# Finish event-triggered automations implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user enable a saved event automation and get one observable,
recoverable run per GitHub or Slack event, with every run reaching a terminal
state.

**Architecture:** The durable pipeline already exists (intake, ledger,
evaluation, admission, launch, settlement). This plan adds the missing
activation boundary, the operator surfaces over existing procedures, child
workspace settlement, and the Slack and classifier milestones. The
agent-definition capsule keeps owning persistence; orchestration under
`src/backend/orchestration/agents/` connects it to GitHub, Slack, workspace and
session capsules through their barrels.

**Tech stack:** TypeScript, Prisma/SQLite, Zod, jobRunner, Express/tRPC, React,
`@slack/socket-mode`, Vitest, Storybook.

**Spec:**
[finish event automations design](../specs/2026-11-12-finish-event-automations-design.md).
It extends the
[event-triggered agents plan](2026-11-01-event-triggered-agents.md), whose
execution contracts still apply. Executors read all three documents.

## Global constraints

- Node from `.node-version`, pnpm from `package.json`; never npm or yarn.
- Read `src/backend/services/AGENTS.md`, `src/client/features/AGENTS.md` and the
  matching architecture note before editing an area.
- Capsule barrels across boundaries; cross-capsule coordination in
  `src/backend/orchestration/agents/`; one writer per Prisma model in
  `services/registry.ts`.
- Zod at every boundary and on stored JSON; no casts of parsed data, no
  `z.any()`.
- `gh` only through `GitHubCLIService`; recurring work only through `jobRunner`;
  configuration only through `configService`.
- Secrets never appear in reads, run snapshots, errors or logs.
- Event content is task data, never authority over triggers, execution settings
  or permissions.
- Enabling is a trusted-local user action. The MCP catalog gains no activation,
  recovery, delete or reset tool.
- `ConfirmDialog` for confirmations; no native dialogs.
- Each task is one pull request from a branch named
  `martin-purplefish/automation-<slug>`, cut from current `origin/main`.
- Verification per `CONTRIBUTING.md`: `pnpm check:fix`, `pnpm typecheck`,
  `pnpm test`, `pnpm test:integration` when integration behavior changes,
  `pnpm check:prisma-schema` when the schema changes, Storybook checks for UI,
  then `pnpm check`.
- Implementers open the pull request and fix valid review comments. They do not
  merge, resolve threads or post pull request comments; they report declined
  comments to the coordinator.

## Review focus

1. A user edits the instructions of an enabled automation while a trigger is
   still `STARTING`: the trigger must end `PAUSED`, never `ACTIVE` under the new
   revision. Test in task 1.
2. A run's child is created in the same moment the run is settling: the run must
   not settle on a stale observation. Test in task 2.
3. A stuck run is abandoned from a browser tab that loaded before a retry
   rotated the attempt: the action must fail with a conflict and the UI must
   keep the dialog open with a reload prompt. Test in task 9.
4. A source is reset while one of its events is mid-evaluation: the event must
   not admit a run after the reset. Test in task 5.
5. A Slack verification message arrives after its ten-minute window, or in a
   channel that was removed by an edit: it must neither enable the trigger nor
   start a run. Test in task 12.

---

## Shared names

These names cross task boundaries. Use them exactly.

| Name                                       | Defined by                                                              | Shape                                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentActivationInputSchema`               | task 1, `src/shared/agent-management.ts`                                | `agentOwnerInputSchema.extend({ expectedManagementRevision })`                                                                                            |
| `automation.enable`, `automation.pause`    | task 1                                                                  | mutation, input `agentActivationInputSchema`, output `managedAgentSchema`                                                                                 |
| `managedTriggerSchema.pausedReasonCode`    | task 1                                                                  | `'ACTIVATION_EXPIRED' \| 'SOURCE_ERROR' \| 'SOURCE_RECOVERY_REQUIRED' \| null`                                                                            |
| `managedTriggerSchema.pendingVerification` | task 12                                                                 | `{ message, expiresAt, channels: { channelId, verified }[] } \| null`                                                                                     |
| `agentValidatedIntentSchema`               | task 1, `src/shared/agent-management.ts`                                | `{ version: 1, definitionRevision, validatedAt, execution }` stored in `AgentDefinition.validatedIntent`                                                  |
| `pauseTriggers(tx, where)`                 | task 1 or 5, whichever merges first, `resources/agent-trigger-pause.ts` | pauses matching triggers, advances generation, clears pending activation and boundary, cancels unclaimed runs; returns counts                             |
| `eventChildRestSchema`                     | task 2, `src/shared/event-child-rest.ts`                                | `{ atRest: boolean, children: { workspaceId, state }[] }`, state one of `ARCHIVED`, `SETUP_FAILED`, `IDLE`, `WAITING_ON_PERSON`, `NOT_STARTED`, `WORKING` |
| `automation.resetSource`                   | task 5                                                                  | mutation, input `{ projectId, connectionId }`, output `{ connectionId, pausedTriggerCount, cancelledRunCount }`                                           |
| `automation.delete`                        | task 10                                                                 | mutation, input `agentActivationInputSchema`, output `{ deleted: true }`                                                                                  |
| `slack.setAppToken`, `slack.clearAppToken` | task 6                                                                  | mutations; summary gains `hasAppToken: boolean` and `appId: string \| null`                                                                               |
| `slackIntakeEnabled`                       | task 6                                                                  | `configService.getAgentRuntimeLimits().slackIntakeEnabled`, from env `AGENT_SLACK_INTAKE_ENABLED`, default `false`                                        |
| `classifyAgentEvent`                       | task 7, session barrel                                                  | `({ provider, accountId, filterInstructions, eventContext }, signal) => Promise<{ decision: 'match' \| 'skip' \| 'uncertain', reason: string }>`          |

Limits added to `loadAgentRuntimeLimits()`: `activationExpiryMs` = 30 minutes
(task 1) and `childHoldDeadlineMs` = 24 hours (task 2).

Errors use `ApplicationError`: a stale `expectedManagementRevision` or stale
recovery context is `CONFLICT`; nothing that can start, or unfinished claimed
runs on delete, is `PRECONDITION_FAILED`; foreign project or agent IDs are
`NOT_FOUND`.

## Wave 1

### Task 1: Enable and pause for GitHub (`automation-enable-backend`)

**Files:** modify `prisma/schema.prisma` (+ migration, generated output),
`src/shared/agent-management.ts`, `src/backend/trpc/agent.trpc.ts`,
`src/backend/orchestration/agents/agent-management.orchestrator.ts`,
`agent-runtime.orchestrator.ts`, `src/backend/services/config.service.ts`,
capsule `index.ts`, `resources/agent-runtime-guards.ts`,
`agent-run-claim.accessor.ts`, `agent-evaluation-candidates.accessor.ts`,
`agent-source-queries.ts`, `service/agent-management-projection.ts`; create
`service/agent-activation.service.ts`, `resources/agent-activation.accessor.ts`,
`resources/agent-trigger-pause.ts` and co-located integration tests.

**Interfaces:**

- Consumes: `AgentSourcePollService.prepareBaseline` / `getBaseline`,
  `validateAgentExecution`, `triggerCapability`, the source checks behind
  `validateDraft`.
- Produces: everything task 1 defines in Shared names; schema columns
  `AgentDefinition.validatedIntent Json?` and
  `AgentTrigger.pausedReasonCode String?`; orchestrator methods
  `agentManagement.enable(input)` and `agentManagement.pause(input)`; capsule
  `AgentActivationService` with `begin`, `completePending(signal)` and `pause`.
  `completePending` runs after each `agent-source-poll` cycle; no new job.

- [ ] Write failing integration tests: enable with one supported and one
      unsupported trigger leaves the first `STARTING` then `ACTIVE` with a
      boundary and the second `PAUSED` with its capability reason; enable with
      nothing supported throws `PRECONDITION_FAILED`; stale revision throws
      `CONFLICT`; an edit during `STARTING` ends `PAUSED` (review focus 1); a
      `STARTING` trigger older than `activationExpiryMs` returns to `PAUSED`
      with `ACTIVATION_EXPIRED`; pause cancels a queued run and leaves a claimed
      run running; an event before the boundary never runs and one after it
      does; a trigger with `isConfigured` null or false is never a source
      target, candidate, admission or claim; admission refuses a definition
      whose `validatedIntent.definitionRevision` is not current; an inherited
      effort the model rejects is normalized at admission.
- [ ] Run them and confirm they fail for missing behavior.
- [ ] Implement schema, accessor, service, guards, orchestrator and procedures.
- [ ] Run `pnpm check:prisma-schema`, the focused tests, then full verification.
- [ ] Update the activation statements in `integrations.md`,
      `background-jobs.md` and `agent-runtime.md` that this task makes false.
- [ ] Commit, push, open the pull request.

### Task 2: Child at-rest settlement (`automation-child-rest`)

**Files:** create `src/shared/event-child-rest.ts`,
`src/backend/orchestration/agents/event-child-rest.orchestrator.ts` and tests;
modify `event-run-monitor.orchestrator.ts`,
`resources/agent-run-settlement.accessor.ts`, `agent-run-recovery.accessor.ts`,
`agent-retention-dependencies.ts`, `agent-run-context-retention.accessor.ts`,
`src/shared/event-agent-recovery.ts`, `config.service.ts`, workspace and session
barrels as needed for the read.

**Interfaces:**

- Produces: `observeChildRest(parentWorkspaceId): Promise<EventChildRest>`;
  `agentRunSettlementAccessor.observe` takes the observation as a new argument
  after `result`; reason codes `CHILD_HOLD_EXPIRED` and
  `ABANDONED_WITH_CHILD_WORK`; inspection reports child hold as its own block so
  the UI can offer Abandon.
- The settlement transaction compares the current set of child workspace IDs
  with the observation and rolls back when they differ.

- [ ] Write failing tests: a run whose only child is idle after one turn settles
      `COMPLETED`; a child that has not started holds the run; archived, deleted
      and setup-failed children do not hold; a child waiting on an approval does
      not hold; a child created between observation and write rolls the
      settlement back (review focus 2); after `childHoldDeadlineMs` the run
      settles with its own outcome and `CHILD_HOLD_EXPIRED`; Abandon on a
      child-held completed run records `COMPLETED` (or `PR_CREATED` with links),
      not `CANCELLED`; child pull request links appear in the result under the
      20-link cap; a failed run does not stop its children; a terminal run's
      context can expire while a child exists.
- [ ] Confirm failure, implement, run focused then full verification.
- [ ] Replace the child-work statements in `agent-runtime.md`.
- [ ] Commit, push, open the pull request.

### Task 3: Runs, Events and origin panel (`automation-history-ui`)

**Files:** create `src/client/features/agents/event-run-history.tsx`,
`event-evaluation-history.tsx`,
`src/client/features/workspace/automation-origin-panel.tsx`, stories and tests;
modify `event-agent-selection.tsx`, `types.ts`,
`src/client/features/workspace/right-panel-tools.tsx`, `right-panel-state.ts`,
`mobile-tool-switcher.tsx`, `src/client/lib/agent-query-cache.ts`.

**Interfaces:**

- Consumes: `automation.runs`, `automation.evaluations`,
  `automation.workspaceOrigin` as they exist. No backend change.
- Produces: `<EventRunHistory projectId agentId projectSlug />` and
  `<EventEvaluationHistory projectId agentId />`, each rendering a slot
  `renderRunActions?: (run) => ReactNode` that task 9 fills.

- [ ] Write failing component tests: runs list shows status, reason in words,
      workspace link or "Workspace unavailable", and PR links; "Load more"
      requests the next cursor; Events list shows matched, skipped and error
      with the stored explanation; a failed read keeps cached rows with a retry
      notice; the right panel shows the automation tab for a workspace whose
      origin query returns a run and links to the automation; a scheduled
      workspace is unchanged.
- [ ] Confirm failure, implement following `agent-run-history.tsx` and
      `periodic-task-panel.tsx`, add stories for loading, empty, error and
      populated states, run UI verification.
- [ ] Commit, push, open the pull request.

### Task 4: `reopened` and the starting prompt (`automation-github-reopened`)

**Files:** modify
`src/backend/services/github/service/github-cli/agent-issue-events.ts`,
`src/shared/agent-runtime.ts`, `service/agent-event-matcher.ts`,
`service/agent-management-projection.ts`,
`service/agent-event-evaluation.service.ts`, `src/shared/agent-proposal.ts` and
their tests.

**Interfaces:**

- Produces: GitHub payload `issue.labels: string[]` (at most 100, default `[]`);
  supported actions `labeled` and `reopened`; a first context item
  `${eventId}:source` whose text is exactly

  ```
  Repository: <owner/name>
  Issue: #<number> <url>
  Trigger: <action> <"label" when labeled>
  ```

  followed by the existing title and body items. `event-run-launch` is
  unchanged.

- `UNSUPPORTED_GITHUB_ACTION` explanation becomes "Only GitHub labeled and
  reopened events are supported."

- [ ] Write failing tests: a `reopened` issue event becomes an executable event
      and a `reopened` pull request event stays a control anchor; a `reopened`
      trigger with labels matches only when the issue carries one; without
      labels it matches; a trigger listing `opened` stays unsupported; stored
      payloads without `labels` still parse; the admitted run input starts with
      the source item.
- [ ] Confirm failure, implement, run focused then full verification.
- [ ] Update `integrations.md` and `background-jobs.md` where they say only
      `labeled`.
- [ ] Commit, push, open the pull request.

### Task 5: Source reset (`automation-source-reset`)

**Files:** modify `prisma/schema.prisma` if an epoch column is needed (+
migration), `resources/agent-source.accessor.ts`, `agent-source-queries.ts`,
`service/agent-source-poll.service.ts`, `src/shared/agent-management.ts`,
`agent.trpc.ts`, `agent-management.orchestrator.ts`; create
`resources/agent-trigger-pause.ts` if task 1 has not merged it; integration
tests beside `agent-source-recovery.integration.test.ts`.

**Interfaces:**

- Consumes: `pauseTriggers` (Shared names).
- Produces: `automation.resetSource`. The project must have a configured trigger
  on the connection, otherwise `NOT_FOUND`. A source not in `RECOVERY_REQUIRED`
  is `PRECONDITION_FAILED`.

- [ ] Write failing tests: reset on a `RECOVERY_REQUIRED` source pauses its
      triggers across definitions, cancels their queued runs, and the next poll
      cycle captures a fresh head with health no longer `RECOVERY_REQUIRED`;
      finalized markers, checkpoints, heads and baseline rows are byte-for-byte
      unchanged and `getBaseline` still answers an old ID; an event captured but
      unordered before the reset is never eligible after re-enable; an event
      mid-evaluation at reset admits no run (review focus 4); reset on a healthy
      source is refused; a second reset is idempotent.
- [ ] Confirm failure, implement, run `pnpm test:integration` for the capsule,
      then full verification.
- [ ] Document the operation in `integrations.md`.
- [ ] Commit, push, open the pull request.

### Task 6: Slack app token (`automation-slack-app-token`)

**Files:** modify `prisma/schema.prisma` (+ migration),
`src/shared/slack-connection.ts`, `service/slack-connection.service.ts` and its
accessor, `src/backend/trpc/slack.trpc.ts`, `env-schemas.ts`,
`config.service.ts`, `src/client/features/slack/slack-settings.tsx`, recovery
export readers that enumerate connection fields, stories and tests.

**Interfaces:**

- Produces: column `AgentConnection.appCredentialsEncrypted String?`;
  `slack.setAppToken({ connectionId, appToken })` and
  `slack.clearAppToken({ connectionId })`; summary fields `hasAppToken` and
  `appId`; internal `getAppCredentials(connectionId)` for task 11;
  `slackIntakeEnabled`.
- The token must start with `xapp-`. Validate it with `apps.connections.open`
  (ten-second timeout, redirects rejected, response Zod-validated, socket URL
  discarded and never logged). Resolve the bot's app ID with `auth.test` and
  `bots.info` and store it as connection metadata.

- [ ] Write failing tests: a valid token is stored encrypted separately from the
      bot token and never appears in list, test or error output; a token for
      another workspace or app is rejected; disconnect clears both credentials;
      logical export still contains no token; the settings form masks entry,
      never prefills, and shows presence.
- [ ] Confirm failure, implement, run schema and UI verification.
- [ ] Update the Slack credentials section of `integrations.md` and
      `docs/admin-settings.md`.
- [ ] Commit, push, open the pull request.

### Task 7: Natural-language filters (`automation-semantic-filters`)

**Files:** create
`src/backend/services/session/service/agent-event-classifier.ts`,
`src/backend/prompts/agent-event-classification.ts`, fixtures under
`src/backend/services/agent-definition/testing/`, a manual evaluation test
beside `agent-authoring.manual.integration.test.ts`; modify the session barrel,
`agent-runtime.orchestrator.ts`, `service/agent-event-evaluation.service.ts`,
`agent-event-matcher.ts`, `agent-management-projection.ts`, `config.service.ts`
and tests.

**Interfaces:**

- Produces: `classifyAgentEvent` (Shared names) injected as an evaluation port;
  classifier settings in `configService` separate from execution settings; a
  checked-in record
  `src/backend/services/agent-definition/testing/classifier-gate.json` with
  `{ provider, model, promptVersion, passed, measuredAt, metrics }` per
  provider. `triggerCapability` reports `UNSUPPORTED_SEMANTIC_FILTER` unless the
  automation's provider has `passed: true` in that record.
- Limits from the plan: 30 seconds per call, two concurrent calls, no tools, MCP
  servers, repository instructions or credentials. `uncertain`, malformed output
  and failures never dispatch.

- [ ] Write failing deterministic tests: match, skip, uncertain, malformed
      output, timeout, rate limit with retry, an instruction-injection event
      that asks to be matched, and a filter that tries to widen scope.
- [ ] Add at least 40 fixture cases across GitHub and Slack plus at least 10
      adversarial negatives, split into tuning and held-out sets before tuning.
- [ ] Implement, pass deterministic tests.
- [ ] Run the live gate for Claude and Codex with each provider's default small
      model. Pass requires zero adversarial false positives, every designated
      obvious positive matched, positive recall at least 90% and combined
      error/uncertain at most 10%. Record results in `classifier-gate.json`; a
      provider that fails or cannot be run stays `passed: false`.
- [ ] Update `integrations.md`; put measured results in the pull request body.
- [ ] Commit, push, open the pull request.

## Wave 2

### Task 8: Enable, pause and reset controls (`automation-enable-ui`)

Needs tasks 1, 3 and 5 merged.

**Files:** modify `src/client/features/agents/event-agent-detail.tsx`,
`event-agent-selection.tsx`, `event-agent-editor.tsx`, `event-agent-create.tsx`,
`agents-dashboard-shell.tsx`, `use-event-agent-editor.ts`,
`src/client/features/agent-authoring/agent-proposal-card.tsx`,
`src/client/lib/agent-query-cache.ts`, stories and tests; create
`event-trigger-status.tsx`.

**Interfaces:** consumes `automation.enable`, `automation.pause`,
`automation.resetSource`, `pausedReasonCode`.

- [ ] Write failing tests: Enable calls the mutation with the loaded revision
      and shows each trigger as Listening, Starting, Paused or Can't run with
      its reason; a `PRECONDITION_FAILED` lists the reasons inline; a `CONFLICT`
      prompts a reload and keeps the page; Pause says active work continues; a
      source in `RECOVERY_REQUIRED` shows Reset source behind a `ConfirmDialog`
      stating that events from the gap will not run; raw JSON and revision
      numbers sit in a collapsed details section; none of the four files still
      says listening is unavailable; archived projects disable the controls.
- [ ] Confirm failure, implement, add stories for each trigger state, run UI
      verification including `pnpm test:e2e:mobile`.
- [ ] Update the Automations page section of `integrations.md`.
- [ ] Commit, push, open the pull request.

### Task 9: Run recovery (`automation-recovery-ui`)

Needs tasks 2, 3 and 8 merged.

**Files:** create `src/client/features/agents/event-run-recovery.tsx`, stories
and tests; modify `event-run-history.tsx` to fill `renderRunActions`.

**Interfaces:** consumes `automation.recoveryTarget`, `inspectRun`,
`resolveAmbiguousRun` and the child-hold block from task 2.

- [ ] Write failing tests: a run needing attention shows Inspect; inspection
      shows only the actions the server reports available, with the block reason
      for the others; Retry warns that earlier effects may have occurred;
      Abandon on a child-held run says the run will keep its outcome; a
      `CONFLICT` from a stale context keeps the dialog open with a reload prompt
      and sends nothing further (review focus 3); success refreshes the run list
      and navigation summary.
- [ ] Confirm failure, implement, add stories, run UI verification.
- [ ] Commit, push, open the pull request.

### Task 10: Delete (`automation-delete`)

Needs tasks 1 and 9 merged.

**Files:** modify `src/shared/agent-management.ts`, `agent.trpc.ts`,
`agent-management.orchestrator.ts`, `service/agent-management.service.ts`,
`resources/agent-management.accessor.ts`,
`src/client/features/agents/use-agents-controller.ts`,
`event-agent-selection.tsx`, stories and tests.

**Interfaces:** produces `automation.delete`; consumes `pauseTriggers`.

- [ ] Write failing tests: delete pauses, cancels queued runs and removes the
      definition, triggers, run history and accepted proposal in one transaction
      while workspaces remain; an unfinished claimed run makes it
      `PRECONDITION_FAILED` and changes nothing; stale revision is `CONFLICT`;
      the UI confirms through `ConfirmDialog`, names what is removed, and
      returns to the list; scheduled delete is unchanged.
- [ ] Confirm failure, implement, run full and UI verification.
- [ ] Commit, push, open the pull request.

### Task 11: Slack listener (`automation-slack-listener`)

Needs task 6 merged. Follows plan task 7.

**Files:** add `@slack/socket-mode` (lockfile); create
`service/slack-event-source.ts`,
`src/backend/orchestration/agents/slack-intake.orchestrator.ts` and tests;
modify `agent-runtime.orchestrator.ts`, `resources/agent-source-queries.ts`,
capsule barrel, `server.ts` shutdown ordering if required.

**Interfaces:**

- Consumes: `getAppCredentials`, `ingestEvent`, `slackIntakeEnabled`.
- Produces: an adapter with `start()`, `stop()` and
  `reconcileConnections(signal)` run under `jobRunner`; it connects only when
  the gate is on and a connection has an app token and an `ACTIVE` or `STARTING`
  Slack trigger. Source health `READY`, `DISCONNECTED` and gap records in the
  Slack cursor.

- [ ] Write failing tests with a fake socket client: a human root message and a
      reply are stored then acknowledged; a failed insert is not acknowledged; a
      duplicate is acknowledged without a second row; bot, edit, delete and
      subtype messages and unsupported envelopes are acknowledged and not
      stored; wrong team, app or channel is rejected; an oversized payload is
      bounded; a disconnect records a gap; token rotation reconnects once;
      overlapping reconnects leave one socket; the gate off means no connection;
      SDK logs contain no token, socket URL or message body.
- [ ] Confirm failure, implement, run focused then full verification.
- [ ] Update `integrations.md` and `background-jobs.md`.
- [ ] Commit, push, open the pull request.

## Wave 3

### Task 12: Slack activation (`automation-slack-activation`)

Needs tasks 1, 8 and 11 merged.

**Files:** modify `service/agent-activation.service.ts`,
`resources/agent-activation.accessor.ts`, `service/slack-event-source.ts`,
`agent-management-projection.ts`, `src/shared/agent-management.ts`,
`src/client/features/agents/event-trigger-status.tsx`, stories and tests.

**Interfaces:** produces `pendingVerification`; Slack triggers are supported
only when `slackIntakeEnabled` is true.

- [ ] Write failing tests: enabling a Slack trigger stores a ten-minute nonce
      and shows the exact message to post per channel; a matching human message
      in each channel records that channel's `event_ts` boundary and creates no
      run; the trigger turns `ACTIVE` only after every channel verifies; a
      message after channel A verified while B is pending is held, then runs
      after activation; expiry or cancel settles held messages as skipped; a
      late or wrong-channel verification message does nothing (review focus 5);
      re-enable needs a fresh verification; with the gate off the capability
      stays `SLACK_INTAKE_UNAVAILABLE`.
- [ ] Confirm failure, implement, add stories, run full and UI verification.
- [ ] Update `integrations.md`.
- [ ] Commit, push, open the pull request.

### Task 13: Slack context (`automation-slack-context`)

Needs task 11 merged.

**Files:** create `service/slack-event-context.ts` and tests; modify
`service/agent-event-evaluation.service.ts`, `slack-sources.ts`,
`agent-runtime.orchestrator.ts`.

**Interfaces:** an evaluation port `resolveSlackContext(event, config, signal)`
returning context items for `agentRunInputSchema`, capped at 100 messages and
100,000 characters with an explicit omission marker.

- [ ] Write failing tests: `includeThread` adds the thread; `nearbyMessageCount`
      adds neighbors; pagination and rate limits are followed; truncation is
      flagged; a missing history scope yields an `ERROR` evaluation, not a
      partial run; only channels the trigger selects are read.
- [ ] Confirm failure, implement, run focused then full verification.
- [ ] Commit, push, open the pull request.

### Task 14: End-to-end test and close-out (`automation-e2e-closeout`)

Needs every GitHub task merged.

**Files:** create
`src/backend/orchestration/agents/agent-runtime-flow.integration.test.ts` and an
opt-in live test; modify
`src/backend/orchestration/testing/event-delivery.test-support.ts` to enable
through the real procedure; update `integrations.md`, `background-jobs.md`,
`agent-runtime.md`, `docs/README.md`, and tick completed boxes in
[the earlier plan](2026-11-01-event-triggered-agents.md).

- [ ] Write the flow test: enable through `automation.enable`, deliver a label
      event fixture, assert one evaluation, one run, one workspace and session,
      the initial prompt with the source item, and a terminal result; repeat
      with a run that creates a child; replay the event and restart at each
      launch boundary and assert no second workspace or send; pause racing a
      claim.
- [ ] Add the live test, skipped unless `AGENT_LIVE_GITHUB_REPO` is set.
- [ ] Run full verification.
- [ ] Post the completion comment on #2772 only when the coordinator asks.
- [ ] Commit, push, open the pull request.

### Task 15: Webhook design note (`automation-webhook-note`)

**Files:** create `docs/design/github-webhook-intake.md`; link it from
`docs/README.md`.

- [ ] Write the note: why polling ships first; tunnel versus hosted relay; hook
      installation and signature verification; how deliveries map onto
      `(connectionId, providerEventId)` and what replaces the polling activation
      boundary; which triggers webhooks unlock (`opened`, `edited`, pull request
      events).
- [ ] Run documentation verification, commit, push, open the pull request.

## After the live checks

### Task 16: Turn Slack on (`automation-slack-enable`)

After Martin confirms the live Slack check: default `AGENT_SLACK_INTAKE_ENABLED`
to `true`, update the docs, and state the measured limits.
