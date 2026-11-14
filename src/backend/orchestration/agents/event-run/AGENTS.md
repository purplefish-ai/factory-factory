# Event run launch

The launch consumer that turns a claimed event run into a workspace and session,
with launch, resources, workspace initialisation, monitoring, child rest and
recovery. `src/backend/orchestration/agents/agent-runtime.orchestrator.ts`
creates it; the [parent guide](../AGENTS.md) covers its jobs. The migration of
the agent-runtime note adds this guide's rules, extending Owns and Map in place
and adding Invariants. Bare file names below are in this directory; paths that
start with `src/` are from the repository root.

## Owns, and does not own

This directory owns the order of one run's launch (resources, link,
initialisation, initial prompt), the in-process tasks that hold committed claims
(capacity, lease renewal, observation, shutdown), the rule for when a child
workspace is at rest, and the stop-and-prove step of recovery. It does not own:

- The run queue, claims, leases, the delivery ledger and recovery records:
  `src/backend/services/agent-definition/`.
- Workspaces and worktrees: `src/backend/services/workspace/`; setup scripts:
  `src/backend/services/run-script/`; sessions, the initial prompt dispatch and
  interruption: `src/backend/services/session/`.
- The shared initialization queue and worktree resolution:
  `src/backend/orchestration/workspace-lifecycle/workspace-init.orchestrator.ts`.

## Map

- `event-run-consumer.orchestrator.ts`: committed claims, capacity, lease
  renewal, observation adoption, recovery reservation and shutdown.
- `event-run-launch.orchestrator.ts`: one claim from resources to the initial
  prompt, and the disposition of a failed launch.
- `event-run-resources.orchestrator.ts`: freezes the execution settings and
  creates the workspace and session rows.
- `event-workspace-init.orchestrator.ts`: worktree, factory config and startup
  scripts, and cleanup of an unregistered worktree on failure.
- `event-run-monitor.orchestrator.ts`: one observation of a launched run: pull
  requests, child rest, interruption and settlement.
- `event-child-rest.orchestrator.ts`: whether a run's child workspaces are at
  rest.
- `event-run-recovery.orchestrator.ts`: inspection and the stop-and-prove step
  of Resolve, Retry and Abandon.
- Cross-directory tests, in `src/backend/testing/`: `event-launch`,
  `event-run-monitor`, `event-run-child-rest`, `event-run-pr-results`,
  `event-run-recovery` and `event-run-unproven-abandon`, each as
  `<name>.integration.test.ts`.
