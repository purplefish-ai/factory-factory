# CLI

The `ff` command, and the supervisor that a production `ff serve` runs around
the backend process. The invariants and map below cover only the production
update path; the other commands and helpers here have no guide yet. Bare file
names below are in this directory; paths that start with `src/` are from the
repository root.

## Owns, and does not own

This directory owns the commands registered in `index.ts` (`serve`,
`db:migrate`, `db:studio`, `build`, `proxy`, `tailscale`, and the bundled
`claude` and `codex` CLIs). For a production `ff serve` it also owns installing
an application update, the update status while the backend is stopped or
replaced, recovering an interrupted update, and restarting the backend. It does
not own:

- When an update may start, and the admission gate that drains agent work first:
  the backend, described in the
  [application update guide](../backend/services/application-update/AGENTS.md).
- Which release is advertised: `src/backend/services/application-update/`.
- Running migrations, and the bounded `db-backups/` copy taken before pending
  migrations by `serve`, `db:migrate`, `proxy` and `tailscale`:
  `src/backend/migrate-with-backup.ts`.
- The IPC messages and update status schema:
  `src/shared/application-updates.ts`.

## Invariants

- Automatic installation is offered only for a production `ff serve` of the
  npm-global installation on macOS or Linux, when its package directory is not a
  symlink, its parent is writable and no other live server uses it; otherwise
  the backend receives manual guidance and no update journal is written.
  `application-update-installer.test.ts`, `supervised-serve-session.test.ts`.
- Preparation installs the requested version into a stage beside the package and
  checks its version, entrypoints and native modules without changing the
  running package, and fails while another update holds the installation lock.
  `application-update-installer.test.ts`.
- The supervisor installs once per request and only after the backend sent
  `update-ready`; it stops the backend only after preparation succeeds, and
  snapshots the database only after the backend stops and before the package
  moves or migrations run. `application-update-supervisor.test.ts`,
  `supervised-serve-session.test.ts`.
- The previous package and the database snapshot are kept until the replacement
  sends `update-backend-ready`; a failed migration or a failed replacement start
  restores both and restarts the previous package.
  `application-update-supervisor.test.ts`, `supervised-serve-session.test.ts`.
- The supervisor stops the backend, and later moves the package, only after the
  journal write before each step has succeeded; a failed write ends the update
  as failed. `application-update-supervisor.test.ts`.
- When the previous installation cannot be restored, the supervisor and startup
  recovery keep it and the recovery files rather than delete them.
  `application-update-supervisor.test.ts`,
  `application-update-recovery.test.ts`.
- Startup recovery refuses while the recorded updater or another server is
  alive, and restores the database snapshot before moving the previous package
  back. `application-update-recovery.test.ts`.

## Map

- `bootstrap.mjs`: the `ff` binary; it ensures a usable Node before starting
  `index.ts` in a child process.
- `index.ts`: the commands. A production `serve` writes this server's running
  marker when the installation supports automatic updates, recovers an
  interrupted update (relaunching the restored CLI when it rolled back), runs
  migrations, then calls `runSupervisedServeSession`.
- `supervised-serve-session.ts`: the production serve loop: IPC with the
  backend, journal writes, the database snapshot (through
  `src/backend/lib/sqlite-snapshot.ts`, which `db-backups/` also uses),
  `db:migrate` from the new package, and restarts. `ff serve --dev` goes
  straight to `serve-session.ts`.
- `application-update-supervisor.ts`: the update state machine.
- `application-update-installer.ts`: eligibility, staging, activation and
  rollback of the package. `hasOtherApplicationServers` reads the
  `.factory-factory-running-<pid>` markers beside the package, which `serve`
  writes for itself (`application-server-marker.ts`) and the supervised session
  writes for the CLI and for its backend.
- `application-update-recovery.ts`: the journal
  (`.factory-factory-update-state.json` beside the package) and startup
  recovery.
- `application-update-shutdown.ts`: stops the backend with SIGTERM and escalates
  to SIGKILL after two minutes.
- `proxy-mode.ts`, `tailscale.ts`, `studio.ts`, `build-command.ts`, `claude.ts`
  and `codex.ts` register the other commands.
