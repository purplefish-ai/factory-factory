# Feature Research: In-Memory Project Snapshot Service

**Domain:** In-memory materialized view / state aggregation for real-time UI
**Researched:** 2026-02-11
**Confidence:** HIGH

## Context

The snapshot service replaces three independent polling loops (sidebar at 2s, kanban at 15s, workspace list at 15s) that each hit the database and run git operations on every tick. The service maintains an in-memory projection of per-workspace state, updated via event-driven deltas, with WebSocket push to clients and a safety-net reconciliation poll.

Today's `WorkspaceQueryService.getProjectSummaryState()` does a full database query + concurrent git stat operations for every workspace on every 2-second sidebar poll. The `listWithKanbanState()` does the same for kanban. This is the core problem being solved.

## Feature Landscape

### Table Stakes (Users Expect These)

These are non-negotiable. Without them, the snapshot service does not solve the existing problem.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **In-memory store keyed by workspace ID** | Core data structure. Without it there is no snapshot. | LOW | `Map<workspaceId, WorkspaceSnapshot>` scoped per project. Already clear from `getProjectSummaryState` return shape. |
| **Event-driven delta ingestion** | Entire point is to avoid re-querying the DB on every poll. Must react to session start/stop, PR snapshot updates, ratchet state changes, workspace CRUD. | HIGH | Must wire into existing EventEmitter patterns (e.g., `workspaceActivityService` emits `workspace_active`/`workspace_idle`). Biggest implementation effort. |
| **Single read endpoint for all consumers** | Sidebar, kanban, and workspace list must all read from the same snapshot, not three separate queries. Eliminates redundant work. | MEDIUM | Replaces `getProjectSummaryState` and `listWithKanbanState` with a single `getSnapshot(projectId)`. Consumers derive their view client-side. |
| **WebSocket push on snapshot change** | Without push, clients still poll. The 2s sidebar poll is the main performance concern. Push eliminates it. | MEDIUM | Use tRPC subscriptions (SSE recommended by tRPC docs) or extend existing WebSocket infrastructure. Must scope to project ID so clients only receive updates for the project they are viewing. |
| **Safety-net reconciliation poll** | Events can be missed (process restart, race conditions, git operations completing outside event flow). A periodic full reconciliation (~60s) catches drift. | MEDIUM | Runs the existing `getProjectSummaryState` logic but writes into the snapshot store instead of returning directly. Diff against current snapshot to detect drift. |
| **Snapshot version counter** | Consumers must know if their local state is stale. Version monotonically increments on every mutation. Client can skip redundant re-renders if version unchanged. | LOW | Simple integer counter incremented on every store mutation. Included in every push event and read response. |
| **Derived state computation (sidebar status, kanban column, flow state)** | Today these are computed in the query service. The snapshot must include derived state, not raw data, because clients depend on `sidebarStatus`, `kanbanColumn`, `flowPhase`, `ciObservation`. | MEDIUM | Reuse existing pure functions: `deriveWorkspaceSidebarStatus()`, `computeKanbanColumn()`, `deriveWorkspaceFlowState()`. Must re-derive when inputs change. |
| **Full snapshot on client connect** | When a client first opens the app or switches projects, it needs the complete current state, not just deltas. | LOW | Standard pattern: on subscription init, send full snapshot. Subsequent messages are deltas. Aligned with tRPC `tracked()` event pattern. |
| **Project-scoped snapshots** | The app is project-scoped. Snapshot store must maintain separate state per project. Only the active project's snapshot needs to be warm. | LOW | `Map<projectId, ProjectSnapshot>`. Lazy initialization on first access. |

### Differentiators (Competitive Advantage)

Not required for the service to function, but improve debuggability, performance, or developer experience.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Debug metadata per workspace** | `{ version, computedAt, lastEventSource, lastEventType }` on each workspace entry. Invaluable for diagnosing "why does the sidebar show X?" without log diving. | LOW | Add metadata fields to snapshot entries. Populate on every mutation. Zero runtime cost beyond a few extra fields. |
| **Snapshot-level debug metadata** | `{ snapshotVersion, lastReconciliationAt, lastReconciliationDriftCount, eventsSinceLastReconciliation }` at the project snapshot level. Answers "is the snapshot service healthy?" | LOW | Aggregate counters. Expose via admin/debug endpoint. |
| **Delta-only push (not full snapshot)** | Instead of pushing the full project snapshot on every change, push only the workspace(s) that changed. Reduces WebSocket payload from O(n workspaces) to O(1) per event. | MEDIUM | Requires diffing before/after state for changed workspaces. Complexity is in correctly identifying which fields changed and serializing a minimal delta. |
| **Coalesced/debounced push** | When multiple events fire in quick succession (e.g., session starts + git status updates), coalesce into a single push after a short debounce window (~100-200ms). Prevents push storms. | LOW | `setTimeout` + dirty flag pattern. Standard debounce. Prevents N events from causing N WebSocket messages in rapid succession. |
| **Event source tagging** | Each snapshot mutation records which event caused it (e.g., `session_active`, `pr_snapshot_updated`, `reconciliation`, `workspace_created`). Enables debugging and metrics. | LOW | String tag on each mutation. Stored in debug metadata. |
| **Warm/cold project lifecycle** | Only maintain snapshot in memory for projects with active WebSocket subscribers. Evict after N minutes of no subscribers. Prevents memory waste for projects nobody is viewing. | MEDIUM | Reference counting on WebSocket subscriptions per project. Timer-based eviction. Reconstruct from DB on next access. |
| **Reconciliation drift logging** | When the safety-net reconciliation finds drift (snapshot differs from DB truth), log what drifted and why. Over time this reveals which event paths are unreliable. | LOW | Compare old vs new snapshot during reconciliation. Log any fields that changed with their before/after values. |
| **Optimistic client-side merge** | Client can apply mutations optimistically (e.g., "archive workspace" removes it from local list immediately) and reconcile when server push confirms. | LOW | This is a client-side concern, not server-side. Already partially implemented in `useWorkspaceListState` with optimistic creating/archiving states. Snapshot push just makes reconciliation cleaner. |
| **Subscription filtering by consumer type** | Allow clients to subscribe to only the fields they need (sidebar needs different fields than kanban). Reduces payload further. | HIGH | Over-engineering for current scale. Three consumers need slightly different views of the same data but the full snapshot is small (~20 workspaces * ~500 bytes = ~10KB). Not worth the complexity. |

### Anti-Features (Commonly Requested, Often Problematic)

Features to explicitly NOT build. These seem appealing but create problems in this context.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Persistent snapshot (write to DB/disk)** | "What if the server restarts? We lose the snapshot." | The snapshot is a derived cache, not a source of truth. DB + git are the source of truth. Persisting the cache adds write amplification, stale data risk, and migration burden. Rebuilding from DB on startup is fast (~100ms for 20 workspaces). | Rebuild from DB on startup. The reconciliation poll logic already does this. First access triggers a full build. |
| **Distributed pub/sub (Redis, NATS)** | "What about multiple server instances?" | This is a single-user desktop/local app. There is one server process. Adding Redis/NATS adds infrastructure, operational complexity, and latency for zero benefit. | In-process `EventEmitter` is correct for single-process Node.js. |
| **Event sourcing / event log persistence** | "Store all events for replay and auditing." | Massive over-engineering. The snapshot is a simple read cache. Events are ephemeral triggers, not a source of truth. The DB already has audit fields (`updatedAt`, `stateComputedAt`). Event log adds storage, complexity, and a new data model to maintain. | Debug metadata (source tagging, drift logging) provides sufficient observability without event persistence. |
| **Client-side snapshot computation** | "Just send raw data to the client and let it compute derived state." | Duplicates business logic (kanban column derivation, flow state, sidebar status) across server and client. Creates version skew risk. Existing pure functions are server-side TypeScript. | Keep derived state computation server-side in the snapshot service. Ship the computed result to clients. |
| **Per-field subscription granularity** | "Subscribe to just `isWorking` changes for workspace X." | The full workspace snapshot is ~500 bytes. The full project snapshot is ~10KB for 20 workspaces. Network cost is negligible. Per-field subscriptions add subscription management complexity, potential missed updates, and make the server track per-client subscription state. | Push the full changed workspace snapshot on each mutation. Client ignores fields it does not use. |
| **Cross-project snapshot** | "Show state of all projects at once in a dashboard." | Only one project is active at a time in the current UI. Building a cross-project view adds N-project memory footprint, N-project reconciliation, and a UI that does not exist. | When/if a cross-project dashboard is needed, aggregate lazily from per-project snapshots. |
| **Snapshot diffing with JSON Patch (RFC 6902)** | "Use standard JSON Patch for deltas." | Adds a dependency, requires both sides to understand the patch format, and is harder to debug than sending the full changed workspace object. JSON Patch makes sense for large documents; our workspace objects are tiny. | Send the full updated `WorkspaceSnapshot` for each changed workspace. Simple, debuggable, negligible overhead. |
| **Real-time git stats in snapshot** | "Update git stats on every file save." | Git stat operations (`git diff --stat`) take 50-200ms per workspace and shell out to git. Running these on every event would overwhelm the system. The current approach of including them in the reconciliation poll (every 60s) is correct. | Git stats update during reconciliation only. Events that indicate git activity (session idle, PR push) can trigger a targeted git stat refresh for that one workspace. |

## Feature Dependencies

```
[In-memory store]
    |
    +--requires--> [Project-scoped snapshots]
    |
    +--requires--> [Derived state computation]
    |                   |
    |                   +--uses--> deriveWorkspaceSidebarStatus()
    |                   +--uses--> computeKanbanColumn()
    |                   +--uses--> deriveWorkspaceFlowState()
    |
    +--enables--> [Single read endpoint]
    |                 |
    |                 +--enables--> [Full snapshot on client connect]
    |
    +--enables--> [Event-driven delta ingestion]
    |                 |
    |                 +--enables--> [WebSocket push on change]
    |                 |                 |
    |                 |                 +--enhances--> [Delta-only push]
    |                 |                 +--enhances--> [Coalesced/debounced push]
    |                 |
    |                 +--enhances--> [Event source tagging]
    |                 +--enhances--> [Debug metadata per workspace]
    |
    +--enables--> [Snapshot version counter]
    |
    +--enables--> [Safety-net reconciliation poll]
                      |
                      +--enhances--> [Reconciliation drift logging]
                      +--enhances--> [Snapshot-level debug metadata]

[WebSocket push on change] --enhances--> [Warm/cold project lifecycle]
```

### Dependency Notes

- **In-memory store requires Project-scoped snapshots:** The store must be scoped per project because `getProjectSummaryState` is project-scoped and clients view one project at a time.
- **In-memory store requires Derived state computation:** Consumers depend on derived fields (`sidebarStatus`, `kanbanColumn`, `flowPhase`). Without these, the snapshot does not replace existing endpoints.
- **Event-driven delta ingestion enables WebSocket push:** You cannot push changes if you do not know when changes happen. Events trigger both store mutation and push.
- **Safety-net reconciliation enables Drift logging:** Drift can only be detected during reconciliation when comparing snapshot state to DB truth.
- **Delta-only push enhances WebSocket push:** Optimization layer on top of basic push. Not needed initially (full snapshot push is fine at current scale).
- **Warm/cold lifecycle enhances WebSocket push:** Only relevant once push is implemented. Prevents memory waste from snapshots with no subscribers.

## MVP Definition

### Launch With (v1)

Minimum viable snapshot service. Replaces polling with event-driven updates.

- [ ] **In-memory store** (keyed by workspace ID, scoped per project) -- the foundation
- [ ] **Derived state computation** -- reuse existing pure functions so consumers get the same data shape
- [ ] **Snapshot version counter** -- enables clients to detect staleness and skip no-op re-renders
- [ ] **Single read endpoint** -- replaces `getProjectSummaryState` and `listWithKanbanState` with one call
- [ ] **Full snapshot on client connect** -- clients get current state immediately
- [ ] **Event-driven delta ingestion** (session activity, workspace CRUD, PR snapshot updates, ratchet state changes) -- the core event wiring
- [ ] **Safety-net reconciliation poll** (~60s) -- catches any missed events
- [ ] **Debug metadata per workspace** (`computedAt`, `lastEventSource`) -- cheap to add, expensive to add later

### Add After Validation (v1.x)

Features to add once the core snapshot service is working and event coverage is validated.

- [ ] **WebSocket push on change** -- add tRPC subscription or extend existing WS infrastructure; trigger: once polling is confirmed eliminated via read endpoint
- [ ] **Coalesced/debounced push** -- add once WebSocket push is live and push storms are observed
- [ ] **Reconciliation drift logging** -- add once reconciliation is running and drift patterns need to be understood
- [ ] **Snapshot-level debug metadata** -- add once the admin page needs a "snapshot health" view
- [ ] **Event source tagging** -- add alongside delta ingestion or shortly after

### Future Consideration (v2+)

Features to defer until the snapshot service is proven and scale concerns emerge.

- [ ] **Delta-only push** -- only needed if full-snapshot push proves too chatty (unlikely at <50 workspaces per project)
- [ ] **Warm/cold project lifecycle** -- only needed if memory usage becomes a concern (unlikely for single-user app)
- [ ] **Subscription filtering by consumer type** -- only needed if payload size becomes a concern (unlikely at current scale)
- [ ] **Optimistic client-side merge** -- client-side concern; partially exists already in `useWorkspaceListState`

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| In-memory store | HIGH | LOW | P1 |
| Project-scoped snapshots | HIGH | LOW | P1 |
| Derived state computation | HIGH | MEDIUM | P1 |
| Snapshot version counter | HIGH | LOW | P1 |
| Single read endpoint | HIGH | MEDIUM | P1 |
| Full snapshot on client connect | HIGH | LOW | P1 |
| Event-driven delta ingestion | HIGH | HIGH | P1 |
| Safety-net reconciliation poll | HIGH | MEDIUM | P1 |
| Debug metadata per workspace | MEDIUM | LOW | P1 |
| WebSocket push on change | HIGH | MEDIUM | P2 |
| Coalesced/debounced push | MEDIUM | LOW | P2 |
| Event source tagging | LOW | LOW | P2 |
| Reconciliation drift logging | MEDIUM | LOW | P2 |
| Snapshot-level debug metadata | LOW | LOW | P2 |
| Delta-only push | MEDIUM | MEDIUM | P3 |
| Warm/cold project lifecycle | LOW | MEDIUM | P3 |

**Priority key:**
- P1: Must have for launch -- the snapshot service is not functional without these
- P2: Should have, add when possible -- improves observability and performance
- P3: Nice to have, future consideration -- optimizations for scale we do not yet have

## Comparison: Current Architecture vs Snapshot Service

| Aspect | Current (Polling) | Snapshot Service |
|--------|-------------------|------------------|
| Sidebar data freshness | 2s poll interval | Near-instant via event + push |
| Kanban data freshness | 15s poll interval | Near-instant via event + push |
| DB queries per sidebar poll | 1 query + N git operations | 0 (reads from memory) |
| DB queries per kanban poll | 1 query + N computations | 0 (reads from memory) |
| Server CPU per sidebar tick | O(workspaces) per tick | O(1) per event |
| Network payload per update | Full response every 2s | Only changed workspaces |
| State consistency across views | Each view can show different state at same moment | All views read same snapshot |
| Debugging "why does UI show X?" | Check logs, reproduce timing | Inspect snapshot + debug metadata |

## Sources

- Codebase analysis: `WorkspaceQueryService.getProjectSummaryState()`, `KanbanStateService`, `WorkspaceActivityService`, `ChatConnectionService`, sidebar polling at 2s, kanban polling at 15s (HIGH confidence -- direct code inspection)
- [tRPC Subscriptions documentation](https://trpc.io/docs/server/subscriptions) -- SSE recommended, `tracked()` for reconnection (HIGH confidence -- official docs)
- [Materialized View Pattern](https://medium.com/design-microservices-architecture-with-patterns/materialized-view-pattern-f29ea249f8f8) -- CQRS read model patterns (MEDIUM confidence)
- [Guide to Projections and Read Models](https://event-driven.io/en/projections_and_read_models_in_event_driven_architecture/) -- idempotency, rebuild strategies (MEDIUM confidence)
- [Cache Invalidation Strategies](https://leapcell.io/blog/cache-invalidation-strategies-time-based-vs-event-driven) -- hybrid TTL + event-driven approach (MEDIUM confidence)
- [Synchronizing state with WebSockets and JSON Patch](https://cetra3.github.io/blog/synchronising-with-websocket/) -- delta sync patterns (MEDIUM confidence)
- [HN discussion: WebSocket data architecture](https://news.ycombinator.com/item?id=26963959) -- idempotent vs incremental updates tradeoffs (LOW confidence -- community discussion)
- [Snapshots in Event Sourcing](https://www.kurrent.io/blog/snapshots-in-event-sourcing) -- schema versioning for snapshots (MEDIUM confidence)

---
*Feature research for: In-memory project snapshot service*
*Researched: 2026-02-11*
