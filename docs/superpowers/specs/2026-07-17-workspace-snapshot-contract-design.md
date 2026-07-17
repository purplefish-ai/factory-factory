# Shared Workspace Snapshot Contract Design

## Goal

Define the workspace snapshot WebSocket protocol once in `src/shared/`, consume it on both sides of the transport, and centralize typed client projections without changing snapshot behavior.

## Current Problem

The backend store owns `WorkspaceSnapshotEntry`, while `snapshot-to-sidebar.ts` manually recreates the entry and message schemas. That mirror has already drifted: workspace status accepts any string, flow and CI fields accept `null`, and timestamp groups accept arbitrary keys. Sidebar, kanban, and detail cache updates also repeat most field mappings. The hook compensates for missing cache types with `Record<string, unknown>`, object casts, and `as never` at every `setData` boundary.

## Shared Contract

Add `src/shared/workspace-snapshot.ts` as a framework-neutral Zod module. It will export exact schemas and inferred types for field groups, nested git/session/sidebar/status-reason data, `WorkspaceSnapshotEntry`, and the three server message variants. The entry will use the existing shared enum values and match backend guarantees: `WorkspaceStatus` is exact, flow phase and CI observation are non-null, and `fieldTimestamps` has all six named groups.

The store will import and re-export the shared entry and field-group types so existing backend consumers retain their public import path. The WebSocket handler will construct typed message objects and serialize them. Backend handler tests and new shared tests will parse representative producer messages through the same schemas used by the client.

## Typed Projections

Replace the two independent mapping modules with `src/client/lib/snapshot-to-workspace.ts`. A private common projection will convert snapshot identity and real-time fields once, including the `createdAt` string-to-`Date` conversion and `computedAt` to `snapshotComputedAt` rename. Typed public helpers will extend that base for:

- sidebar summary cache entries;
- kanban cache entries;
- workspace detail cache entries.

Cache shapes will come from `inferRouterOutputs<AppRouter>`, not local records. Existing cache objects will be spread before authoritative snapshot fields so DB-only properties survive deltas. New kanban entries will receive the minimum typed defaults required for fields absent from the protocol. `stateComputedAt` remains DB-backed and is preserved; `snapshotComputedAt` tracks transport recency.

The client hook will import message types and schema from the shared module, use tRPC-inferred cache aliases, and call the typed projection helpers. This removes `Record<string, unknown>`, `{ id }` casts, and `as never` while retaining the existing message order and cache membership rules.

## Behavior and Edge Cases

- `snapshot_full` remains authoritative for sidebar and kanban membership.
- Kanban excludes entries whose `kanbanColumn` is `null`.
- `snapshot_removed` clears summary, kanban, detail, and pending-request tracking.
- A later full baseline still invalidates all workspace caches to heal reconnect gaps and restore DB-only fields.
- Optimistic ratchet overrides are applied before any projection.
- Pending-request attention fires only for a delta transition from no pending request to a pending request; full hydration never fires it.
- Optional `reviewCount` retains the previous value when absent.
- Buffered backend deltas may omit `reviewCount` and remain valid.

## Cache Normalization Evaluation

Do not add a normalized fourth cache in this change. The three existing tRPC query results are consumer-facing cache contracts, and optimistic mutations already patch them directly. Adding a separate entity store would expand migration scope and create a second synchronization boundary. Shared contracts plus a single projection family remove the duplication targeted by this issue while preserving current query behavior.

## Testing

Shared schema tests will prove exact producer/client validation, including rejection of invalid enum literals, nullable derived fields, and incomplete timestamp groups. Projection tests will prove common-field parity and preservation of DB-only fields. Existing hook tests cover full/change/removal, reconnect healing, optimistic ratchet toggles, review counts, kanban membership, detail updates, and pending-request attention; fixtures will use valid shared-contract literals.

## Non-Goals

This change does not alter store merge/version semantics, add client-side stale-version rejection, change the WebSocket sequence, or redesign tRPC query return types.
