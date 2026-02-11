# Technology Stack: Project Snapshot Service

**Project:** In-memory materialized view of workspace states with event-driven updates and WebSocket push
**Researched:** 2026-02-11

## Executive Summary

The snapshot service requires **zero new dependencies**. The existing codebase already contains every building block needed: Node.js `Map` for in-memory stores, `EventEmitter` for pub/sub, the `ws` library for WebSocket broadcasting, `Zod` for schema validation, and `setInterval` for reconciliation polling. The architecture should follow the exact same patterns already proven in this codebase -- specifically the `SessionDomainService` (in-memory store + publisher), `WorkspaceActivityService` (EventEmitter-based cross-domain signaling), and `ChatConnectionService` (WebSocket broadcast to connected clients).

## Recommended Stack

### No New Dependencies Required

| Category | Existing Technology | Version in Repo | How It's Used for Snapshot Service |
|----------|--------------------|-----------------|------------------------------------|
| In-memory store | `Map<string, WorkspaceSnapshot>` | Node.js built-in | Keyed by workspaceId, holds materialized snapshot per workspace |
| Event bus | `EventEmitter` (node:events) | Node.js built-in | Internal pub/sub for snapshot invalidation signals from domains |
| WebSocket broadcast | `ws` | ^8.19.0 | New `/snapshots` WebSocket endpoint for push to connected clients |
| Schema validation | `zod` | ^4.3.6 | Snapshot shape, delta event discriminated unions, WebSocket messages |
| Scheduled tasks | `setInterval` | Node.js built-in | Safety-net reconciliation poll (~60s), same pattern as `SchedulerService` |
| Logging | `createLogger()` | Internal service | Logger tagged `'snapshot'` for observability |
| Debug metadata | TypeScript types | ^5.9.3 | `version`, `computedAt`, `source` fields on snapshot objects |

**Confidence: HIGH** -- Every technology listed is already in the dependency tree and proven in production patterns within this exact codebase.

### Patterns to Reuse (Not Libraries to Add)

The codebase has three patterns that map directly to snapshot service needs:

#### 1. In-Memory Store Pattern (from `SessionStoreRegistry` / `SessionDomainService`)

The session domain already maintains an in-memory store (`SessionStoreRegistry`) keyed by session ID, with a publisher that broadcasts deltas over WebSocket. The snapshot service follows the identical pattern but keyed by workspace ID.

```typescript
// Existing pattern in session-domain.service.ts:
private readonly registry = new SessionStoreRegistry(); // Map<sessionId, SessionStore>
private readonly publisher = new SessionPublisher();     // Broadcasts to WebSocket connections

// Snapshot service equivalent:
private readonly snapshots = new Map<string, WorkspaceSnapshot>();
private readonly publisher = new SnapshotPublisher();    // Broadcasts to snapshot WS connections
```

**Confidence: HIGH** -- This is a direct copy of an established pattern.

#### 2. Event-Driven Cross-Domain Signaling (from `WorkspaceActivityService`)

`WorkspaceActivityService` extends `EventEmitter` and emits `workspace_idle`/`workspace_active` events that cross domain boundaries via bridge interfaces. The snapshot service needs the same approach: domains emit "something changed" signals, the snapshot service listens and invalidates/recomputes.

```typescript
// Existing pattern in activity.service.ts:
class WorkspaceActivityService extends EventEmitter {
  markSessionRunning(workspaceId, sessionId) { ... this.emit('workspace_active', { workspaceId }); }
  markSessionIdle(workspaceId, sessionId)    { ... this.emit('workspace_idle', { workspaceId }); }
}

// Snapshot service needs to listen to similar signals across multiple domains
```

**Confidence: HIGH** -- Bridge interface pattern is well-established in orchestration layer.

#### 3. WebSocket Broadcast Pattern (from `ChatConnectionService` / `DevLogsHandler`)

`ChatConnectionService.forwardToSession()` iterates over connected WebSocket clients and sends JSON. The dev-logs handler uses `Map<workspaceId, Set<WebSocket>>` for per-workspace subscriptions. The snapshot service needs a project-scoped variant.

```typescript
// Existing pattern in chat-connection.service.ts:
forwardToSession(dbSessionId: string, data: unknown): void {
  const json = JSON.stringify(data);
  for (const info of this.connections.values()) {
    if (info.dbSessionId === dbSessionId && info.ws.readyState === WS_READY_STATE.OPEN) {
      info.ws.send(json);
    }
  }
}

// Snapshot service equivalent: broadcast to all connections subscribed to a project
```

**Confidence: HIGH** -- Two independent implementations of this pattern already exist.

## What NOT to Add (and Why)

| Rejected Technology | Why NOT | What to Do Instead |
|--------------------|---------|--------------------|
| **Redis** | Single-process Node.js server. No multi-instance coordination needed. Redis adds operational complexity (separate process, connection management, serialization overhead) for zero benefit in this architecture. | `Map<string, WorkspaceSnapshot>` in process memory |
| **External pub/sub (NATS, RabbitMQ)** | Same reasoning as Redis. All domains run in the same Node.js process. EventEmitter provides synchronous in-process pub/sub with zero latency. | `EventEmitter` from `node:events` |
| **Socket.IO** | Already using raw `ws` for 3 WebSocket endpoints (chat, terminal, dev-logs). Adding Socket.IO would create a parallel transport layer, increase bundle size, and diverge from established patterns. | Raw `ws` WebSocket with the same upgrade handler pattern |
| **tRPC subscriptions** | tRPC v11 supports subscriptions via `httpSubscriptionLink` (SSE-based), but the codebase uses raw WebSocket for all real-time communication. Mixing transport layers creates confusion and the SSE approach adds HTTP overhead. | New `/snapshots` WebSocket endpoint following existing `/chat`, `/terminal`, `/dev-logs` pattern |
| **Immer / Immutable.js** | Snapshot objects are shallow. A workspace snapshot is ~15 scalar fields. Structural sharing libraries add overhead without benefit at this scale. | Direct object spread `{ ...snapshot, ...delta }` for immutable updates |
| **RxJS** | Massive library for a simple pub/sub + transform pipeline. EventEmitter + Map + setTimeout covers everything. The codebase has zero RxJS usage. | Node.js EventEmitter + straightforward async functions |
| **Prisma change subscriptions / triggers** | Prisma doesn't have built-in change notifications. Polling the DB to detect changes defeats the purpose of an in-memory cache. | Event-driven: domains signal changes, snapshot service reacts |
| **Separate worker thread** | Snapshot computation is I/O-bound (DB reads, git operations), not CPU-bound. Worker threads add IPC serialization overhead. The existing scheduler already runs async operations on the main event loop without blocking. | Async functions on main event loop, same as `SchedulerService` |

**Confidence: HIGH** for all rejections -- based on direct observation of the running architecture.

## Integration Points with Existing Domain Modules

### Event Sources (Domains That Trigger Snapshot Updates)

| Domain | Events to Capture | Integration Mechanism |
|--------|------------------|-----------------------|
| **workspace** | Status changes (READY, PROVISIONING, FAILED, ARCHIVED), PR attachment, ratchet toggle, workspace creation/deletion | Bridge interface on `workspaceStateMachine` and `workspaceDataService`. Add `SnapshotBridge` with `invalidateWorkspace(workspaceId)` |
| **session** | Session running/idle transitions, session count changes | Already emitted via `WorkspaceActivityService` events (`workspace_active`, `workspace_idle`). Snapshot service subscribes to these existing events |
| **github** | PR state changes, CI status updates | Bridge interface on `prSnapshotService.applySnapshot()`. Fire invalidation after DB write |
| **ratchet** | Ratchet state transitions (IDLE -> FIXING -> IDLE) | Bridge interface on ratchet state mutations |
| **run-script** | Dev server start/stop | Bridge interface on `runScriptStateMachine` |
| **terminal** | (Not needed for snapshot -- terminal state is session-scoped, not workspace-scoped) | N/A |

### Orchestration Layer Wiring

The snapshot service should be wired via the existing `configureDomainBridges()` function in `domain-bridges.orchestrator.ts`. This is exactly how all cross-domain dependencies are established today.

```typescript
// In domain-bridges.orchestrator.ts:
snapshotService.configure({
  workspace: {
    getSnapshot: (id) => workspaceDataService.findById(id),
    // ... other workspace data accessors
  },
  session: {
    isAnySessionWorking: (ids) => sessionService.isAnySessionWorking(ids),
    getAllPendingRequests: () => chatEventForwarderService.getAllPendingRequests(),
  },
  // ... bridges for git, github, ratchet
});

// Then wire invalidation signals from domains back to snapshot service:
workspaceStateMachine.onTransition((workspaceId) => snapshotService.invalidate(workspaceId));
prSnapshotService.onRefresh((workspaceId) => snapshotService.invalidate(workspaceId));
```

### WebSocket Endpoint Registration

Add a fourth WebSocket upgrade path in `server.ts`, following the existing pattern:

```typescript
// In server.ts, alongside existing handlers:
const snapshotUpgradeHandler = createSnapshotUpgradeHandler(context);

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  // ... existing /chat, /terminal, /dev-logs handlers ...
  if (url.pathname === '/snapshots') {
    snapshotUpgradeHandler(request, socket, head, url, wss, wsAliveMap);
    return;
  }
  socket.destroy();
});
```

### Service Lifecycle

Start/stop in `server.ts`, same as `schedulerService` and `ratchetService`:

```typescript
// In server start:
snapshotService.start(); // Begins reconciliation poll

// In performCleanup:
snapshotService.stop();  // Clears intervals, drains in-flight work
```

## File Placement

Following existing conventions:

| File | Location | Rationale |
|------|----------|-----------|
| Snapshot store + service | `src/backend/services/snapshot.service.ts` | Infrastructure service (cross-cutting, not domain-specific), like `scheduler.service.ts` |
| Snapshot types/schemas | `src/backend/schemas/snapshot.schema.ts` or `src/shared/snapshot.ts` | Shared types consumed by both backend and frontend |
| WebSocket handler | `src/backend/routers/websocket/snapshot.handler.ts` | Follows `chat.handler.ts`, `terminal.handler.ts`, `dev-logs.handler.ts` pattern |
| Bridge wiring | `src/backend/orchestration/domain-bridges.orchestrator.ts` | Extends existing bridge configuration function |
| Constants | `src/backend/services/constants.ts` | Add `snapshotReconciliation` interval to existing `SERVICE_INTERVAL_MS` |

**Alternative consideration:** The snapshot service could be a new domain module (`src/backend/domains/snapshot/`) rather than an infrastructure service. However, it fits better as a service because:
1. It has no Prisma model of its own (purely in-memory)
2. It aggregates data FROM domains rather than owning a domain
3. It's analogous to `scheduler.service.ts` which also coordinates across domains

**Confidence: MEDIUM** -- This is an architectural judgment call. Either placement works; the service placement is recommended because it mirrors the scheduler pattern. If the snapshot service grows to need its own internal modules (separate store, reconciler, publisher), promoting it to a domain module later is straightforward.

## Snapshot Data Structure

Based on what `getProjectSummaryState()` and `listWithKanbanState()` currently compute (which is what the snapshot replaces):

```typescript
interface WorkspaceSnapshot {
  // Identity
  workspaceId: string;
  projectId: string;

  // Core state (from workspace DB record)
  name: string;
  status: WorkspaceStatus;
  branchName: string | null;
  createdAt: string;

  // PR state (from PR snapshot)
  prUrl: string | null;
  prNumber: number | null;
  prState: PRState | null;
  prCiStatus: CIStatus | null;

  // Agent state (from session domain, in-memory)
  isWorking: boolean;
  pendingRequestType: 'plan_approval' | 'user_question' | null;

  // Ratchet state
  ratchetEnabled: boolean;
  ratchetState: RatchetState | null;

  // Git state (from git operations)
  gitStats: { total: number; additions: number; deletions: number; hasUncommitted: boolean } | null;

  // Derived state (computed from above)
  sidebarStatus: WorkspaceSidebarStatus;
  kanbanColumn: KanbanColumn | null;
  flowPhase: WorkspaceFlowPhase;
  ciObservation: WorkspaceCiObservation;
  ratchetButtonAnimated: boolean;

  // Run script
  runScriptStatus: RunScriptStatus | null;

  // Activity
  lastActivityAt: string | null;

  // Debug metadata
  version: number;         // Monotonically increasing, enables client staleness detection
  computedAt: string;      // ISO timestamp of last computation
  source: 'event' | 'reconciliation' | 'initial'; // What triggered this snapshot
}
```

This is validated with Zod (already in the stack) and shared between backend and frontend via `src/shared/snapshot.ts`.

**Confidence: HIGH** -- Directly derived from the existing `getProjectSummaryState()` return type.

## Client-Side Integration

### Current State (What Gets Replaced)

The sidebar currently polls `getProjectSummaryState` via tRPC every **2 seconds** (`refetchInterval: 2000`). The kanban board polls `listWithKanbanState` every **15 seconds**. Both make full DB round-trips and git stat operations on every poll.

### Target State

1. Client opens WebSocket to `/snapshots?projectId=xxx`
2. Server sends full snapshot array on connect (initial state)
3. Server pushes individual workspace snapshot deltas as they occur
4. Client updates local React Query cache from WebSocket messages
5. tRPC polling is removed or reduced to a very long fallback (e.g., 5 minutes)

### React Query Integration

Use `queryClient.setQueryData()` from WebSocket message handlers to update the tRPC cache directly. This is a standard pattern with `@tanstack/react-query` (already at ^5.90.20 in the repo).

```typescript
// In a useEffect or custom hook:
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'snapshot_update') {
    queryClient.setQueryData(['workspace', 'getProjectSummaryState', { projectId }], (old) => {
      // Merge delta into existing data
    });
  }
};
```

**Confidence: HIGH** -- `setQueryData` is a core React Query API, well-documented and stable.

## Installation

**No new packages to install.** All required technology is already in the dependency tree.

```bash
# Nothing to run. Zero new dependencies.
```

## Alternatives Considered

| Category | Recommended | Alternative | Why Not Alternative |
|----------|-------------|-------------|---------------------|
| Store | `Map<string, WorkspaceSnapshot>` | SQLite materialized view table | Adds write amplification; defeats purpose of avoiding DB round-trips |
| Event bus | Node.js `EventEmitter` | `mitt` (tiny EventEmitter) | Already using Node.js EventEmitter everywhere; adding mitt creates inconsistency |
| WebSocket | Raw `ws` (new endpoint) | tRPC subscription (SSE) | Codebase uses raw ws for all 3 existing real-time channels; consistency matters |
| Reconciliation | `setInterval` | Cron library (node-cron) | `setInterval` is what `SchedulerService` uses; no benefit from cron semantics |
| Diffing | Shallow field compare | `fast-deep-equal` | Snapshot objects are flat; `===` on individual fields is sufficient and zero-dep |

## Performance Considerations

| Concern | Assessment | Approach |
|---------|-----------|----------|
| Memory footprint | ~500 bytes per workspace snapshot, ~50 workspaces typical = ~25KB | Negligible; no action needed |
| Event storm (many rapid mutations) | Could cause excessive WebSocket broadcasts | Debounce: coalesce invalidations within a 100-200ms window before recomputing and broadcasting |
| Git stat operations in reconciliation | Currently the most expensive part of `getProjectSummaryState` | Reconciliation poll runs git stats with `pLimit(3)` concurrency (existing pattern). Event-driven updates skip git stats unless specifically triggered by a git operation signal |
| Stale snapshot on reconnect | Client reconnects after disconnection, snapshot may be stale | Send full snapshot array on WebSocket connect (same as dev-logs handler sends output buffer on connect) |

## Sources

- All technology versions verified from `/Users/martin/purplefish-ai/factory-factory-2/package.json`
- All patterns verified from direct codebase inspection of:
  - `src/backend/domains/session/session-domain.service.ts` (in-memory store pattern)
  - `src/backend/domains/session/store/session-publisher.ts` (WebSocket broadcast)
  - `src/backend/domains/session/chat/chat-connection.service.ts` (connection tracking)
  - `src/backend/domains/workspace/lifecycle/activity.service.ts` (EventEmitter cross-domain signaling)
  - `src/backend/domains/workspace/query/workspace-query.service.ts` (current query implementation being replaced)
  - `src/backend/routers/websocket/dev-logs.handler.ts` (per-resource WebSocket subscription)
  - `src/backend/services/scheduler.service.ts` (periodic reconciliation pattern)
  - `src/backend/orchestration/domain-bridges.orchestrator.ts` (bridge wiring pattern)
  - `src/backend/server.ts` (WebSocket upgrade routing, service lifecycle)
  - `src/backend/app-context.ts` (service registration)
  - `src/frontend/components/app-sidebar.tsx` (current 2s polling)
  - `src/frontend/components/kanban/kanban-context.tsx` (current 15s polling)
