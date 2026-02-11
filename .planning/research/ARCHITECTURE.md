# Architecture Research: In-Memory Project Snapshot Service

**Domain:** Real-time in-memory materialized view for workspace state
**Researched:** 2026-02-11
**Confidence:** HIGH

## Placement Decision: Infrastructure Service, Not Domain Module

The snapshot service is **not a domain** -- it does not own a business concept, entities, or have its own persistence. It is a read-side projection that aggregates data from all 6 existing domains into a single materialized view. It belongs in `src/backend/services/` as an infrastructure service, with a thin orchestration-layer integration for cross-domain event collection.

**Rationale:**
- Domain modules own business concepts (workspace, session, github, ratchet, terminal, run-script). The snapshot service owns nothing -- it reads from all of them.
- Infrastructure services in `src/backend/services/` already include analogous cross-cutting concerns: scheduler.service.ts (periodic tasks), health.service.ts (aggregated status), notification.service.ts (broadcast).
- Placing it as a domain module would require bridge interfaces to every other domain, making it the most coupled module. As an infrastructure service, it can import from domain barrels directly (same as tRPC routers and orchestrators do).
- The existing dependency-cruiser rule `no-cross-domain-imports` prevents domains from importing sibling domains. The snapshot service needs data from all domains, so it cannot be a domain.

**Files:**
- `src/backend/services/project-snapshot.service.ts` -- core snapshot store + reconciliation
- `src/backend/services/project-snapshot.types.ts` -- snapshot entry type, event types
- `src/backend/services/project-snapshot.test.ts` -- co-located tests

## System Overview

```
                         Frontend (React + tRPC + WS)
                              |            ^
                    tRPC query |            | WebSocket push
                    (fallback) |            | (snapshot_delta / snapshot_full)
                              v            |
  ┌──────────────────────────────────────────────────────────────────────┐
  │                    Snapshot WebSocket Handler                        │
  │              src/backend/routers/websocket/snapshot.handler.ts       │
  │   Manages /snapshot WS connections, sends full snapshot on connect,  │
  │   forwards delta events from snapshot service to connected clients   │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ subscribes to
                                  v
  ┌──────────────────────────────────────────────────────────────────────┐
  │                    Project Snapshot Service                          │
  │              src/backend/services/project-snapshot.service.ts        │
  │                                                                      │
  │   ┌─────────────────────────────────────────────────────────────┐   │
  │   │              In-Memory Snapshot Store                        │   │
  │   │   Map<projectId, Map<workspaceId, WorkspaceSnapshot>>       │   │
  │   │   + version counter, computedAt, source metadata            │   │
  │   └─────────────────────────────────────────────────────────────┘   │
  │                                                                      │
  │   ┌──────────────────┐  ┌────────────────────┐  ┌───────────────┐  │
  │   │  Event Receiver  │  │  Reconciliation    │  │  Query API    │  │
  │   │  updateWorkspace │  │  Poller (1 min)    │  │  getSnapshot  │  │
  │   │  removeWorkspace │  │  Full recompute    │  │  getWorkspace │  │
  │   └──────────────────┘  └────────────────────┘  └───────────────┘  │
  │                                                                      │
  │   EventEmitter: 'snapshot_changed' per (projectId, workspaceId)     │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 ^
                                 │ updateWorkspace() calls
  ┌──────────────────────────────┴───────────────────────────────────────┐
  │                    Snapshot Event Collector                          │
  │        src/backend/orchestration/snapshot-events.orchestrator.ts     │
  │                                                                      │
  │   Imports from all 6 domain barrels. Listens to domain events and   │
  │   calls projectSnapshotService.updateWorkspace() on relevant        │
  │   mutations. Wired at startup alongside configureDomainBridges().   │
  └──────────┬──────────┬──────────┬──────────┬──────────┬──────────────┘
             │          │          │          │          │
             v          v          v          v          v
  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────────┐
  │session │ │workspace│ │github │ │ratchet │ │terminal│ │ run-script │
  │ domain │ │ domain  │ │ domain│ │ domain │ │ domain │ │   domain   │
  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘ └────────────┘
```

## Component Responsibilities

| Component | Responsibility | Location | Communicates With |
|-----------|----------------|----------|-------------------|
| **Snapshot Store** | Holds in-memory Map of workspace snapshots per project. Versioned entries with metadata. | `project-snapshot.service.ts` | Event collector (receives updates), Query API (serves reads), WS handler (emits changes) |
| **Event Collector** | Wires domain events to snapshot updates. Knows which mutations affect which snapshot fields. | `snapshot-events.orchestrator.ts` | All 6 domain barrels (reads events), Snapshot store (writes updates) |
| **Reconciliation Poller** | Periodically recomputes full snapshot from DB + in-memory state. Catches missed events. | Inside `project-snapshot.service.ts` | Database (via resource accessors), Domain services (in-memory state), Snapshot store (overwrites) |
| **WebSocket Handler** | Manages `/snapshot` WS connections scoped to projectId. Sends full snapshot on connect, deltas on change. | `routers/websocket/snapshot.handler.ts` | Snapshot service (subscribes to changes), Frontend (sends JSON frames) |
| **Query API** | tRPC procedure for non-WS clients (fallback, SSR, initial load). Reads from snapshot store. | `trpc/workspace.trpc.ts` (modified) | Snapshot store (reads) |
| **Debug Metadata** | Each snapshot entry carries `version`, `computedAt`, `source` (event type or 'reconciliation'). | Part of snapshot entry type | Exposed to frontend for debugging |

## Data Flow

### Primary Flow: Event-Driven Update

```
1. Domain Mutation Occurs
   e.g., workspaceStateMachine.markReady(id)
   or    sessionService.startClaudeSession(id)
   or    prSnapshotService.refreshWorkspace(id, url)

2. Event Collector Observes
   The collector hooks into domain event emitters or wraps mutation calls.
   It calls projectSnapshotService.updateWorkspace(projectId, workspaceId, patch)

3. Snapshot Store Updates Entry
   - Merges patch into existing entry (or creates new entry)
   - Bumps version counter
   - Sets computedAt = now, source = event type
   - Emits 'snapshot_changed' event with (projectId, workspaceId, entry)

4. WebSocket Handler Broadcasts
   - Receives 'snapshot_changed' event
   - Serializes changed entry as JSON delta
   - Sends to all WS connections subscribed to that projectId

5. Frontend Receives Delta
   - WebSocket message handler updates React Query cache
   - Sidebar, Kanban, workspace list all re-render from same cache
```

### Secondary Flow: Safety-Net Reconciliation

```
1. Timer fires every ~60 seconds

2. For each active project (has WS subscribers):
   a. Query all non-archived workspaces from DB (via workspaceAccessor)
   b. Enrich with in-memory state:
      - isWorking from sessionService.isAnySessionWorking()
      - pendingRequests from chatEventForwarderService.getAllPendingRequests()
      - flowState from deriveWorkspaceFlowStateFromWorkspace()
   c. Diff against current snapshot entries
   d. For entries that changed: update store, emit 'snapshot_changed'
   e. For entries that disappeared (archived/deleted): remove, emit 'snapshot_removed'
   f. Source = 'reconciliation' in metadata

3. Same broadcast path as event-driven updates
```

### Tertiary Flow: WebSocket Connect (Initial Load)

```
1. Client opens WebSocket to /snapshot?projectId=xxx

2. Handler registers connection, grouped by projectId

3. If snapshot for projectId exists:
   - Send full snapshot (all workspace entries) as 'snapshot_full' message
4. If not:
   - Trigger immediate reconciliation for that project
   - Send result as 'snapshot_full' message

5. Subsequent changes arrive as 'snapshot_delta' messages
```

## Snapshot Entry Shape

```typescript
interface WorkspaceSnapshotEntry {
  // Identity
  workspaceId: string;
  projectId: string;

  // Display
  name: string;
  createdAt: string;
  branchName: string | null;

  // PR State (from github domain / workspace DB)
  prUrl: string | null;
  prNumber: number | null;
  prState: PRState | null;
  prCiStatus: CIStatus | null;

  // Agent State (from session domain, in-memory)
  isWorking: boolean;
  pendingRequestType: 'plan_approval' | 'user_question' | null;

  // Ratchet State (from ratchet domain / workspace DB)
  ratchetEnabled: boolean;
  ratchetState: RatchetState | null;
  ratchetButtonAnimated: boolean;

  // Derived State (computed from above)
  sidebarStatus: WorkspaceSidebarStatus;
  kanbanColumn: KanbanColumn | null;
  flowPhase: string;
  ciObservation: string;

  // Git Stats (from git-ops, computed during reconciliation only)
  gitStats: { total: number; additions: number; deletions: number; hasUncommitted: boolean } | null;

  // Run Script
  runScriptStatus: RunScriptStatus | null;

  // Activity
  lastActivityAt: string | null;

  // Debug Metadata
  _version: number;
  _computedAt: string;
  _source: string; // 'workspace_state_change' | 'session_activity' | 'pr_update' | 'reconciliation' | ...
}
```

This shape mirrors exactly what `getProjectSummaryState()` currently returns per workspace. The snapshot service replaces that query with a pre-computed, event-maintained cache.

## Integration Points with Existing Domains

### Session Domain
**What changes:** The session domain already emits workspace activity events via `workspaceActivityService.markSessionRunning()` and `markSessionIdle()`. The event collector listens to these same events.
**Hook points:**
- `workspaceActivityService` emits `workspace_active` and `workspace_idle` events -- collector subscribes
- `chatEventForwarderService` manages pending requests -- collector reads via existing bridge or direct query
- `sessionService.isAnySessionWorking()` -- used during reconciliation

**No changes to session domain code required.** The collector observes existing events.

### Workspace Domain
**What changes:** Workspace state machine transitions are the primary driver of snapshot changes.
**Hook points:**
- `workspaceStateMachine` transitions (NEW -> PROVISIONING -> READY -> ARCHIVED, FAILED) -- collector needs notification
- `workspaceDataService.update()` -- name changes, PR URL attachment
- `kanbanStateService.updateCachedKanbanColumn()` -- already called on PR changes

**Minimal change to workspace domain:** Add EventEmitter to `workspaceStateMachine` to emit on state transitions (it currently does not emit events, it just updates DB). Alternatively, the event collector wraps or intercepts the tRPC mutation layer.

### GitHub Domain
**What changes:** PR state updates need to flow to the snapshot.
**Hook points:**
- `prSnapshotService.refreshWorkspace()` -- already updates workspace DB fields, triggers `kanbanStateService.updateCachedKanbanColumn()`
- Collector can hook into `prSnapshotService` events or the kanban column update call

**Minimal change:** Add event emission after PR snapshot refresh completes.

### Ratchet Domain
**What changes:** Ratchet state transitions affect snapshot display.
**Hook points:**
- `ratchetService` periodic checks update workspace ratchet state fields
- Collector can observe workspace DB updates or add event emission to ratchet state changes

### Terminal Domain
**What changes:** None for snapshot. Terminal state is session-scoped, not shown in sidebar/kanban.

### Run-Script Domain
**What changes:** `runScriptStatus` changes need to flow to snapshot.
**Hook points:**
- `runScriptStateMachine` transitions -- collector subscribes
- `startupScriptService` completion -- flows through workspace state machine already

## Event Collection Strategy: Post-Mutation Hooks

The cleanest integration pattern is **post-mutation event emission**, not intercepting every call site. Three approaches considered:

### Approach A: Domain EventEmitter Enhancement (RECOMMENDED)

Add `EventEmitter` capability to key domain services that currently lack it. The collector subscribes to typed events.

```typescript
// In workspace domain: workspaceStateMachine emits after transitions
workspaceStateMachine.on('transition', ({ workspaceId, from, to }) => { ... });

// In github domain: prSnapshotService emits after refresh
prSnapshotService.on('pr_refreshed', ({ workspaceId, prState, prCiStatus }) => { ... });

// In session domain: workspaceActivityService already emits
workspaceActivityService.on('workspace_active', ({ workspaceId }) => { ... });
workspaceActivityService.on('workspace_idle', ({ workspaceId }) => { ... });
```

**Why this approach:**
- Follows the existing pattern (workspaceActivityService already uses EventEmitter)
- Domains emit events without knowing who listens -- no coupling to snapshot service
- Event collector in orchestration layer subscribes at startup
- Each domain change is small: add `extends EventEmitter` and `this.emit()` after mutations

### Approach B: tRPC Middleware Interception (NOT RECOMMENDED)

Intercept tRPC mutation calls to detect changes. This is fragile -- not all mutations flow through tRPC (scheduler, ratchet, interceptors all mutate directly).

### Approach C: Database Trigger / Prisma Middleware (NOT RECOMMENDED)

Use Prisma middleware to detect writes. This misses in-memory state changes (isWorking, pendingRequests) which are critical to the snapshot.

## Recommended Project Structure

```
src/backend/
  services/
    project-snapshot.service.ts          # Core: store, reconciliation, event emission
    project-snapshot.service.test.ts     # Unit tests
    project-snapshot.types.ts            # Snapshot entry type, event types, WS message types
  orchestration/
    snapshot-events.orchestrator.ts      # Event collector: wires domain events to snapshot updates
    snapshot-events.orchestrator.test.ts # Tests for event wiring
  routers/
    websocket/
      snapshot.handler.ts               # WebSocket /snapshot handler
      index.ts                          # Updated: export snapshot handler
  trpc/
    workspace.trpc.ts                   # Modified: getProjectSummaryState reads from snapshot
```

### Structure Rationale

- **`services/project-snapshot.service.ts`**: Infrastructure service because it is a read-side cache, not a domain concept. Same level as scheduler, health, notification services.
- **`orchestration/snapshot-events.orchestrator.ts`**: Lives in orchestration because it imports from multiple domain barrels to wire events -- exactly what orchestrators do (see `domain-bridges.orchestrator.ts` precedent).
- **`routers/websocket/snapshot.handler.ts`**: Follows existing pattern of WebSocket handlers in `routers/websocket/` (chat, terminal, dev-logs).
- **`trpc/workspace.trpc.ts`**: Existing `getProjectSummaryState` procedure modified to read from snapshot instead of computing live.

## Architectural Patterns

### Pattern 1: EventEmitter for Domain Events

**What:** Domains that mutate state emit typed events after mutations complete.
**When:** A domain service performs a mutation that other parts of the system need to react to.
**Trade-offs:** Low coupling (emitter does not know listeners), but requires discipline to emit consistently.
**Already used:** `workspaceActivityService extends EventEmitter` in workspace domain.

```typescript
// workspace domain: state-machine.service.ts
class WorkspaceStateMachine extends EventEmitter {
  async markReady(workspaceId: string): Promise<void> {
    await workspaceAccessor.update(workspaceId, { status: 'READY' });
    this.emit('transition', { workspaceId, to: 'READY' });
  }
}
```

### Pattern 2: Orchestrator as Event Wiring

**What:** An orchestrator file in `src/backend/orchestration/` imports from domain barrels and wires event subscriptions. Called once at startup.
**When:** Multiple domains need to be connected without direct coupling.
**Already used:** `configureDomainBridges()` in `domain-bridges.orchestrator.ts`.

```typescript
// orchestration/snapshot-events.orchestrator.ts
export function configureSnapshotEvents(snapshotService: ProjectSnapshotService): void {
  // Wire workspace state machine transitions
  workspaceStateMachine.on('transition', ({ workspaceId }) => {
    snapshotService.invalidateWorkspace(workspaceId);
  });

  // Wire session activity changes
  workspaceActivityService.on('workspace_active', ({ workspaceId }) => {
    snapshotService.updateWorkspaceActivity(workspaceId, true);
  });
  // ...
}
```

### Pattern 3: Snapshot-on-Connect

**What:** When a WebSocket client connects, immediately send the full current snapshot. Subsequent updates are deltas.
**When:** Client needs complete state immediately, then incremental updates.
**Already used:** Dev-logs handler sends output buffer on connect, then subscribes to new output.

```typescript
// On WS connect
const snapshot = snapshotService.getProjectSnapshot(projectId);
ws.send(JSON.stringify({ type: 'snapshot_full', data: snapshot }));

// Subscribe to changes
snapshotService.on('snapshot_changed', (event) => {
  if (event.projectId === projectId) {
    ws.send(JSON.stringify({ type: 'snapshot_delta', data: event.entry }));
  }
});
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: Snapshot Service Importing Domain Internals

**What people do:** Import internal domain files (e.g., `@/backend/domains/workspace/state/flow-state`) directly in the snapshot service.
**Why it is wrong:** Violates barrel-file encapsulation. dependency-cruiser rules will catch this, but architecturally it couples the snapshot service to domain internals.
**Do this instead:** Import only from domain barrel files (`@/backend/domains/workspace`). If a function is not exported from the barrel, add it to the barrel.

### Anti-Pattern 2: Domains Importing Snapshot Service

**What people do:** Have domain services call `snapshotService.updateWorkspace()` directly after mutations.
**Why it is wrong:** Creates a circular dependency (snapshot -> domains -> snapshot). Violates the principle that domains do not know about cross-cutting infrastructure.
**Do this instead:** Domains emit events. The orchestration layer listens and calls the snapshot service. Domains are unaware of the snapshot service's existence.

### Anti-Pattern 3: Git Stats in Event-Driven Updates

**What people do:** Compute git stats (diff size, uncommitted changes) on every snapshot update.
**Why it is wrong:** Git stats require filesystem access and are expensive (~50-200ms per workspace). Running them on every event would create significant latency.
**Do this instead:** Compute git stats only during reconciliation (every ~60s). Event-driven updates carry all other fields but leave gitStats unchanged.

### Anti-Pattern 4: Full Snapshot Broadcast on Every Change

**What people do:** Send the entire project snapshot to all clients on every workspace change.
**Why it is wrong:** With 20+ workspaces, sending the full list on every session activity toggle wastes bandwidth and causes unnecessary re-renders.
**Do this instead:** Send delta messages with only the changed workspace entry. Clients merge deltas into their local cache.

## Scaling Considerations

| Concern | At 1-5 projects | At 10-20 projects | Notes |
|---------|-----------------|--------------------|-----------------------------|
| Memory | Negligible (~100KB) | Still negligible (~2MB) | Snapshot entries are small JSON |
| Reconciliation | Fast (~200ms) | May need staggering | Git stats are the bottleneck; limit concurrency |
| WebSocket connections | 1-3 clients | 5-10 clients | Standard WS scaling, no special handling needed |
| Event frequency | Low (~1/sec) | Moderate (~5/sec) | Debounce rapid session activity toggles (100ms) |

### Scaling Priorities

1. **First bottleneck: git stats during reconciliation.** Already mitigated by existing `pLimit(3)` concurrency in workspace query service. The snapshot service should use the same pattern and only compute git stats during reconciliation, not event-driven updates.

2. **Second bottleneck: rapid event storms.** A session starting/stopping rapidly could flood snapshot updates. Mitigate with a short debounce (100ms) on `updateWorkspace` calls that only affect `isWorking` -- coalesce rapid transitions.

## Build Order (Dependency Chain)

The components have clear dependencies that dictate build order:

```
Phase 1: Snapshot Store + Types
  project-snapshot.types.ts (no deps)
  project-snapshot.service.ts (depends on types, resource accessors)
  project-snapshot.service.test.ts
  -> Delivers: in-memory store, reconciliation logic, event emission

Phase 2: Domain Event Emission
  Add EventEmitter to workspaceStateMachine (workspace domain)
  Add EventEmitter to prSnapshotService (github domain)
  Add EventEmitter to runScriptStateMachine (run-script domain)
  Session domain: workspaceActivityService already emits -- no change
  -> Delivers: domain services emit typed events after mutations

Phase 3: Event Collector (Orchestration)
  snapshot-events.orchestrator.ts (depends on Phase 1 + Phase 2)
  Wire into server startup in server.ts (after configureDomainBridges)
  -> Delivers: domain events flow into snapshot store

Phase 4: WebSocket Handler
  snapshot.handler.ts (depends on Phase 1)
  Wire into server.ts upgrade handler
  -> Delivers: snapshot pushed to clients via WebSocket

Phase 5: Client Integration
  Frontend WebSocket hook for /snapshot
  React Query cache integration (merge deltas into existing cache)
  Modify sidebar, kanban, workspace list to consume snapshot
  -> Delivers: UI reads from snapshot instead of polling tRPC

Phase 6: Migration + Cleanup
  getProjectSummaryState reads from snapshot (thin wrapper)
  listWithKanbanState reads from snapshot
  Remove or reduce polling intervals on frontend
  -> Delivers: old polling paths eliminated or demoted to fallback
```

**Phase ordering rationale:**
- Phase 1 is standalone and testable in isolation
- Phase 2 is independent of Phase 1 and can be built in parallel
- Phase 3 requires both Phase 1 and Phase 2
- Phase 4 requires Phase 1 but not Phase 2/3 (can test with manual snapshot updates)
- Phase 5 requires Phase 4 (needs WS handler to receive messages)
- Phase 6 is cleanup that depends on everything working end-to-end

## Sources

- Direct codebase analysis (HIGH confidence) -- all architectural recommendations based on reading the existing domain module pattern, bridge interfaces, orchestration layer, WebSocket handlers, and tRPC routers in the factory-factory-2 codebase
- `src/backend/orchestration/domain-bridges.orchestrator.ts` -- established pattern for cross-domain wiring
- `src/backend/domains/workspace/lifecycle/activity.service.ts` -- established EventEmitter pattern for domain events
- `src/backend/routers/websocket/dev-logs.handler.ts` -- established pattern for WS handler with subscribe-on-connect
- `src/backend/services/scheduler.service.ts` -- established pattern for periodic background reconciliation
- `src/backend/domains/workspace/query/workspace-query.service.ts` -- the exact data shape and computation that the snapshot service replaces

---
*Architecture research for: In-Memory Project Snapshot Service*
*Researched: 2026-02-11*
