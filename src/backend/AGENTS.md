# Backend process

The files directly in this directory compose the application graph and own the
backend process: its entry points, startup, shutdown and fatal errors.
Subdirectories have their own guides, such as the
[services guide](services/AGENTS.md). Bare file names below are in this
directory; paths that start with `src/` are from the repository root.

## Owns, and does not own

This directory owns composition, the HTTP and WebSocket server, the order of
startup, the one teardown plan both shutdown paths run, and signal and
fatal-error handling. It does not own:

- The lifecycle of a recurring job (pacing, abort, drain):
  `src/backend/services/job-runner.service.ts`.
- What a job does when its signal aborts: the service or orchestrator that
  registers it.
- The fatal log record and its stderr fallback:
  `src/backend/services/logger.service.ts`.
- Startup recovery of workspaces and its drain:
  `src/backend/orchestration/workspace-lifecycle/`.
- The desktop app's stop and kill budget for this process: `electron/main/`
  (from the repository root).

## Public surface

`createApplication` and `disposeApplication` in `app-context.ts` (also exported
by `server.ts`), and `createServer` in `server.ts`, whose `ServerInstance`
starts and stops one supplied graph. `createShutdownPlan` and `runShutdownPlan`
have two callers: `server.ts` and `disposeApplication`.

## Invariants

- Server shutdown and `disposeApplication` run the same `createShutdownPlan` and
  stop the same components. `server.shutdown.test.ts`.
- Every job in the plan is signalled before the first step runs, and a step
  waits only for the job drains it names in `after`.
  `application-shutdown.test.ts`.
- Shutdown waits for the slowest job drain, not their sum.
  `server.shutdown.test.ts`.
- Every job in the plan is named in the `after` of a step before the database
  step, which is last. `application-shutdown.test.ts`.
- The agent-runtime step runs first; workspace metadata stops before transports
  close, transports before sessions, session dispatch right after sessions, and
  Codex accounts after sessions and after the launcher-option and Codex
  model-catalog drains. `application-shutdown.test.ts`,
  `server.shutdown.test.ts`.
- The event collector stops only after the PR poll drains, and the Git state
  service only after snapshot reconciliation drains. `server.shutdown.test.ts`.
- `jobRunner.stopAll()` runs after every other step but the database, so a job
  missing from the plan is still stopped before the disconnect.
  `application-shutdown.test.ts`, `server.shutdown.test.ts`.
- A failed job drain or step is reported by name and blocks no other drain, no
  later step and no disconnect; server shutdown then rejects if a step failed.
  `application-shutdown.test.ts`, `server.shutdown.test.ts`.
- A startup that shutdown interrupts starts no further background work and
  rejects once cleanup finishes. `server.upgrade.test.ts`.
- The first fatal error owns the only shutdown attempt, and the process exits
  with status 1 within 30 seconds even if cleanup never settles.
  `fatal-error-handlers.test.ts`.

## Adding a job or a step

A background job that uses sessions, caches or the database gets a `ShutdownJob`
entry in `application-shutdown.ts`, and each step that tears down something the
job uses names it in `after`.

## Map

- `app-context.ts`: `createDefaultApplicationDependencies`, `createApplication`
  (wires bridges, starts the event collector and the application update job) and
  `disposeApplication`.
- `server.ts`: the server, startup order (bind, startup repairs, background
  work, then readiness) and `performCleanup`, which adds its transport and timer
  work to the plan through two hooks.
- `application-shutdown.ts`: the plan's jobs, its ordered steps and the runner.
- `index.ts`: the standalone entry; `shutdown-signal-handlers.ts` and
  `fatal-error-handlers.ts`.
- `electron-utility-entry.ts`, `electron-utility-backend.ts`: the desktop app's
  utility process.
- `migrate.ts`, `migrate-with-backup.ts`, `db.ts`: migrations and the Prisma
  client.

## Decisions

- [Shutdown is one plan with concurrent job drains](../../docs/decisions/2026-11-13-shutdown-is-one-plan-with-concurrent-job-drains.md)
