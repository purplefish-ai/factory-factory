# Finish event-triggered automations

Scoped in conversation on 2026-11-12. This document covers the work remaining
under
[issue #2772](https://github.com/purplefish-ai/factory-factory/issues/2772). It
extends, and does not replace, the
[event-triggered agents plan](../plans/2026-11-01-event-triggered-agents.md):
that plan's execution contracts still hold unless this document says otherwise.

## Why

The GitHub pipeline is built and its jobs run in the server: label-event
polling, matching, admission, launch, initial delivery, settlement and pruning.
Nothing can use it. No API or UI moves a trigger out of `PAUSED`, so the poller
never has a target. Several operator surfaces have backend procedures with no
client. Slack intake and natural-language filters are not started.

Success is: a user creates an automation, clicks Enable, labels an issue (or
posts in a Slack channel), and gets one workspace that does the work, with a run
they can inspect, recover and delete, and that always reaches a terminal state.

## Decided with Martin

- Include Slack intake in this effort, not only GitHub.
- Handle child workspaces instead of forbidding them, using the at-rest rule
  below. A final terminal state matters; a precise definition of done does not.
- Keep polling for GitHub. A local app cannot receive webhooks without a tunnel
  or hosted relay and repository-admin hook installation. Webhooks are planned
  for later; this effort delivers only a design note for them.
- Implementation is dispatched to non-Fable agents, one pull request per work
  package, each merged on green CI with no outstanding review comments.

## Non-goals

- GitHub `opened` and `edited` triggers. They stay saveable, cannot be enabled,
  and keep their specific reason. Do not approximate them from issue snapshots.
- Pull request, comment, review or CI triggers.
- Actor filters (`creatorIds`, `senderIds`); they stay rejected.
- Moving scheduled automations off `PeriodicTask`.
- Building webhook intake, a relay, or any hosted service.
- Adding event configuration or run history to logical export/import.
- Automatic replies to the source issue or Slack thread.

## Anti-goals

- An automation that starts listening without an explicit user click.
- A second workspace or a second automatic send for one event.
- A run that can never finish, or a stuck run with no way to clear it.
- Quietly skipping events after a source problem.

## Behavior

### Enable and pause (GitHub)

Add trusted-local `automation.enable` and `automation.pause`, both guarded by
`managementRevision`. They are user actions only; the MCP catalog gains no
activation tool.

- **Enable** applies to the whole automation (my call: one switch per
  automation, no per-trigger control in this effort). It validates on the server
  exactly what `validateDraft` previews: source capability with current access,
  and native model/effort support. It persists that validated execution intent
  with the definition revision it was checked against. Each configured trigger
  that is supported moves to `STARTING` with a new activation generation and a
  prepared provider baseline. A trigger becomes `ACTIVE` only when its baseline
  resolves and the definition, trigger revisions, connection and project still
  permit it, in one transaction. Unsupported triggers stay paused and report
  their reason. If no trigger can start, Enable fails with those reasons.
- A `STARTING` trigger that cannot complete (source error, recovery required, or
  no baseline within 30 minutes, my call) returns to `PAUSED` with a visible
  reason. Completion, cancellation and expiry run under `jobRunner`.
- **Pause** moves every trigger to `PAUSED`, advances its generation, clears
  pending activation and cancels unclaimed runs. Claimed runs finish. Re-enable
  always takes a fresh baseline, so events from the paused period never run.
- Two gates land with this work, because the docs name them as mandatory before
  activation: runtime source targeting, evaluation, admission and claim must
  require `isConfigured = true`; and activation and admission must refuse a
  definition without persisted validated intent for its current revision.
- The intent is a gate, not a freeze (my call). Explicit provider, model and
  effort selections are pinned. Inherited ones keep following the user's current
  defaults at admission, as today, so changing a default neither pauses the
  automation nor makes the intent stale. Admission must apply the same native
  normalization `validateAgentExecution` uses, so a run cannot launch with an
  effort its model rejects; a model the native catalog no longer confirms is a
  permanent evaluation error with a visible reason, not a launch.

### Child workspaces

Today any child ever created blocks settlement for good
(`agent-run-settlement.accessor.ts`). Replace that with an at-rest rule.

- A run settles when the existing conditions on its own initial turn hold and
  every child workspace is at rest.
- At rest means: archived, archiving or deleted; or setup failed; or the child
  has started at least once and has no turn running and nothing queued. A child
  waiting on a person's approval counts as at rest (my call). A child that is
  still setting up or has not yet started does not.
- Settlement is final. A child that wakes later is an ordinary workspace. It
  does not reopen the run and does not hold a capacity slot. Accepted cost: real
  concurrent work can exceed the run limits.
- A failed or cancelled run follows the same rule and does not stop its
  children.
- Pull request links from children are added to the run's result under the
  existing cap (my call).
- A child hold has a deadline (my call): 24 hours after the run's own initial
  turn ended, the run settles even if a child is still working or never started.
  The deadline is durable and checked by the existing launch-maintenance job.
- `ABANDON` in recovery becomes available when child work is the only thing
  holding a run, so the user can end it sooner.
- A run whose own initial turn completed or failed, and that is held only by
  children, keeps that outcome when the deadline or Abandon ends it:
  `COMPLETED`, `PR_CREATED` or `FAILED`, not `CANCELLED`. A run the user had
  already cancelled stays `CANCELLED`. A bounded reason records that children
  were still working.
- Runs whose child history coverage is unknown use the same live check (my
  call); no production data depends on the old distinction because nothing could
  be enabled.
- Today `hasChildWork` also blocks terminal run-context expiry. Change that:
  child work matters only before settlement. Once a run is terminal, by any path
  including the deadline and Abandon, its children no longer block expiry.

Left to the builder: where the at-rest signal is read (it must come through the
workspace and session capsule barrels, passed in by orchestration) and what
compact proof is persisted with the settlement.

### Automations page

- Enable/Pause control on the event automation detail, with the same
  Active/Paused language scheduled automations use. Each trigger shows a plain
  state: Listening, Starting, Paused, or Can't run with the reason. Source
  health is shown in words. Raw JSON and revision numbers move into a collapsed
  details section.
- Remove the "not available yet" copy in `event-agent-create.tsx`,
  `event-agent-detail.tsx` and `event-agent-editor.tsx` (agents feature) and
  `agent-proposal-card.tsx` (agent-authoring feature), replacing it with
  accurate statements.
- **Runs** and **Events** views from the existing `automation.runs` and
  `automation.evaluations` procedures: status, why an event matched or was
  skipped, workspace link, retained PR links, queued and capacity reasons.
- **Recovery** for a run needing attention, from the existing `recoveryTarget`,
  `inspectRun` and `resolveAmbiguousRun` procedures: inspect, then Resolve,
  Abandon or Retry through `ConfirmDialog`, with the plan's warning that prior
  effects may have occurred.
- **Delete** through a new `automation.delete`. It pauses, cancels queued runs,
  and is rejected while claimed runs are unfinished. It removes triggers, run
  history and the accepted proposal and keeps workspaces.
- **Reset source** through a new trusted-local procedure, shown when a source is
  in `RECOVERY_REQUIRED`. It is an explicit decision: it pauses every trigger on
  that connection, cancels their queued runs, starts a fresh scan from the
  current head and lifts the recovery fence, and requires Enable again. The
  dialog says events from the gap will not run. Reset never deletes retained
  proof: finalized markers, checkpoints, heads and issued baselines stay, and
  `getBaseline` keeps answering for issued IDs. The new scan is a new epoch
  beside the old one. Events captured but never ordered before the reset can
  never become eligible. How the epoch is represented is left to the builder.
- The workspace right panel shows the originating automation for event-run
  workspaces through the existing `automation.workspaceOrigin` procedure.

### GitHub coverage

- Add `reopened`, which is in the same issue-events feed. A label filter on a
  `reopened` trigger matches the issue's labels at capture (my call). Supported
  actions become `labeled` and `reopened`.
- The starting prompt also states the repository, issue number, issue link and
  the triggering action and label, as task data.

### Slack

Build milestone 2 as the earlier plan specifies in its execution contracts and
its task 7: separately encrypted app-level token, Socket Mode through the
official client behind a narrow adapter, acknowledge only after the event is
stored, team/app/ channel verification, activation by a test message in each
selected channel, visible delivery gaps, and bounded thread and nearby-message
context.

Slack enabling stays off behind a `configService` setting until a live check
against a dedicated test app passes (my call). Until then the existing
`SLACK_INTAKE_UNAVAILABLE` reason remains.

### Natural-language filters

Build the classifier and replay evaluation as the earlier plan specifies in its
task 8.

The implementing agent runs the live fixture gate itself, with the locally
installed provider CLIs and each provider's default small model, and reports the
measured results in its pull request (my call; this spends a small, bounded
amount on Martin's provider accounts). Enabling is per provider: a trigger with
`filterInstructions` can be enabled only when the automation's provider passed
the gate. A passing provider is unlocked in that same pull request. A provider
that fails, or that the agent cannot run, stays off with the existing reason and
is reported to Martin.

An inherited provider can change after Enable, so the gate is also checked for
the provider actually resolved for each event. A deterministic match whose
effective provider has not passed is a visible, non-dispatching skip; it never
runs unfiltered and never calls an unproven classifier.

### Verification and close-out

- An integration test that goes through the real Enable procedure: label event,
  one run, one workspace and session, initial prompt, terminal result. Include a
  run that creates a child. Cover pause racing a claim and restart at the launch
  boundaries from the earlier plan's task 9.
- An opt-in live GitHub test against a repository named by configuration, never
  run in CI.
- Update `integrations.md`, `background-jobs.md` and `agent-runtime.md` where
  they say activation, operator UI or the child-work decision are outstanding.
  Tick the earlier plan's completed checkboxes. The coordinator comments on
  #2772 with what shipped and the known limits once the work has merged.
- A short webhook design note: tunnel versus relay, hook installation, and how a
  second intake feeds the same event ledger.

## Work packages

Each package is one pull request from its own worktree, branched from current
`main`. Packages in a wave run in parallel unless marked.

The [implementation plan](../plans/2026-11-12-finish-event-automations.md)
merges packages 7 and 12 into one task and renumbers the rest; its numbering is
the one agents and pull requests use.

**Wave 1**

1. Enable/pause backend for GitHub, with both gates.
2. Child at-rest settlement and the Abandon change.
3. Runs and Events views, and the workspace origin panel (client only).
4. `reopened` and the richer starting prompt.
5. Source reset backend.
6. Slack app-token storage and settings UI.
7. Classifier module and replay fixtures, not yet wired to enabling.

**Wave 2**

8. Enable/Pause UI, copy removal and Reset source UI (needs 1, 3, 5).
9. Recovery UI (needs 2, 3; after 8, same screen).
10. Delete backend and UI (needs 1; after 9, same screen).
11. Slack Socket Mode listener and event storage (needs 6).
12. Wire the classifier into evaluation and run the replay gate (needs 7).

**Wave 3**

13. Slack activation by test message, backend and UI (needs 1, 8, 11).
14. Slack thread and nearby-message context (needs 11).
15. End-to-end test, docs, plan checkboxes and the #2772 comment.
16. Webhook design note.

**After Martin's live checks**

17. Turn Slack enabling on.

## Constraints

- The global constraints in the plan apply: capsule boundaries, single writers
  in `registry.ts`, Zod at boundaries, `GitHubCLIService` for `gh`, `jobRunner`
  for recurring work, `configService` for configuration, no secrets in reads,
  snapshots, errors or logs.
- Read the backend services and client features guides and the matching
  architecture notes before editing.
- Follow `CONTRIBUTING.md` for verification and pull requests. UI packages
  include stories and focused tests.
- A package that changes `schema.prisma` rebases on `main` and regenerates
  before merge.
- Merge only on green CI with no outstanding review comments. When an agent
  declines a review comment, the dispatcher resolves and merges if it agrees and
  escalates to Martin if unsure.

## Needs Martin

- A dedicated Slack test app with Socket Mode and an app-level token, and a
  channel to test in, before package 17.
- A throwaway GitHub repository for the opt-in live label test.
