# PR URL Attachment Event Design

## Problem

`PRSnapshotService` has two successful PR URL persistence paths that can fail
to fetch a GitHub snapshot:

- `attachAndRefreshPR` writes `prUrl` with `recordSnapshot`.
- `attachDiscoveredPRAndRefresh` writes `prUrl` through the guarded discovery
  claim update.

Both paths return `fetch_failed` before `PR_SNAPSHOT_UPDATED` is emitted. The
database and cached kanban column therefore know about the attachment while
`WorkspaceSnapshotStore` and its WebSocket consumers retain the old `prUrl`
until reconciliation.

## Design

Add a dedicated `PR_URL_ATTACHED` domain event with a payload containing only
`workspaceId` and `prUrl`. Emit it after the URL write succeeds in the manual
path and after the guarded discovery attachment succeeds in the discovery
path, but only when the subsequent snapshot fetch returns no snapshot.

The event collector will subscribe to this event and immediately enqueue
`{ prUrl }` into `WorkspaceSnapshotStore` with source
`event:pr_url_attached`. The store already supports partial PR-field updates,
field-group timestamps, derived-state recomputation, and WebSocket
`SNAPSHOT_CHANGED` emission, so it needs no new API.

Keep `PR_SNAPSHOT_UPDATED` unchanged. It continues to mean that real snapshot
fields are available, avoiding placeholder PR number, state, CI, or review
values.

## Event Flow

1. The service confirms the workspace or discovery claim and persists the PR
   URL.
2. GitHub snapshot retrieval returns `null`.
3. The service emits `PR_URL_ATTACHED`.
4. The event collector immediately upserts only `prUrl`.
5. `WorkspaceSnapshotStore` recomputes derived fields and emits its existing
   snapshot change event to WebSocket consumers.
6. The service preserves the existing `{ success: false, reason:
   'fetch_failed' }` result and tRPC error behavior.

## Error and Ordering Rules

- Do not emit for a missing workspace.
- Do not emit when the discovery claim is stale and no URL was attached.
- Do not emit if the persistence operation throws.
- Emit only after persistence succeeds, so in-memory state never leads the
  database.
- Use the collector's immediate upsert option so the URL does not wait for the
  coalescing window.
- Preserve the full snapshot event's ratchet, closed-PR, and Linear completion
  side effects; the URL-only event performs none of them.

## Tests

- Service tests verify the manual and discovery `fetch_failed` paths emit
  exactly the URL-only event.
- Existing missing-workspace and stale-claim tests verify no attachment event
  is emitted.
- Event collector tests verify listener registration, teardown, and the
  immediate `{ prUrl }` store update with the dedicated source.
- The real-emitter lifecycle integration test includes the new listener so
  startup and shutdown cannot leak it.

No UI screenshot is required because this is a backend event propagation fix
with no visual or component changes.
