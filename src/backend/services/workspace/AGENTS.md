# Workspace capsule

Projects, workspaces and their side tables; worktrees; the workspace snapshot
store. The [services guide](../AGENTS.md) covers capsule layout and boundaries.
Bare file names below are under this directory; paths that start with `src/` are
from the repository root.

## Owns, and does not own

This capsule owns the Prisma models `src/backend/services/registry.ts` assigns
to `workspace`, creation validation and persistence for every creation source,
workspace status and the run-script row, worktree creation and removal,
generated names and conversation-summary rows, the accepted-branch gateway, and
the in-memory snapshot store with its private name and branch freshness. It does
not own:

- Launch, initialization, retry, rename serialization and the metadata inference
  queue: `src/backend/orchestration/workspace-lifecycle/`.
- Metadata inference itself (`generateWorkspaceMetadata`):
  `src/backend/services/session/`.
- Run-script and startup-script processes, which persist their state through
  `workspaceRunScriptService` here: `src/backend/services/run-script/`.
- Snapshot event collection and periodic reconciliation:
  `src/backend/orchestration/snapshots/`.
- PR monitoring that coordinates the `WorkspacePR*` tables:
  `src/backend/orchestration/pull-requests/`.
- The backup format: `src/backend/orchestration/data-backup/`.

## Public surface

Orchestration wires the session, GitHub and PR-snapshot capabilities declared in
`bridges.ts`.

## Invariants

- Metadata acceptance renames a workspace only while its stored generated-name
  marker still equals its current name, checked in the acceptance transaction,
  so a manual rename made during inference wins.
  `workspace-metadata.accessor.integration.test.ts`.
- Only the first accepted metadata sets the title and branch suggestions; later
  results replace only the summaries.
  `workspace-metadata.accessor.integration.test.ts`.
- A metadata write is rejected when another request has since been reserved or
  the workspace is archiving or archived.
  `workspace-metadata.accessor.integration.test.ts`.
- Every creation source inserts the workspace and its side-table rows only into
  an active project, in one guarded insert.
  `workspace-archived-project.integration.test.ts`.
- Outside the rows created with a workspace, each run-script, PR, monitoring,
  event, delivery and discovery table is written by one accessor file.
  `pnpm check:ownership` (`OWNED_SIDE_TABLES` in
  `scripts/check-single-writer.mjs`).
- Workspace reads flatten the run-script and selected PR rows back onto the
  workspace under their pre-split `runScript*` and `pr*` names.
  `workspace-run-script.accessor.test.ts`,
  `workspace-pr-collection.accessor.integration.test.ts`.
- The flat `prUrl`, `prNumber`, `prReviewState` and `prUpdatedAt` describe
  `selectedPr` while `prState`, `prCiStatus` and `prHasMergeConflict` describe
  `prSummary`, in workspace reads and in the backup export's copies of them (one
  projection), so consumers read those two objects instead of pairing flat
  fields. `workspace-pr-collection.accessor.integration.test.ts`,
  `src/backend/orchestration/data-backup/data-backup.service.test.ts`.
- Attachment, discovery and review-request lookups match a PR URL
  case-insensitively on host, owner and repository, so a casing variant reuses
  the existing association.
  `workspace-pr-collection.accessor.integration.test.ts`.
- A newly initialized worktree's columns and its cached run-script commands
  commit in one transaction.
  `workspace-initialized-worktree.integration.test.ts`.
- Startup recovery resets only STARTING and STOPPING run-script rows; RUNNING
  rows keep their pid. `workspace-run-script.accessor.test.ts`.
- An accepted branch reaches subscribers only after the branch update and the PR
  discovery reset commit together.
  `workspace-branch-acceptance.integration.test.ts`.
- A failing accepted-branch subscriber neither fails the rename nor stops later
  subscribers. `data.service.test.ts`.
- The snapshot store publishes an accepted name or branch only into an existing
  live entry; missing, removed, archiving and archived entries are never
  recreated. `workspace-snapshot-store.branches.test.ts`,
  `src/backend/orchestration/workspace-lifecycle/workspace-rename.orchestrator.test.ts`.
- An observation replaces an accepted name or branch only when its timestamp
  (from the database, or the observation time when it carries none) is strictly
  newer; only the serialized accepted writer may tie.
  `workspace-snapshot-store.names.test.ts`,
  `workspace-snapshot-store.branches.test.ts`.
- Worktree removal deletes a Git registration only when it matches the canonical
  worktree path, or the configured path once the base no longer resolves.
  `git-ops.symlink.integration.test.ts`.

## Map

- `resources/`: Prisma access. `workspace.accessor.ts` creates workspaces with
  their side-table rows and flattens reads; `workspace-metadata.accessor.ts`
  holds the generated-name marker and the conversation summary;
  `workspace-run-script.accessor.ts` the run-script row;
  `workspace-pr*.accessor.ts` the PR tables.
- `service/lifecycle/`: `creation.service.ts` (sources),
  `state-machine.service.ts` (status transitions), `data.service.ts` (reads and
  narrow writes; accepted branches go through `accepted-branch.ts`),
  `workspace-run-script.service.ts`,
  `archived-workspace-blob-retention.service.ts`.
- `service/snapshot/`: `workspace-snapshot-store.service.ts`, with
  `branch-freshness.ts` and `pr-projection-freshness.ts`.
- `service/state/`: pure derivations (flow state, init policy, pending request
  type).
- `service/query/`: list, summary, Git and notification queries;
  `project-management.service.ts` creates, updates and archives projects and
  runs the `FF_PROJECT_ROOT` location check.
- `service/worktree/`: `git-ops.service.ts`, `worktree-lifecycle.service.ts`,
  clone and orphaned-worktree cleanup; `project-root.ts`, whether a project path
  lies inside `FF_PROJECT_ROOT` and the real path to store;
  `project-repository-inspector.ts`, a repository's GitHub owner and name from
  `origin`, its default branch, and whether a path is a readable Git repository.

## Decisions

- [Side tables flatten under their original names](../../../../docs/decisions/2026-11-13-workspace-side-tables-flatten-under-original-names.md)
- [The run-script row caches config and persists runtime](../../../../docs/decisions/2026-11-13-run-script-row-caches-config-and-persists-runtime.md)
- [Worktree cleanup matches canonical paths only](../../../../docs/decisions/2026-11-13-worktree-cleanup-matches-canonical-paths-only.md)
