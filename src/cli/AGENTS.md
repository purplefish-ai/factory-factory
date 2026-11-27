# CLI

The `ff` command, and the supervisor that a production `ff serve` runs around
the backend process. The invariants and map below cover the production update
path and `backup`; the other commands and helpers here have no guide yet. Bare
file names below are in this directory; paths that start with `src/` are from
the repository root.

## Owns, and does not own

This directory owns the commands registered in `index.ts` (`serve`,
`db:migrate`, `db:studio`, `backup`, `build`, `proxy`, `tailscale`, and the
bundled `claude` and `codex` CLIs). For a production `ff serve` it also owns
installing an application update, the update status while the backend is stopped
or replaced, recovering an interrupted update, and restarting the backend. It
does not own:

- When an update may start, and the admission gate that drains agent work first:
  the backend, described in the
  [application update guide](../backend/services/application-update/AGENTS.md).
- Which release is advertised: `src/backend/services/application-update/`.
- Running migrations, and the bounded `<database>-pre-migration-*.db` copies in
  `db-backups/` taken before pending migrations by `serve`, `db:migrate`,
  `proxy` and `tailscale` (a failed copy stops the migration unless
  `FF_ALLOW_MIGRATION_WITHOUT_BACKUP=1`): `src/backend/migrate-with-backup.ts`.
  The `backup-*` directories `ff backup` writes beside them are owned here.
- The IPC messages and update status schema:
  `src/shared/application-updates.ts`.

## Invariants

- Automatic installation is offered only for a production `ff serve` of the
  npm-global installation on macOS or Linux, when its package directory is not a
  symlink, its parent is writable and no other live server uses it; otherwise
  the backend receives manual guidance and no update journal is written.
  `application-update-installer.test.ts`, `supervised-serve-session.test.ts`.
- Preparation installs the requested version into a stage beside the package and
  checks its version, entrypoints and PTY module. `sqlite-runtime.mjs` queries
  an in-memory database from each distinct driver used by the app and its Prisma
  adapter. The running package stays active throughout preparation. A second
  update fails while the installation lock is held.
  `application-update-installer.test.ts`.
- The supervisor installs once per request and only after the backend sent
  `update-ready`; it stops the backend only after preparation succeeds, and
  snapshots the database only after the backend stops and before the package
  moves or migrations run. `application-update-supervisor.test.ts`,
  `supervised-serve-session.test.ts`.
- The update's `db:migrate` runs with `FF_ALLOW_MIGRATION_WITHOUT_BACKUP=1`
  because the supervisor's own snapshot is its backup; that snapshot failing
  still ends the update before the package moves. A failed `db:migrate` is
  logged in full; the failed update's message puts the line naming the error
  first and is capped at 4,096 characters, because the journal is persisted.
- A completed update keeps the snapshot only if the new package had pending
  migrations (a failed inspection counts as pending) and no new
  `<database>-pre-migration-*.db` appeared in `db-backups/` during `db:migrate`;
  wording decides nothing. It is hard-linked into `db-backups/` under that name,
  else beside the package as `.factory-factory-database-backup-<UTC>.db`, else
  left in the stage (`dispose({ keep })`); the error-level log says where.
  `supervised-serve-session.test.ts`, `application-update-installer.test.ts`.
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
  back. It runs before the installed SQLite probe so a broken replacement can
  still relaunch the previous package. `application-update-recovery.test.ts`,
  `bootstrap.test.ts`.
- `ff backup` builds `<name>.partial` (claimed with `mkdir`, so two runs never
  share one), writes the manifest last and renames it to `<name>` only when
  complete; a failed run removes it. `readBackup` refuses a `.partial` directory
  and one without a manifest, and the next default run reports leftover
  `.partial` directories in `db-backups/`. The destination is never inside
  `codex-accounts/`, compared by real path. Manual backups are never pruned.
  `backup.test.ts`.

## Map

- `bootstrap.mjs`: the `ff` binary; it ensures a usable Node before starting the
  CLI in a child process.
- `index.ts`: the commands. A production `serve` writes this server's running
  marker when the installation supports automatic updates, recovers an
  interrupted update (relaunching the restored CLI when it rolled back), then
  probes both SQLite consumers in memory before migrations and
  `runSupervisedServeSession`. The probe lives in `sqlite-runtime.mjs`;
  `native-binding-recovery.mjs` prints targeted npm cache removal only for a
  verified installation.
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
- `backup.ts`, `backup-manifest.ts`: `ff backup` writes one backup directory (an
  online SQLite snapshot in one step through
  `src/backend/lib/sqlite-snapshot.ts`, the key, `codex-accounts/` and a
  Zod-validated manifest that records the source database and data directory,
  which `DATABASE_PATH` and `BASE_DIR` choose separately), by default in
  `db-backups/` beside the database and never pruned. A restore reads one only
  through `readBackup`. `backup.test.ts`.
- `proxy-mode.ts`, `tailscale.ts`, `studio.ts`, `build-command.ts`, `claude.ts`
  and `codex.ts` register the other commands.
