# Periodic-task capsule

Scheduled automations: saved instructions that start a fresh workspace on a
cadence. This capsule owns their schedule, the admission of each run and the
run's outcome. The [services guide](../AGENTS.md) covers capsule layout and
boundaries. Bare file names below are in this directory; paths that start with
`src/` are from the repository root.

The UI calls a `PeriodicTask` a scheduled automation, a `PeriodicTaskExecution`
a run, and the agent doing the work an agent. Stored identifiers, the
`periodicTask` tRPC router, the `periodic-task` session workflow and panel key,
and the `/projects/:slug/agents` routes keep their older names.

## Owns, and does not own

This capsule owns the `PeriodicTask` and `PeriodicTaskExecution` models: the
calendar (cadences, time of day in an IANA timezone, monthly anchors), the
`periodic-task-poll` job, reservation of a run with its frozen launch snapshot,
monitoring a run to `PR_CREATED`, `COMPLETED` or `FAILED`, the navigation
summary, and the periodic sections of a backup. It does not own:

- Launching the workspace and its `periodic-task` / **Agent** session: the
  `PERIODIC_TASK` policy of `launchWorkspace` in
  `src/backend/orchestration/workspace-lifecycle/`, reached through
  `src/backend/orchestration/background-action-dispatch.orchestrator.ts`.
- Wiring its timer-dispatch and workspace-status bridges, and the session facts
  behind a run's outcome: `configureDomainBridges` in
  `src/backend/orchestration/domain-bridges.orchestrator.ts`.
- Permissions of automation sessions, from the user's `automationPermissions`
  setting:
  `src/backend/services/session/service/config/session-workflow-permissions.ts`.
- The trust boundary of its procedures:
  `src/backend/trpc/periodic-task.trpc.ts`.
- The backup file, its profiles and workspace links:
  `src/backend/orchestration/data-backup/` and
  `src/shared/schemas/periodic-recovery.schema.ts`.
- The Automations page and the workspace's **Runs** panel:
  `src/client/features/agents/` and
  `src/client/features/workspace/periodic-task-panel.tsx`.
- Event-triggered automations: `src/backend/services/agent-definition/`.

The capsule has no capability to archive, stop or delete a workspace; a run
leaves its workspace for a human.

## Public surface

`index.ts`: `periodicTaskService` (definitions, history, navigation summary,
`start`/`stop` and `configure`), its `PeriodicTaskService` class, the bridge
types, `PeriodicTaskTimerEvent`, and the backup functions
`exportPeriodicConfigRecovery`, `readPeriodicConfigRecoveryIds`,
`restorePeriodicConfigRecovery`, `exportPeriodicHistoryRecovery`,
`planPeriodicHistoryRecovery` and `restorePeriodicHistoryRecovery`.

## Invariants

- A run is admitted only inside one transaction that rereads the task by ID and
  finds it enabled, due, in an active project and without a `RUNNING` run.
  `src/backend/orchestration/periodic-task-flow.integration.test.ts`,
  `resources/periodic-task.admission.integration.test.ts`,
  `resources/periodic-task.archived-project.integration.test.ts`.
- Admission advances the schedule from the slot that was due to the first slot
  of the same series still ahead, so missed slots run once, not once each.
  `resources/periodic-task.accessor.test.ts`,
  `resources/periodic-task.admission.integration.test.ts`.
- A run launches with the definition read by its admission transaction, which it
  stores as its launch snapshot.
  `src/backend/orchestration/periodic-task-flow.integration.test.ts`.
- An admitted run is never replayed: a failed launch marks it `FAILED` and keeps
  the advanced schedule, and a run with no linked workspace fails only at the
  reservation timeout. `service/periodic-task.service.test.ts`,
  `src/backend/orchestration/periodic-task-flow.integration.test.ts`.
- An edit that leaves the schedule unchanged keeps the pending slot, and
  enabling a task through `toggleEnabled` never runs an overdue slot at once.
  `resources/periodic-task.accessor.test.ts`.
- Backup import restores every task disabled and every `RUNNING` run as
  `FAILED`, and neither is reserved or dispatched afterwards.
  `service/periodic-recovery.integration.test.ts`,
  `src/backend/testing/periodic-config-backup.integration.test.ts`.
- Creating, editing and enabling a task require a trusted local client; deleting
  does not. `src/backend/trpc/periodic-task.router.test.ts`.
- The navigation summary finds each task's latest terminal run through the
  `PeriodicTaskExecution(periodicTaskId, startedAt, id)` index without sorting.
  `resources/periodic-task.navigation-summary.integration.test.ts`.

## Map

- `service/periodic-task.service.ts`: `PeriodicTaskService`, the poll job (due
  tasks, then running runs), dispatch through the timer bridge, linking the
  launched workspace, and each run's outcome.
- `service/periodic-task-timer-event.ts`: the `timer_due` event, correlated by
  its execution ID.
- `resources/periodic-task.accessor.ts`: definitions, the calendar arithmetic,
  `reserveExecutionAndMarkDispatched` and run history.
- `service/periodic-recovery.ts`, `resources/periodic-recovery.ts`: backup
  export and restore of tasks and run history.

## Decisions

- [Scheduled runs are reserved once and never replayed](../../../../docs/decisions/2026-11-13-scheduled-runs-are-reserved-once.md)
