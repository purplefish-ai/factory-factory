# Project-Scoped PR Status Sync Design

## Problem

`WorkspaceQueryService` is a singleton, but `syncAllPRStatuses(projectId)` protects its asynchronous lookup and background refresh batch with one boolean. A sync for one project therefore causes a concurrent request for another project to return `{ queued: 0 }` without querying that project's workspaces. The client triggers this race when the selected project changes while the previous project's fire-and-forget batch remains active.

The guard must continue to be acquired before the workspace lookup. Moving it later would reintroduce the same-project lookup race fixed in #1790.

## Considered Approaches

1. Track active project IDs in a `Set<string>`. This is the recommended approach because the state is membership-only, same-project checks remain constant-time, and different projects can proceed independently.
2. Track `projectId -> boolean` in a `Map`. This fixes the bug but stores a value that carries no information beyond key presence.
3. Track each project's background promise in a `Map`. This could support joining an existing batch, but the current API intentionally skips duplicate requests and returns queue counts immediately, so promise reuse adds behavior and complexity that the issue does not require.

## Design

Replace the singleton boolean with a set of project IDs whose sync is active. `syncAllPRStatuses(projectId)` checks only whether that project is present, adds the ID before its first await, and otherwise keeps its existing workspace lookup, PR filtering, concurrency limit, and fire-and-forget response behavior.

Every terminal path releases only the current project ID: immediately when no PR workspaces exist, in the background batch's `finally`, and in the synchronous lookup/setup error path. This allows Project B to query and queue refreshes while Project A is active, while duplicate calls for Project A still return `{ queued: 0 }`.

No tRPC, client, WebSocket, database, or UI changes are required.

## Error Handling and Edge Cases

- Duplicate calls for the same project remain suppressed while either its workspace lookup or background refresh batch is active.
- Calls for different projects proceed independently even when the first project's refresh promise is unresolved.
- A project with no PR workspaces releases its reservation before returning.
- A rejected workspace lookup releases its reservation before rethrowing.
- A completed or rejected background batch releases its project reservation through `finally` after existing logging runs.
- The global `p-limit` concurrency cap remains shared across projects to prevent resource exhaustion; only deduplication scope changes.

## Testing

Add a regression test that holds Project A's background refresh unresolved, then starts Project B and proves both projects are queried and both batches are queued. Keep the existing test that proves a duplicate call for the same project is skipped while lookup is pending.

Run the focused workspace query service tests through the red-green cycle, then run typecheck, formatting, the full Vitest suite, and the production build. Pre-existing failures must be distinguished from failures introduced by this change.
