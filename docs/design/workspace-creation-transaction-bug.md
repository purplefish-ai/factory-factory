# Design Doc: Workspace Creation Fails with Nested Transaction Error

## Problem Statement

Creating new workspaces consistently fails with:

```
PrismaClientKnownRequestError: Invalid `prisma.workspace.updateMany()` invocation:
cannot start a transaction within a transaction
```

The error originates in `WorkspaceStateMachineService.transition()` → `workspaceAccessor.transitionWithCas()` → `prisma.workspace.updateMany()`, which is the very first database write attempted during workspace provisioning. As a result, no workspace can transition from `NEW` to `PROVISIONING`, making workspace creation fully broken.

## Background

### Database Setup

The app uses `@prisma/adapter-better-sqlite3` (Prisma 7.7.0), which wraps `better-sqlite3` — a **synchronous** SQLite library — in an async Promise-based API. Critically:

- There is **one** SQLite connection shared across all Prisma operations.
- `better-sqlite3` throws `"cannot start a transaction within a transaction"` if `BEGIN` is issued while a `BEGIN` is already active on that connection.

### The Adapter's Transaction Lifecycle

The `PrismaBetterSqlite3Adapter` uses an `async-mutex` `Mutex` to serialize interactive transactions:

```
startTransaction():
  1. await this.#mutex.acquire()    ← async: holds mutex until commit/rollback
  2. this.client.prepare("BEGIN").run()  ← issues BEGIN synchronously
  3. return BetterSQLite3Transaction(client, release)

BetterSQLite3Transaction.commit():
  this.#unlockParent()              ← releases mutex ONLY; does NOT issue COMMIT
  return Promise.resolve()

BetterSQLite3Transaction.rollback():
  this.#unlockParent()              ← releases mutex ONLY; does NOT issue ROLLBACK
  return Promise.resolve()
```

**Key design contract**: Prisma's client is responsible for issuing `COMMIT`/`ROLLBACK` SQL via `executeRaw()` _before_ calling `transaction.commit()`/`transaction.rollback()`. The adapter's `commit()`/`rollback()` only manages the mutex.

### The Only `$transaction` in the Codebase

The only production code that uses `prisma.$transaction()` is `agentSessionAccessor.acquireFixerSession()` (`src/backend/services/session/resources/agent-session.accessor.ts`):

```typescript
prisma.$transaction(async (tx) => {
  const existingSession = await tx.agentSession.findFirst({ ... });
  if (existingSession) return { outcome: 'existing', ... };
  const activeSessionCount = await tx.agentSession.count({ ... });
  if (activeSessionCount >= input.maxSessions) return { outcome: 'limit_reached' };
  const recentSession = await tx.agentSession.findFirst({ ... });
  const newSession = await tx.agentSession.create({ ... });
  return { outcome: 'created', ... };
})
```

This is called by the **ratchet service** (`fixer-session.service.ts`) which starts running immediately when the server boots and continues every 2 minutes thereafter.

## Hypotheses

### Hypothesis 1 (Most Likely): Prisma 7.7.0 Wraps `updateMany` in an Internal Transaction

Prisma 7 may internally call `adapter.startTransaction()` for certain write operations (including `updateMany`) to guarantee atomicity — even when the user did not explicitly call `$transaction()`. If this is the case, the flow would be:

1. Ratchet calls `acquireFixerSession()` → `prisma.$transaction()` → `adapter.startTransaction()` → **mutex acquired, `BEGIN` issued**.
2. The `$transaction` callback runs, making async DB calls (`await tx.findFirst(...)`, etc.).
3. At each `await`, the Node.js microtask queue can interleave other tasks.
4. Concurrently: `initializeWorkspaceWorktree()` → `startProvisioningOrLog()` → `transitionWithCas()` → `prisma.workspace.updateMany()`.
5. Prisma's internal machinery calls `adapter.startTransaction()` for `updateMany`.
6. `startTransaction()` tries `await this.#mutex.acquire()` — waits for the mutex.
7. Eventually the first transaction's `commit()` releases the mutex.
8. **BUG**: If Prisma released the mutex (`commit()`) WITHOUT first issuing `COMMIT` via `executeRaw()`, the SQLite connection is still in the `BEGIN` state.
9. The second `startTransaction()` acquires the mutex and issues `BEGIN` → **SQLite throws "cannot start a transaction within a transaction"**.

**Why it would be consistent**: If the ratchet runs immediately at startup and checks existing workspaces (even if there are no actions), it invokes `acquireFixerSession()` and opens a `$transaction`. If Prisma's client has a code path where `transaction.commit()` is called without first sending `COMMIT` (e.g., when the callback exits early via a `return` before any writes), the connection is left in a dirty state for all subsequent `startTransaction()` calls.

### Hypothesis 2: Direct Race Between Ratchet Transaction and Workspace Writes

Even without Prisma wrapping `updateMany` in a transaction, there may be a race condition specific to `@prisma/adapter-better-sqlite3` with async microtask interleaving:

1. Ratchet → `acquireFixerSession()` → `$transaction` → `BEGIN` (connection now in transaction).
2. `void initializeWorkspaceWorktree()` is started fire-and-forget.
3. `initializeWorkspaceWorktree` is the first item in the microtask queue.
4. Between yields of the ratchet's `$transaction` callback, `initializeWorkspaceWorktree` executes: `transitionWithCas()` → `adapter.executeRaw(UPDATE SQL)`.
5. The `executeRaw` runs the `UPDATE` directly on the shared connection (which has a live `BEGIN`). This **succeeds** in SQLite — writes inside a `BEGIN` work fine.
6. **BUT**: If Prisma's internal code for `updateMany` decides to wrap this in `startTransaction()` → `BEGIN` → **nested `BEGIN` → error**.

**Why this might be consistent**: The ratchet's first run (which happens immediately on server start) may cover many workspaces, causing `acquireFixerSession()` to be called rapidly in succession. If any workspace triggers the early-return path in `acquireFixerSession` (where `existingSession` is found), the `$transaction` lifecycle may not properly issue `COMMIT` before releasing the mutex.

### Hypothesis 3: `acquireFixerSession` Early Return Path Missing COMMIT

The `acquireFixerSession` callback can return early:

```typescript
if (existingSession) {
  return { outcome: 'existing', ... };
}
```

This returns without performing any writes (only reads). There may be a Prisma 7.7.0 bug where for **read-only transactions** (no writes occurred), the `COMMIT` is skipped before `transaction.commit()` is called. For a read-only interactive transaction, some Prisma optimizations might skip the actual `COMMIT` command (since nothing was written), but still release the mutex. If the `BEGIN` was issued but `COMMIT` is not sent, the connection stays in a transaction.

## Evidence

1. **Stack trace** confirms the error is at `transitionWithCas()` → `prisma.workspace.updateMany()` — the very first write in `initializeWorkspaceWorktree`.
2. **Single `$transaction` usage**: `acquireFixerSession` is the only production use of `prisma.$transaction()` and it runs at server startup via the ratchet.
3. **Adapter design**: `BetterSQLite3Transaction.commit()` does NOT issue `COMMIT` SQL — it only releases the mutex. This requires Prisma's client to be responsible for proper COMMIT sequencing.
4. **SQLite error**: "cannot start a transaction within a transaction" is a native SQLite error (`sqlite3.c:99345`), thrown when `BEGIN` is issued while already in a transaction.
5. **Mutex architecture**: The adapter uses `async-mutex` to serialize `startTransaction()` calls. A second `BEGIN` can only happen after the mutex is released. If `COMMIT`/`ROLLBACK` is not issued before mutex release, the connection is left dirty.

## Proposed Solutions

### Option A: Remove `$transaction` from `acquireFixerSession` (Recommended)

The `acquireFixerSession` logic (check-then-create) can be made safe without `$transaction` using atomic upsert patterns or by accepting the low probability of a duplicate session race:

```typescript
// Use upsert or findOrCreate pattern without explicit $transaction
// The worst case (two concurrent sessions created) is acceptable since
// ACTIVE_AGENT_SESSION_STATUSES checks prevent double dispatch.
```

Or restructure to use a single atomic `createIfNotExists` operation.

**Pros**: Eliminates the only `$transaction` in the codebase; avoids the mutex/SQLite race entirely.  
**Cons**: Need to verify the check-then-create logic remains race-safe.

### Option B: Replace `$transaction` with a Dedicated Mutex

Use an in-memory per-workspace mutex (already used by `fixerSessionService` for deduplication) to serialize `acquireFixerSession` calls, eliminating the need for a DB transaction:

```typescript
// Already exists in fixer-session.service.ts:
// "deduplicates concurrent acquisition by workspace/workflow"
// The in-memory per-workspace lock achieves the same serialization.
```

**Pros**: Keeps the atomicity guarantee without using Prisma `$transaction`.  
**Cons**: In-memory locks don't survive server restarts (but neither does the in-memory session state, so this is acceptable).

### Option C: Wrap `acquireFixerSession` in a try/catch with Explicit COMMIT/ROLLBACK

If the bug is that Prisma doesn't issue `COMMIT` on early-return read-only transactions, force a write (e.g., a no-op `UPDATE`) to ensure the transaction is "dirty" before returning, which forces Prisma to issue `COMMIT`:

```typescript
// Ensure COMMIT is always issued by adding a dummy/no-op write
// This is a workaround for the Prisma 7.7.0 + better-sqlite3 bug
```

**Pros**: Minimal change.  
**Cons**: Hacky; relies on Prisma internals; doesn't fix the underlying issue.

### Option D: Upgrade or Downgrade Prisma

If this is a Prisma 7.7.0 regression, upgrading to a patched version (or downgrading to a known-good version) may resolve it.

**Pros**: Simple if a patch is available.  
**Cons**: Unknown if a patch exists; may introduce other breaking changes.

## Recommended Investigation Steps

1. **Enable debug logging** for the better-sqlite3 adapter: `DEBUG=prisma:driver-adapter:better-sqlite3` to see exactly which SQL statements are issued during `acquireFixerSession`.
2. **Check if `COMMIT` is being sent**: Add a temporary log before `transaction.commit()` in the adapter source to verify `COMMIT` was issued via `executeRaw`.
3. **Reproduce in isolation**: Write a test that calls `acquireFixerSession` and `transitionWithCas` concurrently (similar to the integration test in `resources.integration.test.ts`).
4. **Test Option A**: Remove `$transaction` from `acquireFixerSession` and verify workspace creation works.

## Next Step

Based on the analysis, **Option A** (remove `$transaction` from `acquireFixerSession`) is the lowest-risk fix. The in-memory deduplication lock already in `fixerSessionService` provides sufficient protection against concurrent acquisitions at the service layer.
