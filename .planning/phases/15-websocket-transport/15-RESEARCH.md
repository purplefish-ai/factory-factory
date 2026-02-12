# Phase 15: WebSocket Transport - Research

**Researched:** 2026-02-11
**Domain:** WebSocket-based real-time snapshot delivery with project-scoped subscriptions
**Confidence:** HIGH

## Summary

Phase 15 adds a `/snapshots` WebSocket endpoint that pushes workspace snapshot changes to connected clients in real time. The snapshot store (Phase 11) already emits `snapshot_changed` and `snapshot_removed` events via Node.js EventEmitter. This phase creates a WebSocket handler that subscribes to those store events and fans them out to project-scoped client connections. On connect, the client receives a full snapshot for all workspaces in the requested project; on subsequent changes, only the changed workspace entry is pushed.

The codebase has three existing WebSocket handlers (`/chat`, `/terminal`, `/dev-logs`) that all follow the same pattern: a `createXxxUpgradeHandler(appContext)` factory function that returns a handler with the signature `(request, socket, head, url, wss, wsAliveMap) => void`. The handler parses query parameters, calls `wss.handleUpgrade()`, manages a connection set (Map of ID -> Set<WebSocket>), sends initial state on connect, subscribes to live updates, and cleans up on close. The `/snapshots` handler follows this exact pattern.

The key architectural decision is where the snapshot fan-out logic lives. The `/dev-logs` handler is the closest analog: it has a module-level connections map (`Map<workspaceId, Set<WebSocket>>`), subscribes to a service for live updates, and sends buffered data on connect. For `/snapshots`, the scoping is by project ID (not workspace ID), the initial payload is the full project snapshot (`store.getByProjectId()`), and the live updates come from the snapshot store's EventEmitter events. The handler subscribes to `snapshot_changed` and `snapshot_removed` events on the store and routes them to the appropriate project's connected clients.

**Primary recommendation:** Create `snapshots.handler.ts` in `src/backend/routers/websocket/` following the existing handler pattern. Use a `Map<projectId, Set<WebSocket>>` for connection tracking. Subscribe to `workspaceSnapshotStore` events (`snapshot_changed`, `snapshot_removed`) at module level. On client connect: validate `projectId` query param, send full snapshot via `store.getByProjectId()`, add to connection set. On store events: look up the project's connection set and send per-workspace delta to all OPEN sockets. On client disconnect: remove from set, clean up empty sets. Wire into `server.ts` upgrade handler alongside existing handlers.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| ws | ^8.19.0 | WebSocket server (already project dependency) | All existing WS handlers use it |
| TypeScript | (project) | Type-safe handler + message types | Project standard |
| Vitest | (project) | Co-located unit tests | Project standard |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Zod | (project) | Validate incoming client messages (if any) | Only if client sends messages (e.g., subscribe/unsubscribe) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Direct EventEmitter subscription | Intermediate pub/sub layer | Over-engineering for single-process; EventEmitter is sufficient |
| Project-scoped connection map | Per-workspace connection map | Phase requires project-level scoping (WSKT-04); per-workspace would mean O(N) fan-out |
| Server-sent push only | Request-response + push | Snapshot transport is unidirectional (server -> client); no client messages needed beyond the initial connect with projectId |

**Installation:**
No new packages needed. All dependencies are already in the project.

## Architecture Patterns

### Recommended Project Structure
```
src/backend/routers/websocket/
  snapshots.handler.ts        # NEW: /snapshots WebSocket handler
  snapshots.handler.test.ts   # NEW: Co-located tests
  chat.handler.ts             # EXISTING
  terminal.handler.ts         # EXISTING
  dev-logs.handler.ts         # EXISTING
  upgrade-utils.ts            # EXISTING: shared helpers (markWebSocketAlive, etc.)
  index.ts                    # MODIFIED: add snapshots export
```

### Pattern 1: Upgrade Handler Factory (Existing Codebase Pattern)
**What:** Every WS handler is created via `createXxxUpgradeHandler(appContext)` which returns a function matching the server's `upgrade` event signature. This factory receives the AppContext for service access, creates a logger, and returns the handler closure.
**When to use:** Always -- this is the mandatory pattern for all WS handlers in this codebase.
**Example:**
```typescript
// Source: Codebase pattern from dev-logs.handler.ts, chat.handler.ts, terminal.handler.ts

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import { WS_READY_STATE } from '@/backend/constants';
import type { AppContext } from '../../app-context';
import { getOrCreateConnectionSet, markWebSocketAlive, sendBadRequest } from './upgrade-utils';

export type SnapshotConnectionsMap = Map<string, Set<WebSocket>>;
export const snapshotConnections: SnapshotConnectionsMap = new Map();

export function createSnapshotsUpgradeHandler(appContext: AppContext) {
  const logger = appContext.services.createLogger('snapshots-handler');

  return function handleSnapshotsUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
    wss: WebSocketServer,
    wsAliveMap: WeakMap<WebSocket, boolean>
  ): void {
    const projectId = url.searchParams.get('projectId');
    if (!projectId) {
      logger.warn('Snapshots WebSocket missing projectId');
      sendBadRequest(socket);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      markWebSocketAlive(ws, wsAliveMap);
      getOrCreateConnectionSet(snapshotConnections, projectId).add(ws);

      // Send full snapshot on connect (WSKT-02, WSKT-05)
      // ... send store.getByProjectId(projectId) ...

      ws.on('close', () => {
        // Remove from connection set
        const connections = snapshotConnections.get(projectId);
        if (connections) {
          connections.delete(ws);
          if (connections.size === 0) {
            snapshotConnections.delete(projectId);
          }
        }
      });

      ws.on('error', (error) => {
        logger.error('Snapshots WebSocket error', error);
      });
    });
  };
}
```

### Pattern 2: Store Event Subscription for Fan-Out
**What:** Subscribe to the snapshot store's `snapshot_changed` and `snapshot_removed` EventEmitter events. On each event, look up the project's connection set and send the delta to all OPEN sockets. This subscription happens once at handler creation time, not per-connection.
**When to use:** For routing store changes to the correct project's clients.
**Example:**
```typescript
// Source: Pattern from dev-logs.handler.ts (service subscription) + snapshot store events

import {
  SNAPSHOT_CHANGED,
  SNAPSHOT_REMOVED,
  type SnapshotChangedEvent,
  type SnapshotRemovedEvent,
  workspaceSnapshotStore,
} from '@/backend/services';

// Subscribe once to store events (not per-connection)
function setupStoreSubscription(
  connections: SnapshotConnectionsMap,
  logger: ReturnType<AppContext['services']['createLogger']>
): void {
  workspaceSnapshotStore.on(SNAPSHOT_CHANGED, (event: SnapshotChangedEvent) => {
    const projectClients = connections.get(event.projectId);
    if (!projectClients || projectClients.size === 0) return;

    const message = JSON.stringify({
      type: 'snapshot_changed',
      workspaceId: event.workspaceId,
      entry: event.entry,
    });

    for (const ws of projectClients) {
      if (ws.readyState === WS_READY_STATE.OPEN) {
        ws.send(message);
      }
    }
  });

  workspaceSnapshotStore.on(SNAPSHOT_REMOVED, (event: SnapshotRemovedEvent) => {
    const projectClients = connections.get(event.projectId);
    if (!projectClients || projectClients.size === 0) return;

    const message = JSON.stringify({
      type: 'snapshot_removed',
      workspaceId: event.workspaceId,
    });

    for (const ws of projectClients) {
      if (ws.readyState === WS_READY_STATE.OPEN) {
        ws.send(message);
      }
    }
  });
}
```

### Pattern 3: Full Snapshot on Connect (WSKT-02, WSKT-05)
**What:** When a client connects (or reconnects), send the complete project snapshot immediately. This satisfies both the initial connect requirement (WSKT-02) and the reconnect recovery requirement (WSKT-05). The reconnect case naturally works because every connect sends the full snapshot -- there is no distinction between "first connect" and "reconnect" on the server side.
**When to use:** Inside the `wss.handleUpgrade` callback, right after adding the connection to the set.
**Example:**
```typescript
// Send full snapshot on connect
const entries = workspaceSnapshotStore.getByProjectId(projectId);
const fullSnapshot = JSON.stringify({
  type: 'snapshot_full',
  projectId,
  entries,
});
ws.send(fullSnapshot);
```

### Pattern 4: Server.ts Wiring (Upgrade Handler Registration)
**What:** Add the `/snapshots` path to the `server.on('upgrade', ...)` handler alongside `/chat`, `/terminal`, `/dev-logs`. Create the handler via the factory function with `appContext`.
**When to use:** In server.ts during server setup.
**Example:**
```typescript
// Source: server.ts existing upgrade handler pattern

const snapshotsUpgradeHandler = createSnapshotsUpgradeHandler(context);

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '', `http://${request.headers.host}`);

  if (url.pathname === '/chat') {
    chatUpgradeHandler(request, socket, head, url, wss, wsAliveMap);
    return;
  }
  // ... /terminal, /dev-logs ...

  if (url.pathname === '/snapshots') {
    snapshotsUpgradeHandler(request, socket, head, url, wss, wsAliveMap);
    return;
  }

  socket.destroy();
});
```

### Pattern 5: Message Type Discriminated Union
**What:** All messages from server to client use a `type` field as discriminator. This matches the existing pattern (chat uses `type: 'output'`, `type: 'error'`; terminal uses `type: 'terminal_list'`, `type: 'created'`, `type: 'output'`; dev-logs uses `type: 'output'`).
**When to use:** For all outbound snapshot messages.
**Message types:**
```typescript
// Server -> Client message types:
type SnapshotServerMessage =
  | { type: 'snapshot_full'; projectId: string; entries: WorkspaceSnapshotEntry[] }
  | { type: 'snapshot_changed'; workspaceId: string; entry: WorkspaceSnapshotEntry }
  | { type: 'snapshot_removed'; workspaceId: string };
```

### Anti-Patterns to Avoid
- **Subscribing to store events per-connection:** Each new client connection should NOT add a new EventEmitter listener. This would leak listeners. Subscribe ONCE at handler creation time and route events to all relevant connections via the connections map.
- **Sending deltas for ALL projects to ALL clients:** The connections map is keyed by projectId. Only look up and send to clients subscribed to the changed workspace's project (WSKT-04).
- **Not checking `ws.readyState === OPEN` before `ws.send()`:** WebSocket might be in CLOSING state. All existing handlers check this. Sending to a non-OPEN socket throws or is silently dropped depending on the `ws` library version.
- **Not excluding `/snapshots` from SPA fallback:** The existing SPA fallback in `server.ts` already excludes `/chat`, `/terminal`, `/dev-logs`. Must add `/snapshots` to the exclusion list.
- **Sending mutable references:** The store's `getByProjectId()` returns entries from the internal Map. `JSON.stringify()` creates a snapshot, but do NOT hold references to entries and send them later -- always serialize immediately or clone.
- **Re-exporting handler from `createAppContext` default call:** Following the existing pattern, export a `handleSnapshotsUpgrade = createSnapshotsUpgradeHandler(createAppContext())` convenience export for testing, but use the factory in server.ts with the real context.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Connection tracking | Custom connection registry | `Map<string, Set<WebSocket>>` + `getOrCreateConnectionSet()` from upgrade-utils.ts | Already tested pattern used by terminal + dev-logs handlers |
| WebSocket heartbeat | Custom ping/pong | Existing `wsAliveMap` + `markWebSocketAlive()` from upgrade-utils.ts | Server-level heartbeat already runs every 30s for all WS connections |
| Upgrade handling | Manual HTTP upgrade | `wss.handleUpgrade()` from ws library | Standard ws library pattern, all handlers use it |
| Snapshot data retrieval | Custom store query | `workspaceSnapshotStore.getByProjectId(projectId)` | Already implemented in Phase 11 with project index |
| Change notification | Custom polling/diffing | `workspaceSnapshotStore.on(SNAPSHOT_CHANGED, ...)` EventEmitter | Already implemented in Phase 11, emits after every upsert |
| Bad request rejection | Custom HTTP response | `sendBadRequest(socket)` from upgrade-utils.ts | Already handles proper HTTP 400 response on raw socket |
| JSON serialization | Custom protocol | `JSON.stringify()` with type-discriminated messages | All existing handlers use plain JSON over WS |

**Key insight:** This phase is almost entirely "glue code" connecting the snapshot store's existing EventEmitter events to WebSocket connections. The store already has project-scoped queries and change events. The codebase already has a fully established WebSocket handler pattern with shared utilities. The new handler is structurally simpler than any existing handler because it is unidirectional (server -> client only, no incoming message handling needed beyond the initial connect).

## Common Pitfalls

### Pitfall 1: EventEmitter Listener Leak
**What goes wrong:** If store event listeners are added per-connection instead of once, the EventEmitter accumulates listeners without bound. After 11 connections, Node.js emits a "MaxListenersExceededWarning".
**Why it happens:** The natural instinct is "connect client -> subscribe to events for that client." But EventEmitter listeners should be static; the dynamic part is the connections map.
**How to avoid:** Subscribe to `snapshot_changed` and `snapshot_removed` ONCE when the handler module initializes (or when the first connection arrives). Use the connections map to route events to the right clients. The listener count stays constant regardless of connection count.
**Warning signs:** "MaxListenersExceededWarning" in logs, memory growth proportional to connection count.

### Pitfall 2: Missing SPA Fallback Exclusion
**What goes wrong:** The Express SPA fallback in `server.ts` catches all GET requests that don't match API/health/WS paths and serves `index.html`. If `/snapshots` is not excluded, the HTTP upgrade request might be caught by the SPA handler before reaching the upgrade handler.
**Why it happens:** The SPA fallback is a catch-all `app.get('/{*splat}')` route.
**How to avoid:** Add `req.path === '/snapshots'` to the exclusion check in the SPA fallback, matching the existing exclusions for `/chat`, `/terminal`, `/dev-logs`.
**Warning signs:** WebSocket connections to `/snapshots` fail with HTTP 200 (HTML) instead of upgrading.

### Pitfall 3: Sending to Stale/Closing Connections
**What goes wrong:** A WebSocket connection enters CLOSING or CLOSED state, but it's still in the connections set. Attempting `ws.send()` throws an error.
**Why it happens:** There's a window between the WebSocket starting to close and the `close` event firing where the connection is still in the set.
**How to avoid:** Always check `ws.readyState === WS_READY_STATE.OPEN` before calling `ws.send()`. All existing handlers do this. Additionally, if `ws.send()` is called on a non-OPEN socket with the `ws` library v8, it queues and may silently fail, but checking readyState is defensive best practice.
**Warning signs:** "WebSocket is not open" errors in logs during fan-out.

### Pitfall 4: Race Between Connect and Store Event
**What goes wrong:** Client connects, full snapshot is sent, but between `getByProjectId()` and adding the connection to the set, a store event fires. The event is not routed to the new client (not yet in set), and the full snapshot already missed it.
**Why it happens:** The subscribe-then-send order matters.
**How to avoid:** Add the connection to the set FIRST, then send the full snapshot. If a store event fires between adding to set and sending the full, the client may receive a delta before the full -- but the full snapshot contains the latest state, so the client can reconcile. Alternatively, send full snapshot synchronously right after adding to set -- in Node.js's single-threaded event loop, no store event can fire between synchronous operations.
**Warning signs:** Client occasionally missing the very first change after connecting.

### Pitfall 5: Not Cleaning Up Empty Project Sets
**What goes wrong:** When the last client for a project disconnects, the empty `Set<WebSocket>` remains in the connections map. Over time, the map accumulates entries for projects that have no active clients.
**Why it happens:** Forgetting to delete the map entry when the set becomes empty.
**How to avoid:** In the `close` handler, after removing the WebSocket from the set, check `if (connections.size === 0)` and delete the map entry. This matches the pattern in `dev-logs.handler.ts` and `terminal.handler.ts`.
**Warning signs:** Memory leak proportional to total unique projects viewed over server lifetime.

### Pitfall 6: Serializing Large Snapshots Blocks Event Loop
**What goes wrong:** If a project has many workspaces (50+), `JSON.stringify()` of the full snapshot array might take non-trivial time, blocking the event loop during fan-out.
**Why it happens:** JSON serialization is synchronous.
**How to avoid:** Pre-serialize the message string ONCE and send the same string to all clients in the project set, rather than serializing per-client. For the full snapshot on connect, this is a single serialization. For deltas, the message is small (one workspace entry). This is already the natural approach and a non-issue for typical project sizes (<100 workspaces).
**Warning signs:** Event loop lag during reconciliation (which upserts all workspaces rapidly).

### Pitfall 7: Store Events During Reconciliation Causing Message Floods
**What goes wrong:** When reconciliation runs (every 60s), it upserts ALL workspaces, each triggering a `snapshot_changed` event. If the client doesn't handle rapid updates well, it gets flooded.
**Why it happens:** The event collector has coalescing (150ms debounce), but reconciliation calls `upsert()` directly for each workspace.
**How to avoid:** This is acceptable behavior -- the client should handle rapid updates. The entries already have a `version` field that increases monotonically. The client can use this to detect stale messages. Alternatively, consider batching reconciliation updates on the transport side, but this adds complexity. For v1, individual messages per workspace is fine.
**Warning signs:** UI flickering or performance issues every 60 seconds.

## Code Examples

### Complete Handler Structure
```typescript
// Source: Following patterns from dev-logs.handler.ts + terminal.handler.ts

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import { WS_READY_STATE } from '@/backend/constants';
import {
  SNAPSHOT_CHANGED,
  SNAPSHOT_REMOVED,
  type SnapshotChangedEvent,
  type SnapshotRemovedEvent,
  workspaceSnapshotStore,
} from '@/backend/services';
import { type AppContext, createAppContext } from '../../app-context';
import { getOrCreateConnectionSet, markWebSocketAlive, sendBadRequest } from './upgrade-utils';

// ============================================================================
// Types
// ============================================================================

export type SnapshotConnectionsMap = Map<string, Set<WebSocket>>;

// ============================================================================
// State
// ============================================================================

export const snapshotConnections: SnapshotConnectionsMap = new Map();

// ============================================================================
// Store Event Fan-Out
// ============================================================================

let storeSubscriptionActive = false;

function ensureStoreSubscription(
  connections: SnapshotConnectionsMap,
  logger: ReturnType<AppContext['services']['createLogger']>
): void {
  if (storeSubscriptionActive) return;
  storeSubscriptionActive = true;

  workspaceSnapshotStore.on(SNAPSHOT_CHANGED, (event: SnapshotChangedEvent) => {
    const projectClients = connections.get(event.projectId);
    if (!projectClients || projectClients.size === 0) return;

    const message = JSON.stringify({
      type: 'snapshot_changed',
      workspaceId: event.workspaceId,
      entry: event.entry,
    });

    for (const ws of projectClients) {
      if (ws.readyState === WS_READY_STATE.OPEN) {
        ws.send(message);
      }
    }
  });

  workspaceSnapshotStore.on(SNAPSHOT_REMOVED, (event: SnapshotRemovedEvent) => {
    const projectClients = connections.get(event.projectId);
    if (!projectClients || projectClients.size === 0) return;

    const message = JSON.stringify({
      type: 'snapshot_removed',
      workspaceId: event.workspaceId,
    });

    for (const ws of projectClients) {
      if (ws.readyState === WS_READY_STATE.OPEN) {
        ws.send(message);
      }
    }
  });

  logger.info('Snapshot WebSocket store subscription active');
}

// ============================================================================
// Upgrade Handler
// ============================================================================

export function createSnapshotsUpgradeHandler(appContext: AppContext) {
  const logger = appContext.services.createLogger('snapshots-handler');

  // Set up store subscription once
  ensureStoreSubscription(snapshotConnections, logger);

  return function handleSnapshotsUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
    wss: WebSocketServer,
    wsAliveMap: WeakMap<WebSocket, boolean>
  ): void {
    const projectId = url.searchParams.get('projectId');
    if (!projectId) {
      logger.warn('Snapshots WebSocket missing projectId');
      sendBadRequest(socket);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      logger.info('Snapshots WebSocket connection established', { projectId });
      markWebSocketAlive(ws, wsAliveMap);

      // Add to connection set FIRST (before sending full snapshot)
      getOrCreateConnectionSet(snapshotConnections, projectId).add(ws);

      // Send full project snapshot (WSKT-02, WSKT-05)
      const entries = workspaceSnapshotStore.getByProjectId(projectId);
      ws.send(JSON.stringify({
        type: 'snapshot_full',
        projectId,
        entries,
      }));

      ws.on('close', () => {
        logger.info('Snapshots WebSocket connection closed', { projectId });
        const connections = snapshotConnections.get(projectId);
        if (connections) {
          connections.delete(ws);
          if (connections.size === 0) {
            snapshotConnections.delete(projectId);
          }
        }
      });

      ws.on('error', (error) => {
        logger.error('Snapshots WebSocket error', error);
      });
    });
  };
}

export const handleSnapshotsUpgrade = createSnapshotsUpgradeHandler(createAppContext());
```

### Server.ts Modifications
```typescript
// Source: server.ts existing pattern

// 1. Import
import {
  createChatUpgradeHandler,
  createDevLogsUpgradeHandler,
  createSnapshotsUpgradeHandler, // NEW
  createTerminalUpgradeHandler,
} from './routers/websocket';

// 2. Create handler
const snapshotsUpgradeHandler = createSnapshotsUpgradeHandler(context);

// 3. Add to upgrade handler
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '', `http://${request.headers.host}`);

  if (url.pathname === '/chat') { /* ... */ return; }
  if (url.pathname === '/terminal') { /* ... */ return; }
  if (url.pathname === '/dev-logs') { /* ... */ return; }

  if (url.pathname === '/snapshots') {
    snapshotsUpgradeHandler(request, socket, head, url, wss, wsAliveMap);
    return;
  }

  socket.destroy();
});

// 4. Add to SPA fallback exclusion
app.get('/{*splat}', (req, res, next) => {
  if (
    req.path.startsWith('/api') ||
    req.path.startsWith('/mcp') ||
    req.path.startsWith('/health') ||
    req.path === '/chat' ||
    req.path === '/terminal' ||
    req.path === '/dev-logs' ||
    req.path === '/snapshots'  // NEW
  ) {
    return next();
  }
  // ... serve index.html ...
});

// 5. Add to server endpoints log
logger.info('Server endpoints available', {
  // ... existing ...
  wsSnapshots: `ws://localhost:${actualPort}/snapshots`,
});
```

### Barrel Export Update (index.ts)
```typescript
// Source: src/backend/routers/websocket/index.ts

export {
  createSnapshotsUpgradeHandler,
  handleSnapshotsUpgrade,
  snapshotConnections,
} from './snapshots.handler';
```

### Test Pattern: Verifying Full Snapshot on Connect
```typescript
// Source: Following pattern from dev-logs.handler.test.ts

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WS_READY_STATE } from '@/backend/constants';

class MockWebSocket extends EventEmitter {
  readyState = WS_READY_STATE.OPEN;
  send = vi.fn();
  close = vi.fn();
  terminate = vi.fn();
}

describe('createSnapshotsUpgradeHandler', () => {
  it('sends full snapshot on connect', () => {
    // Mock workspaceSnapshotStore.getByProjectId to return test entries
    // Create handler, simulate upgrade, verify ws.send called with snapshot_full
  });

  it('routes snapshot_changed events to correct project clients', () => {
    // Create two connections for different projects
    // Emit snapshot_changed for project A
    // Verify only project A's client received the message
  });

  it('sends snapshot_removed when workspace is removed', () => {
    // Connect client, emit snapshot_removed, verify message
  });

  it('rejects connection without projectId', () => {
    // Call handler without projectId, verify sendBadRequest called
  });

  it('cleans up connection set on close', () => {
    // Connect, then emit close, verify connection removed from map
  });

  it('does not send to non-OPEN sockets', () => {
    // Connect, set readyState to CLOSED, emit event, verify send not called
  });
});
```

### Test Pattern: Verifying Project Isolation (WSKT-04)
```typescript
it('clients subscribed to different projects do not receive each other updates', () => {
  // Connect client A to project-1
  // Connect client B to project-2
  // Emit snapshot_changed for project-1
  // Verify client A received the message
  // Verify client B did NOT receive the message
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| tRPC polling from client every N seconds | WebSocket push on store change | v1.1 (Phase 15) | Near-instant UI updates; no polling overhead |
| Full project query on every poll | Full snapshot on connect, per-workspace deltas thereafter | v1.1 (Phase 15) | O(1) bandwidth per change instead of O(N) per poll |
| No project scoping for updates | Project-scoped WebSocket subscriptions | v1.1 (Phase 15) | Clients only receive data for their viewed project |

**Existing patterns preserved:**
- `createXxxUpgradeHandler(appContext)` factory pattern (all WS handlers)
- `Map<id, Set<WebSocket>>` connection tracking (terminal, dev-logs handlers)
- `markWebSocketAlive()` + `sendBadRequest()` utilities (upgrade-utils.ts)
- `WS_READY_STATE.OPEN` guard before `ws.send()` (all WS handlers)
- Module-level connection map export for testing (terminal, dev-logs handlers)

## Open Questions

1. **Should the store subscription be lazy or eager?**
   - What we know: The handler factory creates store subscriptions. If the factory runs at import time (via the default export), subscriptions are created even if no client ever connects.
   - What's unclear: Whether this matters for resource usage (EventEmitter listeners are cheap).
   - Recommendation: **Lazy initialization via `ensureStoreSubscription()` guard.** Call it in the factory function. The cost is negligible either way, but lazy is cleaner. The existing handlers (dev-logs, terminal) don't have background subscriptions, so there's no precedent to follow -- but since our subscription is on a singleton EventEmitter (no external resources), eager or lazy both work fine.

2. **Should there be message batching for reconciliation bursts?**
   - What we know: Reconciliation upserts all workspaces every 60s, each triggering a store event and thus a WebSocket message. For 50 workspaces, that's 50 messages in rapid succession.
   - What's unclear: Whether this causes UI performance issues.
   - Recommendation: **Skip for v1.** The messages are small (single workspace entry each), and modern browsers handle rapid WebSocket messages well. The client will need to batch React state updates anyway (React 18+ auto-batches). If profiling shows issues, add transport-level batching (collect messages for 16ms, send as array) in a follow-up.

3. **Should there be a shared TypeScript type for snapshot messages?**
   - What we know: The existing WS handlers define message types implicitly via JSON structure. The chat handler has explicit Zod schemas in `src/shared/websocket/` and `src/backend/schemas/websocket/`. Terminal has schemas too.
   - What's unclear: Whether a shared type in `src/shared/` is needed now or can wait for Phase 16 (client integration).
   - Recommendation: **Define the server message types in the handler file for now.** Export them so Phase 16 can import them. If a shared schema is needed (e.g., for Zod validation on the client), that's a Phase 16 concern. For this phase, the types are simple enough to define inline.

## Sources

### Primary (HIGH confidence)
- **Codebase analysis:** `src/backend/routers/websocket/dev-logs.handler.ts` -- closest analog; module-level connection map, service subscription pattern, send-on-connect pattern, cleanup pattern
- **Codebase analysis:** `src/backend/routers/websocket/terminal.handler.ts` -- connection map pattern (`Map<workspaceId, Set<WebSocket>>`), cleanup on close, `getOrCreateConnectionSet` usage
- **Codebase analysis:** `src/backend/routers/websocket/chat.handler.ts` -- upgrade handler factory pattern, `markWebSocketAlive` usage, error handling
- **Codebase analysis:** `src/backend/routers/websocket/upgrade-utils.ts` -- shared utilities: `sendBadRequest()`, `markWebSocketAlive()`, `getOrCreateConnectionSet()`
- **Codebase analysis:** `src/backend/routers/websocket/index.ts` -- barrel export pattern for WS handlers
- **Codebase analysis:** `src/backend/services/workspace-snapshot-store.service.ts` -- `SNAPSHOT_CHANGED`/`SNAPSHOT_REMOVED` event types, `SnapshotChangedEvent`/`SnapshotRemovedEvent` payloads, `getByProjectId()` method, `WorkspaceSnapshotEntry` type
- **Codebase analysis:** `src/backend/server.ts` -- upgrade handler registration pattern (lines 220-239), SPA fallback exclusions (lines 171-179), handler factory creation (lines 86-88), cleanup sequence
- **Codebase analysis:** `src/backend/constants/websocket.ts` -- `WS_READY_STATE` constants
- **Codebase analysis:** `src/backend/app-context.ts` -- `AppContext` type, `createAppContext()` for default exports
- **Codebase analysis:** `src/backend/routers/websocket/dev-logs.handler.test.ts` -- test patterns for WS handlers: MockWebSocket class, wss.handleUpgrade mock, readyState testing
- **Codebase analysis:** `package.json` -- `ws: ^8.19.0`, `@types/ws: ^8.18.1`

### Secondary (MEDIUM confidence)
- **Codebase analysis:** `src/backend/orchestration/event-collector.orchestrator.ts` -- event coalescing with 150ms debounce means store events are already rate-limited for event-driven updates
- **Codebase analysis:** `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts` -- reconciliation upserts all workspaces with pollStartTs, generating burst of store events every 60s
- **Prior research:** `.planning/phases/14-safety-net-reconciliation/14-RESEARCH.md` -- reconciliation patterns, startup ordering

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies; uses exclusively existing `ws` library and codebase patterns
- Architecture: HIGH -- direct application of existing handler pattern (3 precedents) with store EventEmitter (already implemented and tested)
- Pitfalls: HIGH -- identified from direct code analysis of existing handlers and store behavior; no speculative concerns
- Message format: HIGH -- follows established JSON + type-discriminator pattern from all existing WS handlers
- Server wiring: HIGH -- exact pattern exists in server.ts for 3 other handlers; mechanical addition

**Research date:** 2026-02-11
**Valid until:** 2026-03-11 (stable domain -- no external dependencies to change)
