# Roadmap: Factory Factory

## Milestones

- ✅ **v1.0 SRP Consolidation** -- Phases 1-10 (shipped 2026-02-10) -- [Archive](milestones/v1.0-ROADMAP.md)
- 🚧 **v1.1 Project Snapshot Service** -- Phases 11-18 (in progress)

## Phases

<details>
<summary>v1.0 SRP Consolidation (Phases 1-10) -- SHIPPED 2026-02-10</summary>

See [v1.0 Roadmap Archive](milestones/v1.0-ROADMAP.md) for full phase details.

</details>

### v1.1 Project Snapshot Service (In Progress)

**Milestone Goal:** Replace multiple independent polling loops with a single in-memory materialized view of all workspace states, pushed to clients via WebSocket.

**Phase Numbering:**
- Integer phases (11, 12, 13...): Planned milestone work
- Decimal phases (12.1, 12.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 11: Snapshot Store** -- In-memory store with versioned per-workspace entries, cleanup contracts, and derived state ✓ 2026-02-11
- [x] **Phase 12: Domain Event Emission** -- Add EventEmitter capability to workspace, GitHub, ratchet, run-script, and session domains ✓ 2026-02-11
- [x] **Phase 13: Event Collector** -- Orchestration layer wiring domain events to snapshot store updates with coalescing ✓ 2026-02-11
- [ ] **Phase 14: Safety-Net Reconciliation** -- Periodic full recompute from authoritative sources with drift detection
- [ ] **Phase 15: WebSocket Transport** -- Real-time push of snapshot changes to connected clients scoped by project
- [ ] **Phase 16: Client Integration - Sidebar** -- Sidebar reads from WebSocket-driven snapshot with React Query cache integration
- [ ] **Phase 17: Client Integration - Kanban and Workspace List** -- Remaining consumers migrate to snapshot with polling fallback
- [ ] **Phase 18: Architecture Validation** -- Dependency-cruiser passes, full test suite green, no regressions

## Phase Details

### Phase 11: Snapshot Store
**Goal**: A versioned, per-workspace in-memory store exists as an infrastructure service with proper cleanup contracts, ready to receive updates from any source
**Depends on**: Nothing (first phase of v1.1)
**Requirements**: STORE-01, STORE-02, STORE-03, STORE-04, STORE-05, STORE-06, ARCH-01, ARCH-02
**Success Criteria** (what must be TRUE):
  1. Snapshot store can be created, queried by workspaceId, and returns entries with version counter and debug metadata (computedAt, source)
  2. When a workspace is archived or deleted, its snapshot entry is removed and cannot be queried
  3. Snapshot entries include derived state fields (sidebarStatus, kanbanColumn, flowPhase, ciObservation) that recompute when underlying fields change
  4. The service lives in src/backend/services/ and has zero imports from @/backend/domains/
  5. Concurrent updates to the same workspace preserve the newest data via field-level timestamps
**Plans:** 2 plans

Plans:
- [x] 11-01-PLAN.md -- Core snapshot store service with types, class implementation, barrel export, and bridge wiring
- [x] 11-02-PLAN.md -- Comprehensive test suite covering all 8 requirements (STORE-01 through STORE-06, ARCH-01, ARCH-02)

### Phase 12: Domain Event Emission
**Goal**: Every domain that produces state relevant to project-level UI emits typed events on state transitions, without knowing who listens
**Depends on**: Nothing (independent of Phase 11, can run in parallel)
**Requirements**: EVNT-01, EVNT-02, EVNT-03, EVNT-04, EVNT-05
**Success Criteria** (what must be TRUE):
  1. Workspace state machine transitions (READY, ARCHIVED, FAILED, etc.) emit events with workspace ID and new state
  2. PR snapshot refresh emits events with PR state and CI status changes
  3. Ratchet state transitions and run-script status changes each emit typed events
  4. Session activity events (workspace_active, workspace_idle) flow through WorkspaceActivityService to any subscriber
  5. All domain events are emitted after the mutation completes (not before), and domains have no imports related to snapshot service
**Plans:** 2 plans

Plans:
- [x] 12-01-PLAN.md -- Workspace state machine (EVNT-01) and run-script state machine (EVNT-04) event emission with tests
- [x] 12-02-PLAN.md -- PR snapshot (EVNT-02) and ratchet (EVNT-03) event emission with tests, EVNT-05 verification

### Phase 13: Event Collector
**Goal**: A single orchestrator wires all domain events to snapshot store updates, translating domain-native events into store mutations with coalescing
**Depends on**: Phase 11 (store), Phase 12 (events)
**Requirements**: EVNT-06, EVNT-07, EVNT-08
**Success Criteria** (what must be TRUE):
  1. When any domain emits a state change event, the corresponding workspace snapshot entry is updated within the coalescing window
  2. Rapid-fire events (multiple events within 100-200ms) for the same workspace produce a single snapshot update and push, not multiple
  3. The event collector lives in src/backend/orchestration/ and uses bridge pattern -- domains emit events without importing or knowing about the snapshot service
**Plans:** 1 plan

Plans:
- [x] 13-01-PLAN.md -- Event collector orchestrator with per-workspace coalescing, all 6 event subscriptions, server wiring, and tests

### Phase 14: Safety-Net Reconciliation
**Goal**: A periodic poll recomputes snapshots from authoritative DB and git sources, catches any events that were missed, and logs observable drift metrics
**Depends on**: Phase 11 (store to write into)
**Requirements**: RCNL-01, RCNL-02, RCNL-03, RCNL-04
**Success Criteria** (what must be TRUE):
  1. Every ~60 seconds, snapshot entries are validated against authoritative DB state and corrected if stale
  2. Git stats (diff size, uncommitted changes) appear in snapshots but are only computed during reconciliation, never on event-driven updates
  3. Reconciliation does not overwrite event-driven updates that arrived after the poll started (field-level timestamp comparison)
  4. When reconciliation detects drift between event-driven state and authoritative sources, the correction and its cause are logged
**Plans**: TBD

Plans:
- [ ] 14-01: TBD
- [ ] 14-02: TBD

### Phase 15: WebSocket Transport
**Goal**: Connected clients receive snapshot changes in real time via a project-scoped WebSocket endpoint, with full snapshot on connect and reconnect
**Depends on**: Phase 11 (store), Phase 13 (events populating store)
**Requirements**: WSKT-01, WSKT-02, WSKT-03, WSKT-04, WSKT-05
**Success Criteria** (what must be TRUE):
  1. A /snapshots WebSocket endpoint exists alongside /chat, /terminal, /dev-logs and follows the same handler pattern
  2. When a client connects with a project ID, it immediately receives the full snapshot for all workspaces in that project
  3. When a workspace snapshot changes, only the changed workspace entry is pushed to clients subscribed to that project
  4. Clients subscribed to different projects do not receive each other's updates
  5. After a client disconnects and reconnects, it receives a full snapshot to recover from any events missed during disconnection
**Plans**: TBD

Plans:
- [ ] 15-01: TBD
- [ ] 15-02: TBD

### Phase 16: Client Integration - Sidebar
**Goal**: The sidebar displays workspace state from WebSocket-pushed snapshots instead of its 2-second tRPC polling loop
**Depends on**: Phase 15 (WebSocket transport operational)
**Requirements**: CLNT-01, CLNT-04
**Success Criteria** (what must be TRUE):
  1. Sidebar workspace state updates appear within ~200ms of a backend mutation (not waiting for 2s poll)
  2. React Query cache is updated via queryClient.setQueryData from WebSocket message handlers, so existing query consumers read fresh data without refetch
  3. Sidebar remains correct after WebSocket disconnection and reconnection (no stale state persists)
**Plans**: TBD

Plans:
- [ ] 16-01: TBD

### Phase 17: Client Integration - Kanban and Workspace List
**Goal**: Kanban board and workspace list both read from WebSocket-driven snapshots, and all three project-level surfaces show consistent state with a relaxed polling fallback
**Depends on**: Phase 16 (sidebar pattern established, shared hook exists)
**Requirements**: CLNT-02, CLNT-03, CLNT-05
**Success Criteria** (what must be TRUE):
  1. Kanban column assignments update within ~200ms of workspace status change (not waiting for 15s poll)
  2. Workspace list reflects new/changed workspaces within ~200ms of mutation
  3. All three consumers (sidebar, kanban, workspace list) show the same workspace state at any given moment
  4. A polling fallback remains active at 30-60s cadence as safety net during migration period
**Plans**: TBD

Plans:
- [ ] 17-01: TBD

### Phase 18: Architecture Validation
**Goal**: The complete snapshot service integration passes all architecture rules and causes zero test regressions
**Depends on**: Phase 17 (all changes in place)
**Requirements**: ARCH-03, ARCH-04
**Success Criteria** (what must be TRUE):
  1. dependency-cruiser runs with zero new violations after all snapshot service changes
  2. The full existing test suite (1609+ tests) passes with no regressions
  3. Production build succeeds (pnpm build completes without errors)
**Plans**: TBD

Plans:
- [ ] 18-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 11 -> 12 -> 13 -> 14 -> 15 -> 16 -> 17 -> 18
(Phase 11 and 12 have no dependency between them and may execute in parallel)

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 11. Snapshot Store | v1.1 | 2/2 | ✓ Complete | 2026-02-11 |
| 12. Domain Event Emission | v1.1 | 2/2 | ✓ Complete | 2026-02-11 |
| 13. Event Collector | v1.1 | 1/1 | ✓ Complete | 2026-02-11 |
| 14. Safety-Net Reconciliation | v1.1 | 0/TBD | Not started | - |
| 15. WebSocket Transport | v1.1 | 0/TBD | Not started | - |
| 16. Client Integration - Sidebar | v1.1 | 0/TBD | Not started | - |
| 17. Client Integration - Kanban and Workspace List | v1.1 | 0/TBD | Not started | - |
| 18. Architecture Validation | v1.1 | 0/TBD | Not started | - |

---
*Roadmap created: 2026-02-10*
*Last updated: 2026-02-11 -- Phase 13 complete (1/1 plans, EVNT-06/07/08 verified)*
