# Project Research Summary

**Project:** In-Memory Project Snapshot Service
**Domain:** Real-time state synchronization / materialized view
**Researched:** 2026-02-11
**Confidence:** HIGH

## Executive Summary

The snapshot service is a classic read-side projection pattern that solves a very specific performance problem: three independent polling loops (sidebar at 2s, kanban at 15s, workspace list at 15s) that each perform full database queries and expensive git operations. The solution is an event-driven in-memory cache that maintains per-workspace materialized state, updated via domain event signals, with WebSocket push to clients and a safety-net reconciliation poll.

**The recommended approach is conservative and pattern-matching:** Build this as an infrastructure service (not a domain), reuse three existing patterns from the codebase (SessionDomainService for in-memory stores, WorkspaceActivityService for EventEmitter cross-domain signaling, ChatConnectionService for WebSocket broadcast), and require zero new dependencies. The entire stack is already in place: Node.js Map, EventEmitter, the `ws` library, Zod validation, and setInterval for reconciliation. The risk is not technical complexity but discipline: memory leaks from missed cleanup, event ordering races from concurrent writers, and WebSocket reconnection gaps.

**The critical mitigation is phased rollout:** Build the snapshot store first with proper cleanup contracts, wire events one domain at a time with field-level timestamps to prevent races, add WebSocket push but keep polling as fallback, and only remove polling after weeks of validated WebSocket operation. The reconciliation poll is not optional -- it's the safety net that catches missed events and provides observable drift metrics that prove event delivery reliability.

## Key Findings

### Recommended Stack

**Zero new dependencies required.** The existing codebase contains every building block: in-memory Map for storage, EventEmitter for pub/sub, `ws` library for WebSocket push, Zod for validation, setInterval for reconciliation. The architecture follows three proven patterns already in production in this codebase: SessionDomainService (in-memory store + publisher), WorkspaceActivityService (EventEmitter-based cross-domain signaling), and ChatConnectionService (WebSocket broadcast to connected clients).

**Core technologies:**
- **Node.js Map** for snapshot storage — keyed by workspaceId, holds ~500 bytes per entry, negligible memory footprint
- **EventEmitter** for cross-domain event bus — WorkspaceActivityService already uses this pattern for session lifecycle events
- **ws library** (^8.19.0) for WebSocket push — new `/snapshots` endpoint following existing `/chat`, `/terminal`, `/dev-logs` pattern
- **Zod** (^4.3.6) for schema validation — snapshot shape, delta events, WebSocket message frames
- **setInterval** for reconciliation polling — ~60s cadence, same pattern as SchedulerService

**Rejected technologies:** Redis (no multi-instance coordination needed), Socket.IO (already using raw ws), tRPC subscriptions (existing WebSocket infrastructure preferred), RxJS (massive overhead for simple pub/sub), Immer (snapshot objects are shallow). All rejections based on "this is a single-process Node.js server, don't add distributed system complexity."

### Expected Features

**Must have (table stakes) — v1:**
- In-memory store keyed by workspace ID, scoped per project
- Event-driven delta ingestion from all 6 domains (session, workspace, github, ratchet, terminal, run-script)
- Single read endpoint replacing `getProjectSummaryState` and `listWithKanbanState`
- WebSocket push on snapshot change, scoped to project ID
- Safety-net reconciliation poll (~60s) to catch missed events
- Snapshot version counter for client staleness detection
- Derived state computation (sidebar status, kanban column, flow phase) using existing pure functions
- Debug metadata per workspace (computedAt, lastEventSource) for observability

**Should have (competitive) — v1.x:**
- Coalesced/debounced push (100-200ms window) to prevent push storms
- Reconciliation drift logging to measure event delivery reliability
- Event source tagging (which event caused this snapshot update)
- Snapshot-level debug metadata (lastReconciliationAt, eventsSinceLastReconciliation)

**Defer (v2+):**
- Delta-only push (send only changed workspaces, not full snapshot) — optimization for scale we don't yet have
- Warm/cold project lifecycle (evict inactive projects from memory) — single-user app, memory is not a concern
- Subscription filtering by consumer type — full snapshot is ~10KB for 20 workspaces, negligible payload

### Architecture Approach

**Placement: Infrastructure service, not domain module.** The snapshot service does not own a business concept or have its own persistence. It aggregates data from all 6 domains into a read-side projection. It belongs in `src/backend/services/project-snapshot.service.ts` following the same pattern as `scheduler.service.ts` and `health.service.ts`. Domains never import from sibling domains (enforced by dependency-cruiser), and the snapshot service needs data from all domains, so it cannot be a domain.

**Major components:**
1. **Snapshot Store** (`project-snapshot.service.ts`) — holds in-memory Map of workspace snapshots per project, versioned entries with metadata, emits `snapshot_changed` events
2. **Event Collector** (`orchestration/snapshot-events.orchestrator.ts`) — wires domain events to snapshot updates, knows which mutations affect which fields, imports from domain barrels and calls snapshot store
3. **Reconciliation Poller** (inside `project-snapshot.service.ts`) — periodically recomputes full snapshot from DB + in-memory state, diffs against current snapshot, catches missed events
4. **WebSocket Handler** (`routers/websocket/snapshot.handler.ts`) — manages `/snapshot` WS connections scoped to projectId, sends full snapshot on connect, broadcasts deltas on change
5. **Query API** (modified `trpc/workspace.trpc.ts`) — existing `getProjectSummaryState` reads from snapshot store instead of computing live

**Integration pattern: Post-mutation event emission.** Domains add EventEmitter capability to key services that lack it (workspaceStateMachine, prSnapshotService, runScriptStateMachine). The event collector in the orchestration layer subscribes at startup. Domains emit events without knowing who listens — no coupling to snapshot service. This follows the existing WorkspaceActivityService pattern.

### Critical Pitfalls

1. **Snapshot store leaks memory on workspace lifecycle transitions** — In-memory Maps grow silently. The existing `workspaceActivityService` has a `clearWorkspace()` method but the archive orchestrator doesn't call it. The snapshot service will leak identically unless cleanup is wired at every lifecycle exit point (archive, delete, failed provisioning, server restart). **Prevention:** Wire snapshot cleanup into `workspace-archive.orchestrator.ts` as a hard requirement in Phase 1. Add periodic sweep that removes entries for non-active workspaces. Set hard upper bound (500 entries) with LRU eviction as safety net.

2. **Event ordering races between mutation sources** — Multiple sources update the same workspace snapshot concurrently: scheduler's PR sync, user-triggered manual refresh, ratchet service's CI monitoring, session lifecycle events. Without sequencing, a stale PR sync result can overwrite a newer manual refresh result. The existing `prSnapshotService.refreshWorkspace()` is already called from both scheduler and query service with no coordination. **Prevention:** Apply version counters per field cluster (prStateVersion, sessionStateVersion). Compare-and-swap: reject update if version is stale. Or use single-writer pattern per field cluster. For reconciliation poll, only apply results when `lastEventTimestamp < pollInitiatedAt`.

3. **Breaking domain boundaries via shared event types** — The temptation is to define shared event types that all domains emit, or have snapshot service import domain internals. Either violates the `no-cross-domain-imports` rule. Event-driven systems create semantic coupling through events -- if domain A changes event shape, snapshot service breaks. **Prevention:** Place snapshot service in `src/backend/services/` (infrastructure). Define snapshot bridge interfaces in each domain. Orchestration layer translates domain-native events into snapshot updates. Run `pnpm dependency-cruiser` in CI.

4. **WebSocket reconnection drops state updates** — When client WebSocket disconnects/reconnects (tab sleep, network blip, laptop close), events emitted during disconnection are lost. Client shows stale state until next poll. The existing `chatConnectionService.forwardToSession()` simply skips sessions with no open connection, no buffering or replay. If snapshot service replaces polling, this safety net disappears. **Prevention:** Do NOT remove client-side polling in the same phase as adding WebSocket push. Keep polling as fallback (30-60s cadence) while WebSocket is proven. On reconnect, client requests full snapshot using last-seen version. Include monotonic version in each push.

5. **Reconciliation poll and event-driven updates fight each other** — The safety-net reconciliation poll runs every ~60s and reads authoritative state from DB and external sources (GitHub API, git status). If not coordinated with event stream, the two sources oscillate: event sets state to X, poll (started before event) sets it back to old state, next event sets it to X again. UI flickers. The existing `getProjectSummaryState()` performs concurrent git stats and GitHub API calls that take 100-500ms -- a reconciliation poll doing similar work returns results stale relative to events that arrived during execution. **Prevention:** Stamp each snapshot field with `updatedAt` timestamps. Reconciliation poll only overwrites if data is newer than field's current `updatedAt`. Use dirty flag: poll skips fields updated within last 30s. Never run poll synchronously with event application -- use mutex or queue. Log when poll detects drift.

6. **Git stat operations block the event loop** — Current `getProjectSummaryState()` runs `gitOpsService.getWorkspaceGitStats()` for every workspace in parallel (limited to 3 concurrent). Each spawns child process (`git diff --stat`). With 20 workspaces, reconciliation spawns 20 git processes in batches of 3, taking 2-5 seconds total. If this runs in snapshot service reconciliation loop, it blocks event processing, causing events to queue and arrive in bursts. **Prevention:** Separate git stat collection into its own timer/worker that writes results asynchronously. Never run git operations in event processing path. Use longer cadence for git stats (30-60s) than other reconciliation. Cache stats aggressively for idle workspaces.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Snapshot Store Foundation
**Rationale:** The store is the foundation that all other components depend on. Must define cleanup contract, concurrency model, and field-level timestamps from day one. These are hard to retrofit later.

**Delivers:**
- In-memory snapshot store with Map<projectId, Map<workspaceId, WorkspaceSnapshot>>
- Version counter, computedAt, source metadata per entry
- Snapshot entry type matching `getProjectSummaryState()` return shape
- Basic CRUD: get, update, remove, clear
- EventEmitter for `snapshot_changed` events
- Workspace cleanup hooks (called on archive, delete, server restart)
- Field-level `updatedAt` timestamps to prevent race conditions
- Hard size limit (500 entries) with LRU eviction

**Addresses:**
- Pitfall 1 (memory leak) — cleanup contract defined
- Pitfall 2 (event races) — field-level timestamps and version counters
- Pitfall 3 (domain boundaries) — placed in services/, not domains/

**Tests:**
- Create snapshot -> archive workspace -> assert snapshot cleared
- Concurrent updates to same workspace preserve newest data
- Size limit enforces eviction of oldest entries

**Research flag:** Standard pattern. No additional research needed. Direct replication of SessionStoreRegistry pattern.

---

### Phase 2: Domain Event Emission
**Rationale:** Cannot wire event collector without domains emitting events. This phase adds EventEmitter capability to services that lack it. Small, isolated changes in each domain.

**Delivers:**
- `workspaceStateMachine extends EventEmitter`, emits on state transitions
- `prSnapshotService extends EventEmitter`, emits after PR refresh
- `runScriptStateMachine extends EventEmitter`, emits on status changes
- `workspaceActivityService` already emits (no change needed)
- Typed event interfaces for each domain

**Addresses:**
- Pitfall 3 (domain boundaries) — domains emit without knowing listeners

**Tests:**
- State machine transition emits event with correct payload
- PR refresh emits event with PR state and CI status
- Events are emitted after DB write completes, not before

**Research flag:** Standard pattern. No additional research needed. Follows WorkspaceActivityService precedent.

---

### Phase 3: Event Collector (Orchestration)
**Rationale:** Wires domain events to snapshot store. Cannot start until Phase 1 (store exists) and Phase 2 (events emitted). This is where cross-domain coordination lives.

**Delivers:**
- `orchestration/snapshot-events.orchestrator.ts`
- Subscribes to all domain events at startup
- Translates domain events into snapshot store updates
- Calls `snapshotService.updateWorkspace()` with appropriate patches
- Wired in `server.ts` after `configureDomainBridges()`

**Addresses:**
- Pitfall 3 (domain boundaries) — orchestration layer owns cross-domain wiring

**Tests:**
- Workspace state transition triggers snapshot update
- PR refresh triggers snapshot update with correct fields
- Session activity toggles update isWorking field
- Multiple rapid events to same workspace coalesce correctly

**Research flag:** Standard pattern. No additional research needed. Follows `domain-bridges.orchestrator.ts` precedent.

---

### Phase 4: Safety-Net Reconciliation
**Rationale:** Cannot validate event delivery reliability without reconciliation to measure drift. Must be built before WebSocket push is added, because reconciliation is the fallback that catches WebSocket gaps.

**Delivers:**
- Periodic reconciliation timer (~60s) inside `project-snapshot.service.ts`
- Queries all non-archived workspaces from DB
- Enriches with in-memory state (isWorking, pendingRequests, flowState)
- Diffs against current snapshot entries
- Updates store only for fields where data is newer than current `updatedAt`
- Logs drift corrections (what changed, why)
- Separate slower timer for git stats (~60s, lower priority than other fields)

**Addresses:**
- Pitfall 4 (WebSocket gaps) — reconciliation is the safety net
- Pitfall 5 (poll vs events) — field-level timestamps prevent oscillation
- Pitfall 6 (git stats blocking) — git stats on separate timer, skipped for idle workspaces

**Tests:**
- Reconciliation detects and corrects missed event
- Reconciliation does not overwrite event-driven update that arrived after poll started
- Git stats only run for workspaces with recent activity
- Drift metrics are logged correctly

**Research flag:** Phase needs deeper research. Current `getProjectSummaryState()` logic must be adapted to incremental diff-and-patch approach instead of full recomputation. Need to design drift detection strategy.

---

### Phase 5: WebSocket Handler
**Rationale:** Adds real-time push to clients. Depends on Phase 1 (store), Phase 3 (events populating store), Phase 4 (reconciliation as fallback). WebSocket is the performance win but not the reliability foundation.

**Delivers:**
- `routers/websocket/snapshot.handler.ts`
- `/snapshot?projectId=xxx` WebSocket endpoint
- Connection tracking scoped by projectId
- On connect: send full snapshot (all workspaces for project)
- On `snapshot_changed` event: broadcast delta to subscribed clients
- Reconnection protocol: client sends last-seen version, server resends full snapshot if stale
- Wired in `server.ts` upgrade handler alongside existing /chat, /terminal, /dev-logs

**Addresses:**
- Pitfall 4 (reconnection gaps) — send full snapshot on connect, version-based resync

**Tests:**
- Client connects -> receives full snapshot
- Workspace updated -> all connected clients receive delta
- Client disconnects during update -> reconnects -> receives current snapshot
- Multiple tabs viewing same project both receive updates

**Research flag:** Standard pattern. No additional research needed. Follows dev-logs.handler.ts precedent.

---

### Phase 6: Client Integration (Sidebar)
**Rationale:** Migrate one consumer at a time to validate WebSocket push end-to-end. Start with sidebar (highest poll frequency, simplest data). Keep polling as fallback during this phase.

**Delivers:**
- Frontend WebSocket connection to `/snapshot?projectId=xxx`
- React hook for snapshot subscription
- `queryClient.setQueryData()` integration to update React Query cache from WS messages
- Sidebar reads from snapshot cache (same query key as before)
- Polling interval increased from 2s to 30s (fallback, not primary)

**Addresses:**
- Pitfall 4 (WebSocket gaps) — polling remains as fallback
- Pitfall 7 (removing polling too early) — polling kept until proven

**Tests:**
- Sidebar shows workspace state updates within 200ms of mutation
- Sidebar remains correct after WebSocket reconnection
- Sidebar falls back to polling if WebSocket fails

**Research flag:** Standard pattern. No additional research needed. React Query `setQueryData` is well-documented.

---

### Phase 7: Client Integration (Kanban + Workspace List)
**Rationale:** Expand WebSocket push to remaining consumers. Same pattern as Phase 6. This phase proves the snapshot service scales to multiple consumers.

**Delivers:**
- Kanban board reads from snapshot cache
- Workspace list reads from snapshot cache
- Polling intervals increased to 60s (fallback only)

**Tests:**
- Kanban column updates within 200ms of workspace status change
- Workspace list updates when new workspace created
- All three consumers (sidebar, kanban, list) show consistent state

**Research flag:** No research needed. Replicates Phase 6 pattern.

---

### Phase 8: Migration Cleanup
**Rationale:** Only after weeks of validated WebSocket operation in development. Remove polling entirely, wire old tRPC endpoints to read from snapshot as thin wrappers.

**Delivers:**
- `getProjectSummaryState` reads from snapshot store (thin wrapper)
- `listWithKanbanState` reads from snapshot store
- Client polling removed entirely (refetchInterval deleted)
- Old query service code marked deprecated or removed

**Tests:**
- Old tRPC endpoints still work (backward compatibility for any remaining consumers)
- No client-side polling observed in network tab

**Research flag:** No research needed. Straightforward migration.

---

### Phase Ordering Rationale

- **Phase 1 must come first:** The store is the foundation. Cleanup contracts and concurrency model are hard to retrofit.
- **Phase 2 is independent of Phase 1:** Can be built in parallel. Small domain changes.
- **Phase 3 requires Phase 1 + 2:** Event collector needs both store and events.
- **Phase 4 is critical before Phase 5:** Reconciliation validates event delivery before WebSocket push is added. WebSocket push is performance, reconciliation is reliability.
- **Phase 5 requires Phase 1 + 3 + 4:** WebSocket handler needs store, events, and reconciliation as safety net.
- **Phase 6 is the first end-to-end validation:** One consumer proves the full pipeline works.
- **Phase 7 scales to all consumers:** Same pattern as Phase 6, lower risk.
- **Phase 8 is cleanup only after weeks of validation:** Do not remove polling until WebSocket is proven reliable.

**The key architectural decision:** Reconciliation poll is not optional, not a "nice to have," not deferrable to v2. It is the foundation that makes event-driven updates safe. Build reconciliation (Phase 4) before WebSocket push (Phase 5).

### Research Flags

**Phases likely needing deeper research during planning:**
- **Phase 4 (Safety-Net Reconciliation):** Current `getProjectSummaryState()` performs full recomputation. Need to design incremental diff-and-patch approach with field-level timestamps. Drift detection strategy needs validation. Git stats performance optimization needs profiling.

**Phases with standard patterns (skip research-phase):**
- **Phase 1:** Direct replication of SessionStoreRegistry pattern
- **Phase 2:** EventEmitter pattern already used by WorkspaceActivityService
- **Phase 3:** Orchestration layer wiring already established by domain-bridges.orchestrator.ts
- **Phase 5:** WebSocket handler pattern already used by dev-logs.handler.ts
- **Phase 6, 7:** React Query `setQueryData` is well-documented, standard integration
- **Phase 8:** Straightforward refactor, no novel patterns

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All technologies already in codebase. Zero new dependencies. Versions verified from package.json. |
| Features | HIGH | Table stakes directly derived from existing `getProjectSummaryState()` consumers. Clear differentiation between v1, v1.x, v2. |
| Architecture | HIGH | All patterns exist in codebase: SessionStoreRegistry (in-memory store), WorkspaceActivityService (EventEmitter), dev-logs.handler.ts (WebSocket), domain-bridges.orchestrator.ts (orchestration). File placement follows established conventions. |
| Pitfalls | HIGH | Pitfalls validated against existing code: WorkspaceActivityService has cleanup gap, prSnapshotService has race conditions, chatConnectionService has no reconnection protocol. All six critical pitfalls are real, observable patterns in the current codebase. |

**Overall confidence:** HIGH

The research is based on direct codebase analysis, not inference. Every pattern recommended is already in production in this codebase. Every technology is already in the dependency tree. Every pitfall maps to an existing gap or race condition in current code. The snapshot service is not introducing novel patterns -- it is composing three existing patterns (in-memory store, EventEmitter, WebSocket broadcast) that are proven to work independently.

### Gaps to Address

- **Reconciliation diff strategy:** Current `getProjectSummaryState()` recomputes everything from scratch. The reconciliation poll needs to diff against current snapshot and only update changed fields. This is a design problem, not a research problem -- the approach is clear (field-level timestamps, compare-and-swap), but the implementation requires careful planning in Phase 4.

- **Git stats performance tuning:** Current implementation runs git stats for all workspaces concurrently with `pLimit(3)`. Need to validate whether this is sufficient under load or if git stats need per-workspace caching based on session activity. This is a profiling exercise during Phase 4 implementation, not a research gap.

- **WebSocket reconnection edge cases:** The reconnection protocol is clear (send last-seen version, server resends full snapshot if stale), but edge cases need testing: what if client reconnects during a reconciliation poll? What if version counter wraps? What if client has version N but server restarted and rebuilt snapshot from DB with version 1? These are test scenarios to enumerate in Phase 5, not research gaps.

All three gaps are implementation planning concerns, not unknowns that would change the architecture. The approach is sound, the patterns are proven, the technology is in place. The execution risk is discipline (cleanup contracts, field-level timestamps, phased rollout), not technical uncertainty.

## Sources

### Primary (HIGH confidence)
- Direct codebase inspection of factory-factory-2 (all patterns and pitfalls validated against existing code)
- `src/backend/domains/session/session-domain.service.ts` — SessionStoreRegistry in-memory store pattern
- `src/backend/domains/session/store/session-publisher.ts` — WebSocket broadcast pattern
- `src/backend/domains/workspace/lifecycle/activity.service.ts` — EventEmitter cross-domain signaling, cleanup gap
- `src/backend/domains/workspace/query/workspace-query.service.ts` — current polling implementation being replaced
- `src/backend/routers/websocket/dev-logs.handler.ts` — WebSocket handler pattern, snapshot-on-connect
- `src/backend/services/scheduler.service.ts` — periodic reconciliation pattern
- `src/backend/orchestration/domain-bridges.orchestrator.ts` — bridge wiring pattern
- `/Users/martin/purplefish-ai/factory-factory-2/package.json` — all technology versions verified

### Secondary (MEDIUM confidence)
- [tRPC Subscriptions documentation](https://trpc.io/docs/server/subscriptions) — SSE recommended, `tracked()` for reconnection
- [Materialized View Pattern - Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/materialized-view) — CQRS read model patterns
- [Event Driven Architecture - 5 Pitfalls to Avoid (Wix Engineering)](https://medium.com/wix-engineering/event-driven-architecture-5-pitfalls-to-avoid-b3ebf885bdb1) — semantic coupling through events
- [WebSocket Reconnect: Strategies for Reliable Communication](https://apidog.com/blog/websocket-reconnect/) — reconnection protocol patterns
- [Common Memory Leak Patterns in Node.js](https://medium.com/@hemangibavasiya08/common-memory-leak-patterns-in-node-js-and-how-to-avoid-them-41c8944af604) — Map growth without cleanup
- [Mattermost WebSocket reconnection issue #30388](https://github.com/mattermost/mattermost/issues/30388) — real-world missed-event bug

### Tertiary (LOW confidence)
- [Cache Invalidation Strategies](https://leapcell.io/blog/cache-invalidation-strategies-time-based-vs-event-driven) — hybrid TTL + event-driven approach (general patterns, not specific to this domain)
- [HN discussion: WebSocket data architecture](https://news.ycombinator.com/item?id=26963959) — idempotent vs incremental updates tradeoffs (community discussion)

---
*Research completed: 2026-02-11*
*Ready for roadmap: yes*
