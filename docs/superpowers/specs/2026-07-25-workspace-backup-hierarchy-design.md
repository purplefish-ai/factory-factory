# Workspace Backup Hierarchy Design

## Goal

Preserve `Workspace.parentWorkspaceId` through backup export and restore without making existing schema-version-4 backups invalid.

## Root Cause

The child-workspace feature added the nullable Prisma relation after the version-4 backup contract was established. The backup schema, explicit workspace export mapper, and explicit workspace import mapper were not extended with the new field. Zod therefore strips the relationship from imported payloads, and restored workspace rows receive the database default of `null`.

## Approaches Considered

1. Add a backward-compatible version-4 field and map it in both directions. Define `parentWorkspaceId` as a nullable field that defaults to `null` when absent, export it explicitly, and pass it to Prisma during restore. This is the recommended approach because it repairs new backups and still accepts version-4 backups made before the fix.
2. Make the new version-4 field required. This matches the current database shape but rejects older version-4 backup files that cannot contain the field.
3. Introduce schema version 5 and a multi-version importer. This gives the strongest version boundary but adds migration machinery that is unnecessary for one nullable, safely defaultable field.

## Data Flow

`exportedWorkspaceSchema` will expose `parentWorkspaceId` as `z.string().nullable().optional().default(null)`. The inferred parsed/export type therefore always contains `string | null`, while raw legacy payloads may omit it.

`DataBackupService.exportData` will copy `Workspace.parentWorkspaceId` into every exported workspace object. `importWorkspaces` will copy the parsed value into `tx.workspace.create`, preserving both parent IDs and explicit `null` values.

The existing import order remains unchanged. Export snapshots are ordered by workspace creation time, and child workspaces are created from an existing parent. The current database triggers also enforce a maximum hierarchy depth. Reordering or otherwise redesigning restore dependency handling is outside this bug's scope.

## Tests

- Extend the legacy workspace-schema test to prove an omitted `parentWorkspaceId` parses as `null`.
- Add a service round-trip test with one parent and one child. Export both, assert the child's payload contains the parent ID, import the exported value, and assert the child Prisma create input contains the same parent ID.
- Keep the existing null-parent workspace fixture so normal top-level workspace export remains covered.

The round-trip test catches removal from the schema, export mapper, or import mapper: any of those mutations either drops the exported value or prevents it from reaching the restore create call.

## Non-Goals

This change does not export workspace notifications, alter hierarchy depth rules, enable SQLite foreign keys, change backup schema versions, or modify UI behavior.
