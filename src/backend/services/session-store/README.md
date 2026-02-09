# Session Store Modules

This folder contains the lower-level building blocks for session state management.

The orchestrator lives in `src/backend/domains/session/session-domain.service.ts` and composes these modules.

## Module Responsibilities

- `session-store.types.ts`
  - Core shared types for store shape and snapshot reasons.

- `session-store-registry.ts`
  - Owns in-memory store lifecycle (`getOrCreate`, clear, pending/queue lookups).

- `session-hydrator.ts`
  - Handles JSONL hydration from Claude history.
  - Deduplicates concurrent hydrations.
  - Protects against stale in-flight hydrate results via generation checks.

- `session-transcript.ts`
  - Transcript projection and mutation helpers.
  - History-to-transcript mapping.
  - Deterministic fallback IDs for history entries without UUID.
  - Claude event append/filter logic (including duplicate suppression).

- `session-queue.ts`
  - Queue and pending-interactive-request mutations.
  - Queue limit enforcement and clear helpers.

- `session-runtime-machine.ts`
  - Runtime transition semantics and delta emission hooks.

- `session-replay-builder.ts`
  - Pure builders for `session_snapshot` messages and `session_replay_batch` events.

- `session-publisher.ts`
  - WebSocket transport boundary.
  - Forwards snapshots/replay batches/deltas.
  - Emits parity trace logs for debugging.

- `session-process-exit.ts`
  - Process-exit policy:
    - clear ephemeral queue/pending/transcript state,
    - emit reset snapshot first,
    - then best-effort rehydrate and emit hydrated snapshot.

## Interplay

`sessionDomainService` is the single writer and coordinates modules in this order:

1. Resolve `SessionStore` via `SessionStoreRegistry`.
2. Apply mutations through queue/transcript/runtime helpers.
3. Build outgoing state via replay/snapshot builders (inside publisher).
4. Emit to clients through `SessionPublisher`.
5. Hydrate from JSONL through `SessionHydrator` when needed.
6. On process exit, delegate reset+rehydrate sequencing to `handleProcessExit`.

## Key Flows

- Subscribe/load:
  - hydrate (if needed) -> set runtime snapshot (without delta) -> send replay batch.

- Queue updates:
  - mutate queue -> send snapshot.

- Claude stream updates:
  - append/filter transcript event -> emit live delta (from caller path) -> snapshot on explicit calls.

- Process exit:
  - clear ephemeral state -> publish reset snapshot -> rehydrate from JSONL -> publish hydrated snapshot.

## Tests

- `session-domain.service.test.ts` (integration behavior contract)
- `session-runtime-machine.test.ts`
- `session-replay-builder.test.ts`
- `session-queue.test.ts`
- `session-transcript.test.ts`
