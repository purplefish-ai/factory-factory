# Add a background job

## Use when

You add recurring backend work: a loop that reads the database, sessions or the
network. Read "Recurring work" in the
[backend guide](../../src/backend/AGENTS.md) first; it holds the rules these
steps follow.

## Steps

`<job-name>` is the job's kebab-case name, unique among the jobs that
`rg -n --glob '!*.test.ts' "register\(\{" src/backend` lists; `<jobName>` is the
same in camel case. The owner is the service or orchestration module whose work
the job does; `<owner>` is its key in `ApplicationServices`. If the owner is
already started and stopped by the server, start and stop the job from its
`start` and `stop` instead of steps 4 and 5.

1. Add the cadence to `SERVICE_INTERVAL_MS` in
   `src/backend/services/constants.ts`: `<jobName>: <milliseconds>,`.
2. In the owner, register once, when it is constructed, with a runner it takes
   as a parameter defaulting to `jobRunner`
   (`src/backend/services/job-runner.service.ts`), so a test can pass
   `new JobRunner()`:
   `runner.register({ name: '<job-name>', intervalMs: SERVICE_INTERVAL_MS.<jobName>, run: (signal) => this.run(signal) })`.
   `src/backend/orchestration/workspace-lifecycle/workspace-metadata.orchestrator.ts`
   is the model.
3. Write `run(signal)` to check `signal.aborted` between units of work and
   return, and to pass `signal` to every call that accepts one. Expose
   `start()`, calling `runner.start('<job-name>')`, and `async stop()`, awaiting
   `runner.stop('<job-name>')`.
4. Add the owner to the application in `src/backend/app-context.ts`: its type to
   `ApplicationServices` and its instance to the `services` object built in
   `createDefaultApplicationDependencies`. Start it in `startBackgroundWork` in
   `src/backend/server.ts` (`services.<owner>.start();`). In
   `src/backend/server.test-helpers.ts`, copy the `periodicTaskService` entry,
   typed mocks included, as `<owner>`; an untyped `vi.fn()` fails typecheck with
   `TS2883`.
5. Add it to the shutdown plan in `src/backend/application-shutdown.ts`: the
   field `readonly <owner>: { stop(): Promise<void> };` in
   `ShutdownGraph.services`, the entry
   `{ name: '<job-name>', stop: () => services.<owner>.stop() }` in `jobs`, and
   `'<job-name>'` in the `after` of each step that tears down what it uses, or
   of the `job-runner` step if none does. Then these pass:

   ```sh
   pnpm test src/backend/application-shutdown.test.ts src/backend/server.shutdown.test.ts
   ```

6. Test the owner in `<file>.test.ts` beside it (`<file>` is the owner's file
   name without `.ts`), with `new JobRunner()` and `vi.useFakeTimers()`: after
   `start()` and `vi.advanceTimersByTimeAsync(SERVICE_INTERVAL_MS.<jobName>)`
   the run has happened, and a `stop()` during a run ends it at the next check.
   Remove the check from `run` once to see the second test fail. If you mock the
   logger, the runner logs `Job started` and `Job stopped` through it too.
7. Run `pnpm check:fix`, `pnpm typecheck`, `pnpm test <file>.test.ts` and
   `pnpm check`; all pass.

## Mistakes this prevents

- A `setInterval` loop: it overlaps itself and nothing stops it at shutdown.
- A job in `jobs` but in no step's `after`: `application-shutdown.test.ts` fails
  "waits on every job drain before the database disconnects".
- An owner missing from `server.test-helpers.ts`: `server.shutdown.test.ts`
  fails with `Cannot read properties of undefined (reading 'stop')`;
  `pnpm typecheck` does not catch it.
- A job never started, or left out of the plan: every check passes. Unstarted,
  the server log has no `Job started` line naming it; left out, only the
  `job-runner` backstop stops it, after steps that may tear down what it uses.
- A `run` that ignores its signal: `stop()` waits for the whole run, and
  shutdown waits with it.
