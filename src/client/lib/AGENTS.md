# Client library

Most files here are dependency-free utilities that several features share; the
[features guide](../features/AGENTS.md) says what belongs here. This guide
covers the tRPC client's transport and the workspace query cache: the
`workspace.listForProject` and `workspace.get` React Query caches and their
reconciliation with the `/snapshots` stream. Bare file names below are in this
directory; paths that start with `src/` are from the repository root.

## Owns, and does not own

The workspace cache modules own the options, fetches and writes for those two
keys, the commit hook that reconciles HTTP responses with accepted snapshots,
live-list departures and their detail resets, the optimistic archive overlay and
the projection of a snapshot entry into a list row or a detail. They do not own:

- The snapshot socket and its message handling:
  `src/client/hooks/use-project-snapshot-sync.ts`, which applies messages
  through these modules.
- The summary and snapshot contracts: `src/shared/workspace-summary.ts`,
  `src/shared/workspace-snapshot.ts`,
  `src/shared/workspace-projection-fields.ts`.
- What the server streams: the snapshot store
  ([guide](../../backend/services/workspace/service/snapshot/AGENTS.md)) and
  `src/backend/routers/websocket/snapshots.handler.ts`.
- The archive command and its route and board callers:
  `src/client/features/workspace/use-workspace-archive-command.ts`.

## Public surface

Everything goes through `workspace-queries.ts`, directly or through the two hook
readers in `src/client/hooks/` that wrap its options:

- Readers: `useProjectWorkspaceQuery`
  (`src/client/hooks/use-project-workspace-query.ts`, observer-only
  `staleTime`), `useWorkspaceDetailQuery`
  (`src/client/hooks/use-workspace-detail-query.ts`, observer-only `enabled`,
  `refetchInterval` and `staleTime`), `fetchWorkspaceDetail` and
  `ensureWorkspaceDetail`.
- Writers: `setProjectWorkspaceList` for optimistic rows, `seedWorkspaceDetail`
  for creation seeds, `mergeWorkspaceDetailSnapshot` for stream merges.
- Key operations: `resetWorkspaceDetail`, `invalidateWorkspaceDetail`,
  `cancelWorkspaceDetail`, `refetchActiveWorkspaceDetail`,
  `getCachedWorkspaceDetails`, `cancelProjectWorkspaceList`.

Other tRPC invalidation, cancellation and cache reads may stay as they are,
because they reuse the options already installed. Query options carry their key
for `useQuery`; never pass it to a raw QueryClient fetch or write.

## Invariants

- `createTrpcClient` streams query results within a batch, so a completed query
  never waits for a slow sibling, and keeps mutations on ordinary batching for
  response headers and cookies, directly and through the authenticated proxy.
  `trpc.integration.test.ts`.
- Only `workspace-queries.ts` and `workspace-cache-reconciler.ts` use tRPC's
  option, fetch and write helpers or `getQueryKey` for either procedure;
  `factory/query-owner` in `.oxlintrc.json` rejects any other use outside tests.
  `pnpm lint`, `lint-rules/rules/query-owner.test.ts`.
- Before the current connection's full baseline, HTTP owns list membership and
  live fields; after it, HTTP only hydrates metadata that snapshots omit and
  cannot restore removed rows or replace live fields.
  `workspace-cache-reconciler.test.ts`,
  `src/client/hooks/workspace-cache-reconciler.integration.test.tsx`.
- Each HTTP response is recognised once, at its first commit, so an explicit
  write of the same object keeps default sharing.
  `workspace-cache-reconciler.test.ts`.
- HTTP that began under a retired connection never commits.
  `workspace-cache-reconciler.test.ts`.
- An archive's success is not undone by an overlapping archive's failure or by a
  later accepted base while the overlap is pending.
  `workspace-archive-operation.test.ts`,
  `src/client/features/workspace/use-workspace-archive-command.test.tsx`.
- A snapshot removal resets an existing detail once until a snapshot
  reintroduces the workspace, and a snapshot never creates a missing detail.
  `workspace-detail-snapshot-transitions.test.ts`,
  `src/client/hooks/workspace-detail-removal.integration.test.ts`.

An external proxy that buffers responses still holds streamed query results
until the whole batch finishes.

## Map

- `trpc.ts`: the tRPC client and its transport.
- `workspace-queries.ts`: the only entry point (its header says why).
- `workspace-cache-reconciler.ts`: one reconciler per QueryClient and project,
  scoped to a connection; the `structuralSharing` commit hook for list and
  detail, HTTP provenance and the archive overlay.
- `workspace-detail-snapshot-transitions.ts`: per hook mount departure history
  and exact detail resets.
- `snapshot-to-workspace.ts`: snapshot entry to list row and detail.
- `workspace-summary.ts`: optimistic list rows; `workspace-cache-helpers.ts`:
  creation seeds; `workspace-archive-operation.ts`: archive capture.

## Checks

`query-core-commit-contract.test.ts` pins the three React Query behaviours the
reconciler depends on: a function `structuralSharing` runs synchronously at the
success commit; a thrown `CancelledError({ revert: true })` commits nothing and
sets no error state; and the latest fetch or observer of a key installs the
options later refetches and writes use. A React Query upgrade that changes one
of them fails this test instead of silently disabling reconciliation.
