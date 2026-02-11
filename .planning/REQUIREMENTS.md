# Requirements: Project Snapshot Service

**Defined:** 2026-02-11
**Core Value:** Every domain object has exactly one owner module, and any operation touching that domain flows through a single, traceable path.

## v1.1 Requirements

Requirements for milestone v1.1. Each maps to roadmap phases.

### Snapshot Store

- [ ] **STORE-01**: In-memory store holds per-workspace snapshot entries keyed by workspaceId, scoped per project
- [ ] **STORE-02**: Each snapshot entry includes monotonically increasing version counter for staleness detection
- [ ] **STORE-03**: Each snapshot entry includes debug metadata: computedAt timestamp, source of last update
- [ ] **STORE-04**: Snapshot entries are removed when workspace is archived or deleted (no memory leaks)
- [ ] **STORE-05**: Snapshot entries include derived state: sidebarStatus, kanbanColumn, flowPhase, ciObservation
- [ ] **STORE-06**: Derived state recomputes when underlying fields change, using existing pure functions

### Event System

- [ ] **EVNT-01**: Workspace domain emits EventEmitter events on state machine transitions (READY, ARCHIVED, FAILED, etc.)
- [ ] **EVNT-02**: GitHub domain emits events when PR snapshot is refreshed (prState, prCiStatus changes)
- [ ] **EVNT-03**: Ratchet domain emits events on ratchet state transitions
- [ ] **EVNT-04**: Run-script domain emits events on run-script status changes
- [ ] **EVNT-05**: Session domain activity events (workspace_active, workspace_idle) flow to snapshot store via existing WorkspaceActivityService
- [ ] **EVNT-06**: Event collector orchestrator in src/backend/orchestration/ wires all domain events to snapshot store updates
- [ ] **EVNT-07**: Event collector uses bridge pattern — domains emit events without knowing about snapshot service
- [ ] **EVNT-08**: Rapid-fire events within 100-200ms window are coalesced into a single snapshot update and push

### Reconciliation

- [ ] **RCNL-01**: Safety-net reconciliation poll runs on ~60s cadence, recomputing snapshots from authoritative DB + git sources
- [ ] **RCNL-02**: Git stats (diff size, uncommitted changes) are computed only during reconciliation, not on event-driven updates
- [ ] **RCNL-03**: Reconciliation only overwrites fields whose data is newer than the current snapshot entry's timestamp
- [ ] **RCNL-04**: Reconciliation logs drift — fields that differ between event-driven state and authoritative sources

### WebSocket Transport

- [ ] **WSKT-01**: New /snapshots WebSocket endpoint follows existing ws handler pattern (alongside /chat, /terminal, /dev-logs)
- [ ] **WSKT-02**: On client connect, server sends full project snapshot (all workspace entries)
- [ ] **WSKT-03**: On snapshot change, server pushes per-workspace delta (only changed workspace entries) to subscribed clients
- [ ] **WSKT-04**: WebSocket subscriptions are scoped to project ID — clients only receive updates for their viewed project
- [ ] **WSKT-05**: On client reconnect, server sends full snapshot to recover from any missed events during disconnection

### Client Integration

- [ ] **CLNT-01**: Sidebar reads workspace state from WebSocket-driven snapshot instead of 2s tRPC poll
- [ ] **CLNT-02**: Kanban board reads workspace state from WebSocket-driven snapshot instead of 15s tRPC poll
- [ ] **CLNT-03**: Workspace list reads workspace state from WebSocket-driven snapshot instead of 15s tRPC poll
- [ ] **CLNT-04**: React Query cache updated via queryClient.setQueryData from WebSocket message handlers
- [ ] **CLNT-05**: Polling fallback remains at relaxed cadence (30-60s) as safety net during migration period

### Architecture Compliance

- [ ] **ARCH-01**: Snapshot service lives in src/backend/services/ as infrastructure service (not a domain module)
- [ ] **ARCH-02**: Snapshot service has zero imports from @/backend/domains/ — all domain data arrives via bridge interfaces or event subscriptions wired in orchestration layer
- [ ] **ARCH-03**: dependency-cruiser passes with no new violations after all changes
- [ ] **ARCH-04**: Existing tests continue to pass (no regressions)

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
| STORE-01 | — | Pending |
| STORE-02 | — | Pending |
| STORE-03 | — | Pending |
| STORE-04 | — | Pending |
| STORE-05 | — | Pending |
| STORE-06 | — | Pending |
| EVNT-01 | — | Pending |
| EVNT-02 | — | Pending |
| EVNT-03 | — | Pending |
| EVNT-04 | — | Pending |
| EVNT-05 | — | Pending |
| EVNT-06 | — | Pending |
| EVNT-07 | — | Pending |
| EVNT-08 | — | Pending |
| RCNL-01 | — | Pending |
| RCNL-02 | — | Pending |
| RCNL-03 | — | Pending |
| RCNL-04 | — | Pending |
| WSKT-01 | — | Pending |
| WSKT-02 | — | Pending |
| WSKT-03 | — | Pending |
| WSKT-04 | — | Pending |
| WSKT-05 | — | Pending |
| CLNT-01 | — | Pending |
| CLNT-02 | — | Pending |
| CLNT-03 | — | Pending |
| CLNT-04 | — | Pending |
| CLNT-05 | — | Pending |
| ARCH-01 | — | Pending |
| ARCH-02 | — | Pending |
| ARCH-03 | — | Pending |
| ARCH-04 | — | Pending |

**Coverage:**
- v1.1 requirements: 32 total
- Mapped to phases: 0
- Unmapped: 32 ⚠️

---
*Requirements defined: 2026-02-11*
*Last updated: 2026-02-11 after initial definition*
