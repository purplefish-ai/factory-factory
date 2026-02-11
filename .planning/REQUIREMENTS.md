# Requirements: Project Snapshot Service

**Defined:** 2026-02-11
**Core Value:** Every domain object has exactly one owner module, and any operation touching that domain flows through a single, traceable path.

## v1.1 Requirements

Requirements for milestone v1.1. Each maps to roadmap phases.

### Snapshot Store

- [x] **STORE-01**: In-memory store holds per-workspace snapshot entries keyed by workspaceId, scoped per project
- [x] **STORE-02**: Each snapshot entry includes monotonically increasing version counter for staleness detection
- [x] **STORE-03**: Each snapshot entry includes debug metadata: computedAt timestamp, source of last update
- [x] **STORE-04**: Snapshot entries are removed when workspace is archived or deleted (no memory leaks)
- [x] **STORE-05**: Snapshot entries include derived state: sidebarStatus, kanbanColumn, flowPhase, ciObservation
- [x] **STORE-06**: Derived state recomputes when underlying fields change, using existing pure functions

### Event System

- [x] **EVNT-01**: Workspace domain emits EventEmitter events on state machine transitions (READY, ARCHIVED, FAILED, etc.)
- [x] **EVNT-02**: GitHub domain emits events when PR snapshot is refreshed (prState, prCiStatus changes)
- [x] **EVNT-03**: Ratchet domain emits events on ratchet state transitions
- [x] **EVNT-04**: Run-script domain emits events on run-script status changes
- [x] **EVNT-05**: Session domain activity events (workspace_active, workspace_idle) flow to snapshot store via existing WorkspaceActivityService
- [x] **EVNT-06**: Event collector orchestrator in src/backend/orchestration/ wires all domain events to snapshot store updates
- [x] **EVNT-07**: Event collector uses bridge pattern — domains emit events without knowing about snapshot service
- [x] **EVNT-08**: Rapid-fire events within 100-200ms window are coalesced into a single snapshot update and push

### Reconciliation

- [x] **RCNL-01**: Safety-net reconciliation poll runs on ~60s cadence, recomputing snapshots from authoritative DB + git sources
- [x] **RCNL-02**: Git stats (diff size, uncommitted changes) are computed only during reconciliation, not on event-driven updates
- [x] **RCNL-03**: Reconciliation only overwrites fields whose data is newer than the current snapshot entry's timestamp
- [x] **RCNL-04**: Reconciliation logs drift — fields that differ between event-driven state and authoritative sources

### WebSocket Transport

- [x] **WSKT-01**: New /snapshots WebSocket endpoint follows existing ws handler pattern (alongside /chat, /terminal, /dev-logs)
- [x] **WSKT-02**: On client connect, server sends full project snapshot (all workspace entries)
- [x] **WSKT-03**: On snapshot change, server pushes per-workspace delta (only changed workspace entries) to subscribed clients
- [x] **WSKT-04**: WebSocket subscriptions are scoped to project ID — clients only receive updates for their viewed project
- [x] **WSKT-05**: On client reconnect, server sends full snapshot to recover from any missed events during disconnection

### Client Integration

- [x] **CLNT-01**: Sidebar reads workspace state from WebSocket-driven snapshot instead of 2s tRPC poll
- [x] **CLNT-02**: Kanban board reads workspace state from WebSocket-driven snapshot instead of 15s tRPC poll
- [x] **CLNT-03**: Workspace list reads workspace state from WebSocket-driven snapshot instead of 15s tRPC poll
- [x] **CLNT-04**: React Query cache updated via queryClient.setQueryData from WebSocket message handlers
- [x] **CLNT-05**: Polling fallback remains at relaxed cadence (30-60s) as safety net during migration period

### Architecture Compliance

- [x] **ARCH-01**: Snapshot service lives in src/backend/services/ as infrastructure service (not a domain module)
- [x] **ARCH-02**: Snapshot service has zero imports from @/backend/domains/ — all domain data arrives via bridge interfaces or event subscriptions wired in orchestration layer
- [x] **ARCH-03**: dependency-cruiser passes with no new violations after all changes
- [x] **ARCH-04**: Existing tests continue to pass (no regressions)

## Future Requirements

Deferred to future milestones. Tracked but not in current roadmap.

### Optimization

- **OPT-01**: Delta-only push — send only changed fields per workspace, not full workspace snapshot
- **OPT-02**: Warm/cold project lifecycle — evict snapshots for projects with no active subscribers
- **OPT-03**: Subscription filtering by consumer type — clients subscribe to only fields they need

### Cleanup

- **CLN-01**: Remove polling fallback entirely after WebSocket push proven reliable (2+ weeks)
- **CLN-02**: Remove old getProjectSummaryState and listWithKanbanState code paths

## Out of Scope

| Feature | Reason |
|---------|--------|
| Persistent snapshot (write to DB/disk) | Snapshot is derived cache; DB + git are source of truth. Rebuild on restart is fast (~100ms). |
| Distributed pub/sub (Redis, NATS) | Single-process Node.js server. No multi-instance coordination needed. |
| Event sourcing / event log persistence | Massive over-engineering. Debug metadata provides sufficient observability. |
| Client-side snapshot computation | Duplicates server-side business logic. Keep derived state computation on server. |
| Cross-project snapshot / dashboard | Only one project is active at a time in current UI. |
| Real-time git stats on every event | Git stat operations are 50-200ms each. Only compute during reconciliation. |
| Workspace detail/session-specific polling changes | Different lifecycle and granularity. Stays as-is. |
| New UI surfaces | No dashboard or new views — just rewire existing sidebar, kanban, workspace list. |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| STORE-01 | Phase 11 | Done |
| STORE-02 | Phase 11 | Done |
| STORE-03 | Phase 11 | Done |
| STORE-04 | Phase 11 | Done |
| STORE-05 | Phase 11 | Done |
| STORE-06 | Phase 11 | Done |
| EVNT-01 | Phase 12 | Done |
| EVNT-02 | Phase 12 | Done |
| EVNT-03 | Phase 12 | Done |
| EVNT-04 | Phase 12 | Done |
| EVNT-05 | Phase 12 | Done |
| EVNT-06 | Phase 13 | Done |
| EVNT-07 | Phase 13 | Done |
| EVNT-08 | Phase 13 | Done |
| RCNL-01 | Phase 14 | Done |
| RCNL-02 | Phase 14 | Done |
| RCNL-03 | Phase 14 | Done |
| RCNL-04 | Phase 14 | Done |
| WSKT-01 | Phase 15 | Done |
| WSKT-02 | Phase 15 | Done |
| WSKT-03 | Phase 15 | Done |
| WSKT-04 | Phase 15 | Done |
| WSKT-05 | Phase 15 | Done |
| CLNT-01 | Phase 16 | Done |
| CLNT-04 | Phase 16 | Done |
| CLNT-02 | Phase 17 | Done |
| CLNT-03 | Phase 17 | Done |
| CLNT-05 | Phase 17 | Done |
| ARCH-01 | Phase 11 | Done |
| ARCH-02 | Phase 11 | Done |
| ARCH-03 | Phase 18 | Done |
| ARCH-04 | Phase 18 | Done |

**Coverage:**
- v1.1 requirements: 32 total
- Mapped to phases: 32
- Unmapped: 0

---
*Requirements defined: 2026-02-11*
*Last updated: 2026-02-11 -- all 32 requirements marked Done, v1.1 milestone complete*
