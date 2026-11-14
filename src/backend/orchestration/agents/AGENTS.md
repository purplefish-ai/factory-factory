# Event automation orchestration

Composition around the agent-definition capsule: the event runtime's recurring
jobs and its Slack listener, the launch consumer that turns a claimed run into a
workspace and session, run monitoring and recovery, and the authoring and
management flows that need other capsules. This guide so far covers the event
runtime's jobs, how the runtime stops, and saved management and authoring; the
consumer, monitoring and recovery rules are in, and will be added to, the
[`event-run/` guide](event-run/AGENTS.md). The
[services guide](../../services/AGENTS.md) covers capsule boundaries; the job
runner is in "Recurring work" in the [backend process guide](../../AGENTS.md).
Bare file names below are in this directory; paths that start with `src/` are
from the repository root.

## Owns, and does not own

This directory owns which event runtime jobs exist, what one pass of each does
and in which order, how the runtime stops, and the provider wiring behind the
capsule's ports (GitHub reads, the event classifier, Slack context and sockets),
source discovery and verification, draft validation and history's workspace
provenance. It does not own:

- Sources, events, evaluations, the run queue, claims, activation, retention,
  `SlackEventSource` and Slack intake rules (its `service/` guide):
  `src/backend/services/agent-definition/`.
- GitHub reads and their shared process budget: `src/backend/services/github/`.
- The disposable classifier call: `classifyAgentEvent` in
  `src/backend/services/session/`.
- Scheduled automations and their poll: `src/backend/services/periodic-task/`.
- Where the runtime stops in backend shutdown (first, before sessions):
  `src/backend/application-shutdown.ts`.

## Public surface

There is no barrel. `src/backend/app-context.ts` composes `createAgentRuntime`
(`start`, `stop`, `hasWork`, `drain`, `recovery`), `createAgentManagement` and
`createAgentAuthoring`.

## Jobs

`createAgentRuntime` registers three jobs and composes a fourth through
`createSlackIntake`. Each runs at start, then waits its interval after a run
ends:

- `agent-source-poll`, 60 seconds: GitHub capture for each target, up to
  `githubPagesPerCycle` (ten, in `src/backend/services/config.service.ts`) pages
  per repository, then completion of pending GitHub activations.
- `agent-event-evaluation`, 5 seconds: queue maintenance, ledger retention,
  pending Slack activations, evaluation, then a claim handed to the consumer.
- `agent-launch-maintenance`, 5 seconds: lease renewal for owned launches,
  takeover of recoverable runs and adoption of their observation.
- `agent-slack-intake`, 15 seconds: which Slack connections hold a socket.

There is no separate activation or retention job.

## Invariants

- A source poll run completes pending GitHub activations after its poll cycle,
  in the same job. `agent-runtime.orchestrator.test.ts`.
- An evaluation run maintains the queue, then prunes the ledger, before it
  evaluates; it completes Slack activations before it evaluates, and claims only
  after it evaluates. `agent-runtime.orchestrator.test.ts`.
- A failed ledger retention logs a warning with only the fixed
  `RETENTION_FAILED` reason, and nothing once the run's signal has aborted; the
  pass goes on to evaluation and its claim step unless the signal has aborted.
  `agent-runtime.orchestrator.test.ts`.
- Launch maintenance keeps renewing while an evaluation run is stalled.
  `agent-runtime.orchestrator.test.ts`.
- Stopping the runtime closes launch admission before it drains owned launches,
  and does not return while a committed claim is still being handed off.
  `agent-runtime.orchestrator.test.ts`.
- Stopping the Slack intake disconnects every socket and records the stop before
  it returns, and the intake opens no socket while its gate is off.
  `slack-intake.orchestrator.integration.test.ts`.
- `updateSaved`, `projectSources` and `validateDraft` refuse an archived
  project; `get` does not.
  `src/backend/trpc/agent-management.integration.test.ts`.
- Proposals accept only the project's repository, labels it has and Slack
  channels the bot can read, and a saved edit fails when the project's
  repository changed meanwhile. `src/backend/trpc/agent.integration.test.ts`,
  `src/backend/trpc/agent-management.integration.test.ts`.
- Source discovery drops a Slack connection that was disconnected or changed
  identity while it ran, and fails when it was the selected one.
  `src/backend/trpc/agent-management.integration.test.ts`.
- Ordinary reads never call native discovery; `validateDraft`, a POST mutation,
  judges filters for the provider resolved then, an inherited one included.
  `src/backend/trpc/agent-management.integration.test.ts`.
- History shows `LIVE` or `DELETED` only from the workspace's retained origin,
  and a run whose workspace link disagrees with it reads as `NOT_FOUND`.
  `src/backend/trpc/agent-management.integration.test.ts`.
- The classifier port calls with the default account and drops the reason text.
  `agent-event-classifier.orchestrator.test.ts`.

## Map

- `agent-runtime.orchestrator.ts`: the runtime and its jobs; admission-time
  execution settings (`resolveAgentExecutionConfig`).
- `slack-intake.orchestrator.ts`, `slack-socket.ts`: the Slack job and the
  Socket Mode client behind the capsule's adapter.
- `agent-event-classifier.orchestrator.ts`: the classifier port.
- `event-run/`: the launch consumer; see [its guide](event-run/AGENTS.md).
- `agent-management.orchestrator.ts`, `agent-authoring.orchestrator.ts`,
  `agent-sources.orchestrator.ts`, `agent-native-validation.ts`: saved
  automations, proposals, source discovery and native model checks.

## Decisions

- [Draft validation is a POST mutation](../../../../docs/decisions/2026-11-14-draft-validation-is-a-post-mutation.md)
