# Chat Session Store Unification Design

## Overview

This document defines a hard-cut refactor of chat state management to remove transcript divergence and reload/session-switch bugs.

The new model uses a single in-memory `SessionStore` per Claude DB session (`dbSessionId`) as the only mutable state writer for chat state.

Durable transcript truth remains Claude's own JSONL conversation history. We do **not** create or maintain a separate backend event log.

## Problem Statement

Current backend state is split across:

1. `message-state.service` (message state machine + replay/event store)
2. `message-queue.service` (queue data)
3. additional direct forwarding paths in `chat-event-forwarder.service`

This creates multi-writer behavior and split-brain risk under:

1. reload/reconnect
2. session switch
3. Claude process exit/restart
4. dispatch failures and requeue edges

## Goals

1. Single in-memory source of truth per session.
2. Single outbound path from backend state to WebSocket clients.
3. Deterministic subscribe/hydration behavior across running and non-running sessions.
4. Eliminate state divergence between transcript and queue state management.
5. Keep transcript durability delegated to Claude JSONL.

## Non-Goals

1. Backward compatibility with existing internal backend architecture.
2. Persisting queued-unsent messages across process/server restarts.
3. Replacing Claude JSONL as transcript authority.

## Core Decisions

1. Durable transcript authority is Claude JSONL.
2. Queue is ephemeral in-memory state owned by `SessionStore`.
3. If Claude process drops (or backend process restarts), queued-unsent messages may be dropped.
4. Backend does not introduce its own transcript/event durability layer.

## Target Architecture

```text
Frontend <-> WebSocket <-> ChatConnectionService <-> SessionStoreService <-> ClaudeSession
                                                         |
                                                         +-> Claude JSONL hydrate/reconcile
```

### Single Writer Rule

Only `SessionStoreService` may mutate session chat state:

1. transcript projection
2. queued messages
3. pending interactive request
4. runtime state used by chat UI

Other services may publish inputs to `SessionStoreService` but may not mutate chat state directly.

## SessionStore Domain Model

Each `SessionStore` instance (keyed by `dbSessionId`) contains:

1. `transcript: ChatMessage[]`
2. `queue: Map<messageId, QueuedMessage>` in FIFO order
3. `messageMeta: Map<messageId, MessageMeta>`
4. `pendingInteractiveRequest: PendingInteractiveRequest | null`
5. `runtime: SessionRuntimeState`
6. `initialized: boolean`
7. `lastHydratedAt: string | null`

`MessageMeta` tracks in-memory lifecycle for user messages not yet visible in Claude JSONL:

1. `QUEUED`
2. `DISPATCHING`
3. `DISPATCHED_AWAITING_CLAUDE`
4. terminal local failure/cancel states as needed for UI events

## Data Authority and Reconciliation Rules

1. A message becomes transcript-authoritative only when observed from Claude stream/result events or JSONL hydration.
2. `SessionStore` may optimistically show queued/dispatched local user entries in transcript projection for UX continuity.
3. When JSONL hydration occurs, transcript projection is rebuilt from JSONL and local ephemeral overlays are re-applied only where valid.
4. If process/server restart loses ephemeral overlays, only JSONL-backed transcript remains.

## Subscribe and Hydration Contract

`subscribe(sessionId, options)` behavior:

1. If store exists and is initialized:
- return current in-memory snapshot immediately.

2. If store missing/uninitialized:
- create store,
- load Claude session metadata,
- hydrate transcript from JSONL,
- initialize runtime state,
- return snapshot.

3. If Claude process is currently running:
- prefer existing in-memory store,
- do not replace live state with stale hydration.

4. Every subscribe returns one atomic snapshot payload suitable for full frontend replacement.

## Runtime Lifecycle Rules

1. `start`: runtime transitions to `starting`, then `ready/running` based on client events.
2. `idle` Claude event triggers dispatch of next queued item.
3. `stop/process exit`:
- runtime becomes stopped/exited,
- queued-unsent messages may be cleared,
- pending interactive request cleared,
- transcript remains recoverable from JSONL on next hydration.

### Explicit Queue Drop Policy

When Claude process exits unexpectedly or backend process is restarted, queued-unsent messages are not durable and may be dropped. This is acceptable and intentional.

## Inbound/Outbound Flow

## Inbound Commands (WebSocket -> SessionStore)

1. `load_session` -> `subscribe`
2. `queue_message` -> `enqueueMessage`
3. `remove_queued_message` -> `cancelQueuedMessage`
4. `question_response` / `permission_response` -> `resolveInteractiveRequest`
5. `start` / `stop` -> runtime orchestration commands

## Claude Event Inputs (Claude -> SessionStore)

Forwarder adapts Claude events into store inputs:

1. stream/message/result events
2. interactive request open/cancel/resolve
3. process lifecycle signals (`session_id`, `idle`, `exit`, `error`)

## Outbound Messages (SessionStore -> WebSocket)

Single outbound path:

1. `session_snapshot` for full hydration/replace
2. `session_delta` for incremental updates

All outbound chat state updates originate from `SessionStoreService` emission only.

## State Machines

## Queue State Machine (local ephemeral)

1. `QUEUED`
2. `DISPATCHING`
3. `DISPATCHED_AWAITING_CLAUDE`
4. `CANCELLED` or `FAILED_LOCAL` terminal states

Transitions:

1. `enqueue` -> `QUEUED`
2. dispatch begin -> `DISPATCHING`
3. send success -> `DISPATCHED_AWAITING_CLAUDE`
4. Claude confirms transcript progression -> local queue entry removed
5. cancel before dispatch -> `CANCELLED`
6. dispatch failure -> either retry back to `QUEUED` or `FAILED_LOCAL` then remove

## Runtime State Machine

Reuse current `SessionRuntimeState` semantics, but transitions are emitted only by store-owned logic.

## Service Responsibilities After Refactor

## SessionStoreService (new primary)

Responsible for:

1. store lifecycle (`getOrCreate`, `subscribe`, `teardown`)
2. hydration from Claude JSONL
3. queue operations and dispatch scheduling
4. transcript projection updates from Claude events
5. emitting snapshots/deltas to `ChatConnectionService`

## ChatEventForwarderService (adapter only)

Responsible for:

1. wiring ClaudeClient listeners
2. translating raw Claude events to `SessionStoreService` inputs

Not responsible for:

1. direct websocket forwarding of chat state
2. direct chat state mutation

## ChatMessageHandlersService

Responsible for:

1. parsing/routing inbound websocket messages
2. delegating message commands to `SessionStoreService`

Not responsible for:

1. owning queue data structures
2. direct message state transitions

## ChatTransportAdapterService

Either remove or reduce to a thin bridge if still needed. Any broadcast must be sourced from `SessionStoreService` outputs.

## API and Protocol Changes

Replace fragmented message set (`messages_snapshot`, `message_state_changed`, ad-hoc direct forwards) with:

1. `session_snapshot`:
- full transcript
- queue view
- runtime
- pending interactive request

2. `session_delta`:
- typed incremental update event(s)
- monotonic sequence within a connection stream (optional but recommended)

Frontend reducer becomes snapshot/delta driven, with no separate queue reconstruction logic.

## Migration Plan (One Go, No Backward Compatibility)

1. Implement `SessionStoreService` and domain types.
2. Move queue ownership and dispatch loop out of `message-queue.service` and into `SessionStoreService`.
3. Move message state transitions and snapshot building out of `message-state.service` into `SessionStoreService`.
4. Update `chat-event-forwarder.service` to publish only store inputs.
5. Update websocket handlers (`load_session`, `queue_message`, remove/cancel handlers) to call store commands.
6. Replace frontend websocket handling with `session_snapshot` + `session_delta` protocol.
7. Delete old services and dead paths:
- `src/backend/services/message-queue.service.ts`
- `src/backend/services/message-state.service.ts`
- related tests and references
8. Remove legacy docs that describe split services and store-then-forward event store behavior.

## Testing Strategy

The regression strategy should prioritize domain invariants and sequence correctness over single-endpoint behavior checks.

## Unit Tests (Invariant-First)

Build a focused `SessionStoreService` test suite that asserts invariants after each command/event application.

1. transcript authority invariant:
- hydration rebuilds transcript from Claude JSONL only.

2. queue consistency invariant:
- queue membership and queue-state metadata are always aligned.

3. single-writer invariant:
- only `SessionStoreService` emission path can produce outbound chat-state websocket payloads.

4. ordering invariant:
- transcript order is deterministic after hydrate + live Claude events.

5. exit policy invariant:
- process exit clears ephemeral queue and pending interactive request.
- transcript remains recoverable from JSONL.

## Integration Tests (End-to-End Backend Flow)

Use fake Claude client adapters and temporary JSONL fixtures.

1. `load_session` when non-running hydrates from JSONL and returns atomic snapshot.
2. `load_session` when running returns in-memory snapshot and does not overwrite with stale JSONL.
3. `queue_message` + idle dispatch + Claude result produces correct transcript and queue transitions.
4. session switch `A -> B -> A` has no transcript bleed or queue cross-contamination.
5. reconnect during active processing yields coherent snapshot/delta state.
6. multi-connection same session receives identical snapshot/delta stream.

## Failure Injection Tests

Explicitly simulate historical divergence/failure modes.

1. Claude process exits while queue non-empty -> queue is dropped, transcript remains correct.
2. backend restart -> restore transcript from JSONL only; no phantom queued messages.
3. dispatch failure before/after send boundary does not corrupt queue/transcript state.
4. duplicate or late Claude events do not create transcript corruption.
5. concurrent enqueue/load/idle/exit operations preserve invariants.

## WebSocket Contract Tests

Treat `session_snapshot` and `session_delta` as a hard protocol contract.

1. schema validation tests for outbound snapshot and delta payloads.
2. reducer contract tests: snapshot then deltas yields expected UI state.
3. reconnect/idempotency tests for repeated subscribe flows.

## Property/Model-Based Sequence Tests

Add at least one randomized sequence test (for example with `fast-check`) that generates mixed command/event streams:

1. commands: enqueue, cancel, load, start, stop, subscribe.
2. Claude events: stream, result, idle, interactive open/resolve, exit.

After each step, assert core invariants (authority, queue consistency, ordering, single writer).

## Merge Gate (Must-Pass Test Set)

Require the following before merge:

1. `SessionStoreService` invariant unit suite.
2. backend integration scenarios for running/non-running load, dispatch, reconnect, and session switch.
3. websocket protocol contract tests.
4. at least one model-based random sequence test.
5. updated frontend reducer tests for snapshot/delta protocol.

## Operational Considerations

1. Memory management:
- store instances should be evicted after inactivity timeout when no active viewers and no running process.

2. Logging:
- include per-session correlation IDs for command/event application.
- log snapshot source (`in-memory` vs `jsonl-hydrated`).

3. Observability:
- counters for hydrations, queue drops on process exit, and dispatch retries.

## Risks and Mitigations

1. Risk: introducing regressions during protocol cutover.
- Mitigation: land backend + frontend in same change and run end-to-end websocket tests.

2. Risk: users surprised by dropped queued messages after crash.
- Mitigation: explicit product behavior and UI text where appropriate.

3. Risk: stale in-memory store on long-running sessions.
- Mitigation: periodic reconcile hooks against Claude runtime/JSONL boundary events if needed.

## Success Criteria

1. No separate message queue state service remains.
2. No direct websocket chat state forwarding outside store-driven path.
3. Reload/session-switch behavior is deterministic from one snapshot source.
4. Transcript mismatches from dual-state divergence are eliminated.
5. Claude JSONL remains the sole durable transcript truth.

## Affected Code Areas

Primary backend files to refactor/remove:

1. `src/backend/services/message-queue.service.ts`
2. `src/backend/services/message-state.service.ts`
3. `src/backend/services/chat-message-handlers.service.ts`
4. `src/backend/services/chat-event-forwarder.service.ts`
5. `src/backend/services/chat-transport-adapter.service.ts`
6. `src/backend/services/chat-message-handlers/handlers/*.ts` for queue/load/session commands

Primary frontend files to refactor:

1. `src/components/chat/use-chat-websocket.ts`
2. `src/components/chat/use-chat-transport.ts`
3. `src/components/chat/reducer/index.ts`
4. `src/components/chat/reducer/slices/messages/*`

## Out of Scope Follow-Up

If future requirements need durable unsent queue recovery across crashes, add an explicit DB-backed "draft queue" model. This would remain distinct from transcript authority and would not change the Claude JSONL source-of-truth decision.
