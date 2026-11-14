# Backend process

The files directly in this directory compose the application graph and own the
backend process: entry points, startup, shutdown and fatal errors. Bare file
names are in this directory; `src/` paths are from the repository root.

## Owns, and does not own

It owns composition, the HTTP and WebSocket server, startup order, the one
teardown plan both shutdown paths run, and fatal-error handling. It does not own
a job's lifecycle (`src/backend/services/job-runner.service.ts`), what a run
does when its signal aborts (the code that registers it), the fatal log record
(`src/backend/services/logger.service.ts`), startup recovery's drain
(`src/backend/orchestration/workspace-lifecycle/`) or the desktop app's stop and
kill budget (`electron/main/`).

## Public surface

`createApplication` and `disposeApplication` in `app-context.ts` (also exported
by `server.ts`); `createServer` in `server.ts`, whose `ServerInstance` starts
and stops one supplied graph. `createShutdownPlan` and `runShutdownPlan` have
two callers: `server.ts` and `disposeApplication`.

## Recurring work

- Register a loop that reads the database, sessions or the network with
  `jobRunner` (`src/backend/services/job-runner.service.ts`), not `setInterval`;
  `rg -n --glob '!*.test.ts' "register\(\{" src/backend` lists the jobs.
- The owner exposes a `start` and a `stop`. `run` honours its abort signal,
  because `stop()` waits for the run in flight without a bound, and a job never
  overlaps itself. `job-runner.service.test.ts`.
- A new job adds a `ShutdownJob` entry, or a step, in `application-shutdown.ts`,
  and is named in the `after` of each step that tears down what it uses.

## Invariants

- Server shutdown and `disposeApplication` stop the same components.
  `server.shutdown.test.ts`.
- Every job is signalled before the first step runs and a step waits only for
  the drains it names in `after`, so shutdown waits for the slowest drain, not
  their sum. `application-shutdown.test.ts`, `server.shutdown.test.ts`.
- Every job is named in the `after` of a step before the database step, which is
  last. `application-shutdown.test.ts`.
- A failed job drain or step is reported by name and blocks no other drain, no
  later step and no disconnect; server shutdown then rejects if a step failed.
  `application-shutdown.test.ts`, `server.shutdown.test.ts`.
- The first fatal error owns the only shutdown attempt, and the process exits
  with status 1 within 30 seconds even if cleanup never settles.
  `fatal-error-handlers.test.ts`.

The order of the steps is pinned by `application-shutdown.test.ts` and
`server.shutdown.test.ts`; read the comments in `createShutdownPlan` before
moving one. Why:
[shutdown is one plan](../../docs/decisions/2026-11-13-shutdown-is-one-plan-with-concurrent-job-drains.md).

## Map

- `app-context.ts`: `createApplication` (wires bridges, starts the event
  collector and the application update job) and `disposeApplication`.
- `server.ts`: startup order (bind, repairs, background work, readiness) and
  `performCleanup`, which adds transport and timer work to the plan through two
  hooks. `application-shutdown.ts`: the plan's jobs, steps and runner.
- `index.ts`, `shutdown-signal-handlers.ts`, `fatal-error-handlers.ts`: the
  standalone entry and its handlers; `electron-utility-entry.ts` and
  `electron-utility-backend.ts`: the desktop app's utility process.
- `migrate.ts`, `migrate-with-backup.ts`, `db.ts`: migrations, Prisma client.
