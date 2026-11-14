# Event automation orchestration

Composition around the agent-definition capsule: the event runtime's recurring
jobs and its Slack listener, the launch consumer that turns a claimed run into a
workspace and session, run monitoring and recovery, and the authoring and
management flows that need other capsules. The
[services guide](../../services/AGENTS.md) covers capsule boundaries and the job
runner. Bare file names below are in this directory; paths that start with
`src/` are from the repository root.

## Owns, and does not own

This directory owns which event runtime jobs exist, what one pass of each does
and in which order, how the runtime stops, and the provider wiring behind the
capsule's ports (GitHub reads, the event classifier, Slack context and sockets).
It does not own:

- Sources, events, evaluations, the run queue, claims, activation, retention and
  the Slack adapter `SlackEventSource`:
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
- A failed ledger retention is logged, and the pass goes on to evaluation and
  its claim step unless the run's signal has aborted.
  `agent-runtime.orchestrator.test.ts`.
- Launch maintenance keeps renewing while an evaluation run is stalled.
  `agent-runtime.orchestrator.test.ts`.
- Stopping the runtime closes launch admission before it drains owned launches,
  and does not return while a committed claim is still being handed off.
  `agent-runtime.orchestrator.test.ts`.
- Stopping the Slack intake disconnects every socket and records the stop before
  it returns, and the intake opens no socket while its gate is off.
  `slack-intake.orchestrator.integration.test.ts`.

## Map

- `agent-runtime.orchestrator.ts`: the runtime and its jobs; admission-time
  execution settings (`resolveAgentExecutionConfig`).
- `slack-intake.orchestrator.ts`, `slack-socket.ts`: the Slack job and the
  Socket Mode client behind the capsule's adapter.
- `agent-event-classifier.orchestrator.ts`: the classifier port.
- `event-run-consumer.orchestrator.ts`: committed claims, local capacity,
  maintenance and shutdown of owned launches; it uses
  `event-run-launch.orchestrator.ts`, `event-run-resources.orchestrator.ts`,
  `event-workspace-init.orchestrator.ts`, `event-run-monitor.orchestrator.ts`,
  `event-child-rest.orchestrator.ts` and `event-run-recovery.orchestrator.ts`.
- `agent-management.orchestrator.ts`, `agent-authoring.orchestrator.ts`,
  `agent-sources.orchestrator.ts`, `agent-native-validation.ts`: saved
  automations, proposals, source discovery and native model checks.
