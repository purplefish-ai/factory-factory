# Run-script capsule

The processes that run a project's own commands for a workspace: the setup and
startup scripts during initialization, the dev server (run script), its postRun
and cleanup commands. The [services guide](../AGENTS.md) covers capsule layout
and boundaries. Bare file names below are in `service/` (except `index.ts`);
paths that start with `src/` are from the repository root.

## Owns, and does not own

This capsule owns local process ownership (one `RunScriptExecution` per run
attempt), the persisted run-script status machine, startup-script execution and
its output, port allocation and tunnels for the dev server, and keeping the
cached commands in step with the worktree's `factory-factory.json`. It owns no
Prisma model. It does not own:

- The `WorkspaceRunScript` row, written through the workspace barrel's
  `workspaceRunScriptService`, and the workspace's status and setup output,
  written through the `RunScriptWorkspaceBridge` that orchestration wires:
  `src/backend/services/workspace/`.
- When the startup phases run during initialization:
  `src/backend/orchestration/workspace-lifecycle/`.
- The dev-logs and post-run-logs sockets:
  `src/backend/routers/websocket/log-stream.handler.ts`.
- The environment filter itself: `src/backend/lib/user-process-env.ts`.
- Terminals: `src/backend/services/terminal/`.

## Public surface

Callers import only `index.ts`.

## Invariants

- Setup, startup, run, postRun and cleanup processes start with
  `buildUserProcessEnv`, never with Factory Factory's own launcher variables.
  `run-script.service.process-lifecycle.test.ts`,
  `startup-script.service.test.ts`, `event-startup-script.test.ts`.
- Startup provisioning completes once the main shell exits, even while
  background descendants still hold its output pipes.
  `startup-script.integration.test.ts`.
- A postRun process starts only while its run script is still live: not exited,
  not being stopped and not waiting on the user cleanup command.
  `run-script.service.process-lifecycle.test.ts`,
  `run-script.service.ownership.test.ts`.
- A stop request revokes an attempt's permission to spawn, including
  continuations still reading the workspace or its configuration.
  `run-script-execution.test.ts`, `run-script.service.ownership.test.ts`.
- An old attempt's stop never reconciles or removes a replacement admitted while
  its cleanup command ran. `run-script.service.ownership.test.ts`.
- Output subscribers survive stops, exits and restarts until they unsubscribe or
  the workspace is archived or deleted. `run-script.service.output.test.ts`,
  `run-script.service.process-lifecycle.test.ts`,
  `run-script-output-buffer.test.ts`.

## Map

- `run-script.service.ts`: `RunScriptService`, the per-workspace registry of
  current and pending executions, admission, stop and shutdown cleanup, and the
  run and postRun output buffers (`run-script-output-buffer.ts`).
- `run-script-execution.ts`: one attempt's main process, postRun process, stop
  intent, exit observation and tunnel lease.
- `run-script-state-machine.service.ts`: persisted status transitions and
  `verifyRunning`, which probes the stored pid.
- `run-script-process-utils.ts`: shell spawning for run, postRun and cleanup.
- `startup-script.service.ts`: workspace setup and startup scripts;
  `event-startup-script.ts`: the event-workspace variant.
- `run-script-config-persistence.service.ts`: writes `factory-factory.json`,
  rewrites the cached commands when it is saved or refreshed, and reads the
  file's commands before a script starts or stops; `factory-config.service.ts`
  reads and validates the file.
- `port-allocation.service.ts`, `run-script-proxy.service.ts`: ports and
  tunnels.
- `bridges.ts`: the workspace capabilities orchestration injects.

## Decisions

- [Run-script processes have one local owner](../../../../docs/decisions/2026-11-13-run-script-processes-have-one-local-owner.md)
- [The run-script row caches config and persists runtime](../../../../docs/decisions/2026-11-13-run-script-row-caches-config-and-persists-runtime.md)
- [User processes omit the launcher environment](../../../../docs/decisions/2026-11-13-user-processes-omit-the-launcher-environment.md)
- [Startup provisioning follows the shell's exit](../../../../docs/decisions/2026-11-13-startup-provisioning-follows-the-shell-exit.md)
