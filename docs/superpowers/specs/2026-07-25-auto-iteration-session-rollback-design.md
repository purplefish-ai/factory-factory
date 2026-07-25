# Auto-Iteration Session Rollback Design

## Problem

The auto-iteration session bridge creates an `AgentSession` row before starting its ACP runtime.
If runtime startup fails, the bridge only calls `stopSession()`. Stopping a never-started session
does not delete or retire its `IDLE` row, so the row continues to count against the workspace
session limit.

Recycling has a second state problem. It stops the previous auto-iteration session before creating
and starting its replacement, but does not update the workspace pointer until the replacement
starts. A failure can therefore leave `autoIterationSessionId` pointing to the stopped predecessor.
The handoff failure path conditionally clears the replacement pointer, but still leaves the newly
created row.

The same incomplete cleanup exists in the bridge's initial `startSession()` flow: it creates a row,
attempts runtime startup, and only stops the runtime when startup rejects.

## Considered Approaches

1. Add a focused rollback helper in `domain-bridges.orchestrator.ts` and use it from both
   auto-iteration create-then-start flows. This is the chosen approach because the orchestration
   layer already owns the session runtime, data, domain-state, and workspace capabilities needed
   for the rollback. It fixes both affected bridge methods without changing capsule APIs.
2. Extract a new public rollback service into the session capsule and migrate the tRPC rollback to
   it. This could remove duplication, but it broadens a focused bug fix across the transport and
   service composition roots and would require a new public abstraction for only two callers.
3. Change `stopSession()` to delete every never-started `IDLE` session. This would make cleanup
   implicit, but `IDLE` is also the normal persisted state of valid user sessions, so the lifecycle
   service cannot safely infer that every stopped `IDLE` row is an orphan.

## Chosen Design

Add an orchestration-local helper for a session row created immediately before runtime startup. It
will:

1. stop the runtime best-effort;
2. clear in-memory session-domain state;
3. delete the created database row;
4. if deletion fails, best-effort update the row to `FAILED`, clear its process PID, and record a
   rollback reason in provider metadata;
5. preserve the original startup or handoff error even when cleanup fails.

This mirrors the existing `createAndStartSession` rollback contract in `session.trpc.ts`.

For `recycleSession()`, retain the predecessor session ID from the initial workspace snapshot.
Every failure after the predecessor has been stopped will conditionally clear the workspace pointer
for both IDs that can legitimately belong to the failed operation:

- the replacement ID, if it was created; and
- the predecessor ID, if the pointer was never advanced.

Conditional `clearSessionIfMatching()` calls preserve a concurrently installed newer session ID.
The replacement row is rolled back after either runtime startup or handoff persistence/send fails.
The stopped predecessor is best-effort retired to `COMPLETED` with its process PID cleared, which
preserves its history without leaving it active against the workspace session limit. If replacement
row creation itself fails, there is no row to delete, but the predecessor is still retired and its
pointer is cleared conditionally.

The bridge's initial `startSession()` flow uses the same created-session rollback helper on startup
failure. It does not manipulate the workspace pointer because it has not yet returned a session ID
to the auto-iteration service.

## Error Handling and Edge Cases

- Runtime stop, pointer clear, row delete, and failed-row repair are all best-effort cleanup; none
  may replace the original operational error.
- A failed row deletion falls back to `FAILED`, which no longer counts as an active `IDLE` or
  `RUNNING` workspace session.
- A failed fallback update is swallowed after the attempt, matching the existing tRPC rollback.
- A failed recycle retires its stopped predecessor to `COMPLETED`; it does not delete prior session
  history.
- A handoff failure after `setSession()` clears the replacement pointer.
- A `setSession()` rejection that leaves the predecessor pointer unchanged clears the predecessor.
- A concurrent newer pointer is not cleared because every pointer mutation is compare-and-clear.
- Successful recycle behavior and retention of previously completed session rows are unchanged.
- No UI, schema, migration, dependency, or public bridge interface changes are required.

## Testing

Add focused orchestration bridge tests that prove:

1. initial auto-iteration startup failure stops the runtime, clears domain state, and deletes the
   created row;
2. recycle startup failure rolls back the replacement row and clears the stopped predecessor
   pointer;
3. handoff send failure rolls back the replacement row and clears its pointer;
4. cleanup cannot clear a concurrently installed newer pointer;
5. the stopped predecessor is retired to `COMPLETED` on recycle failure;
6. delete failure marks the created row `FAILED` with cleared process state and rollback metadata;
7. cleanup failures preserve the original operational error.

Run the focused orchestration test through a verified red/green cycle, then run the repository's
required `typecheck`, formatter/linter, full test suite, and production build.
