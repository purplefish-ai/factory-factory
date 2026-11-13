# Data backup orchestration

Backup export and import: the hand-written mapping between the database and the
versioned JSON format, the recovery manifest, and identity planning for older
backups. The [services guide](../../services/AGENTS.md) covers the capsules this
code reads and writes. Bare file names below are in this directory; paths that
start with `src/` are from the repository root.

## Owns, and does not own

This directory owns which columns are exported and under which keys, how each
model is restored, the recovery manifest's coverage of every Prisma model, and
the inert import report for restored processes and workflows. It does not own:

- The private SQLite connections both directions run in (export's readonly
  snapshot, import's one writer transaction):
  `src/backend/services/settings/resources/data-backup.accessor.ts` and
  `src/backend/services/settings/resources/backup-snapshot.ts`.
- The export schemas and their upgrade of older versions:
  `src/shared/schemas/export-data.schema.ts` and the recovery schemas beside it.
- Who may import: the trusted-local `admin.importData` procedure in
  `src/backend/trpc/admin.trpc.ts`. Import still refuses projects outside
  `FF_PROJECT_ROOT` (see Invariants).
- Where an imported project may live:
  `projectManagementService.checkProjectLocation` in
  `src/backend/services/workspace/`.
- Release of archived workspaces' attachments and setup logs after import: the
  `archived-workspace-blob-retention` job in
  `src/backend/orchestration/workspace-lifecycle/reconciliation.service.ts`.

## Public surface

`data-backup.service.ts` exports `dataBackupService`, composed in
`src/backend/app-context.ts`.

## Invariants

- Every scalar column of each model the recovery manifest does not mark
  `EXCLUDED` is either exported under a key the current export schema has, or
  excluded with a reason; `Gap:` reasons mark known omissions such as
  `WorkspaceRunScript.postRunCommand`. `data-backup-columns.test.ts`.
- Building the recovery manifest fails unless its coverage names exactly the
  Prisma models in `src/backend/services/registry.ts`.
  `data-backup-manifest.test.ts`.
- When `FF_PROJECT_ROOT` is set, import refuses the whole backup before any
  write if any project's repository or worktree base path lies outside it.
  `data-backup.project-root.test.ts`.

## Map

- `data-backup.service.ts`: export from one snapshot; import checks every
  project's location against `FF_PROJECT_ROOT` before its transaction, then
  writes in one transaction, model by model.
- `data-backup-manifest.ts`: the recovery manifest and its model coverage.
- `data-backup-pr-events.ts`: the flattened PR event and delivery format.
- `data-backup-legacy-collisions.ts`: identity reservation for older backups.
- `data-backup-runtime.ts`: restored runs and workflows are not resumed; the
  inert import report counts them.
- `data-backup-columns.test.ts`: the column classification. It checks the
  classification's shape, not the hand-written mapping that fills it.

## Decisions

- [Backups use private SQLite transactions](../../../../docs/decisions/2026-11-13-backups-use-private-sqlite-transactions.md)
