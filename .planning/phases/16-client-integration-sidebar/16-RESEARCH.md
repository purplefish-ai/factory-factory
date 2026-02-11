# Phase 16: Client Integration - Sidebar - Research

**Researched:** 2026-02-11
**Domain:** WebSocket-to-React-Query integration for sidebar real-time updates
**Confidence:** HIGH

## Summary

Phase 16 replaces the sidebar's 2-second tRPC polling loop (`getProjectSummaryState` with `refetchInterval: 2000`) with WebSocket-pushed snapshot data from the Phase 15 `/snapshots` endpoint. The core task is connecting the WebSocket transport (already operational) to the React Query cache so that existing consumers of `getProjectSummaryState` data read fresh values without any refetch.

The codebase already has all the building blocks: (1) a mature `useWebSocketTransport` hook with exponential backoff reconnection, (2) the `buildWebSocketUrl` utility for constructing WebSocket URLs with query params, (3) the `/snapshots` server endpoint that sends `snapshot_full` on connect and `snapshot_changed`/`snapshot_removed` deltas on store changes, and (4) extensive use of `utils.trpc.xxx.setData()` for optimistic cache updates throughout the frontend. The new work is: create a custom hook that opens a `/snapshots` WebSocket, processes incoming messages, maps snapshot entries to the `getProjectSummaryState` query cache shape, and calls `setData` on each update.

The key challenge is the **shape mismatch** between `WorkspaceSnapshotEntry` (from the snapshot store) and the `ServerWorkspace` type (returned by `getProjectSummaryState`). These types overlap ~90% but have small differences: `WorkspaceSnapshotEntry` includes `version`, `computedAt`, `source`, `fieldTimestamps`, `kanbanColumn`, `flowPhase`, `ciObservation` fields that `ServerWorkspace` doesn't use directly, while `getProjectSummaryState` returns `createdAt` as a `Date` (vs ISO string) and includes `stateComputedAt` and `cachedKanbanColumn` fields with slightly different names. A mapping function is needed. The snapshot also does not include `reviewCount` (it's a per-project GitHub metric, not per-workspace), so the existing `reviewCount` value must be preserved from the previous cache state.

**Primary recommendation:** Create a `useProjectSnapshotSync` hook that connects to `/snapshots` via `useWebSocketTransport`, maps incoming snapshot entries to the `getProjectSummaryState` cache shape, and calls `utils.workspace.getProjectSummaryState.setData()` on each message. Keep the existing `getProjectSummaryState` query but change `refetchInterval` to a longer safety-net interval (30s-60s) instead of removing it entirely. The hook should be mounted in the `AppSidebar` component alongside the existing query.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `useWebSocketTransport` | (codebase) | WebSocket connection with auto-reconnect | All existing WS consumers use it (`use-dev-logs.ts`, `use-chat-websocket.ts`) |
| `buildWebSocketUrl` | (codebase) | Construct WS URL with query params | Used by all WS hooks, handles ws/wss protocol selection |
| `trpc.useUtils()` / `utils.xxx.setData()` | (codebase) | React Query cache manipulation | 7+ existing usages in the codebase for optimistic updates |
| React Query / @tanstack/react-query | (project dep) | Data fetching + cache layer | Project standard, configured in `TRPCProvider` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Vitest | (project) | Co-located unit tests | Testing the mapping function and hook behavior |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `setData` on existing query key | Separate query key for WS data | Would require refactoring all sidebar consumers; `setData` is simpler and non-breaking |
| Remove polling entirely | Keep safety-net poll | Without safety-net, a missed WS message or store bug leaves stale state forever; "event + poll" is a stated prior decision |
| Custom WebSocket hook | `useWebSocketTransport` | Would duplicate reconnection/backoff logic already battle-tested |

**Installation:**
No new packages needed. All dependencies already exist in the project.

## Architecture Patterns

### Recommended Project Structure
```
src/frontend/hooks/
  use-project-snapshot-sync.ts      # NEW: WebSocket snapshot -> React Query cache sync hook
  use-project-snapshot-sync.test.ts # NEW: Co-located tests

src/frontend/lib/
  snapshot-to-sidebar.ts            # NEW: Mapping function WorkspaceSnapshotEntry -> ServerWorkspace
  snapshot-to-sidebar.test.ts       # NEW: Tests for shape mapping

vite.config.ts                      # MODIFIED: add /snapshots proxy entry
```

### Pattern 1: WebSocket-to-Cache Sync Hook
**What:** A React hook that connects to the `/snapshots` WebSocket, receives snapshot messages, maps them to the `getProjectSummaryState` cache shape, and calls `setData` to update the React Query cache. This pattern means existing consumers (the sidebar, kanban board, workspace items) all get updated automatically without any component changes.
**When to use:** When real-time data from a WebSocket should update an existing React Query cache entry.
**Example:**
```typescript
// Source: Codebase pattern combining useWebSocketTransport + setData

import { useCallback } from 'react';
import { useWebSocketTransport } from '@/hooks/use-websocket-transport';
import { buildWebSocketUrl } from '@/lib/websocket-config';
import { trpc } from '@/frontend/lib/trpc';
import { mapSnapshotEntryToServerWorkspace } from '@/frontend/lib/snapshot-to-sidebar';

export function useProjectSnapshotSync(projectId: string | undefined) {
  const utils = trpc.useUtils();

  const url = projectId
    ? buildWebSocketUrl('/snapshots', { projectId })
    : null;

  const handleMessage = useCallback(
    (data: unknown) => {
      const message = data as SnapshotServerMessage;

      if (message.type === 'snapshot_full') {
        // Full snapshot: replace entire cache entry
        utils.workspace.getProjectSummaryState.setData(
          { projectId: message.projectId },
          (prev) => ({
            workspaces: message.entries.map(mapSnapshotEntryToServerWorkspace),
            reviewCount: prev?.reviewCount ?? 0, // Preserve reviewCount
          })
        );
      }

      if (message.type === 'snapshot_changed') {
        // Delta: upsert single workspace in cache
        utils.workspace.getProjectSummaryState.setData(
          { projectId: projectId! },
          (prev) => {
            if (!prev) return prev;
            const mapped = mapSnapshotEntryToServerWorkspace(message.entry);
            const existing = prev.workspaces.findIndex(w => w.id === message.workspaceId);
            const workspaces = [...prev.workspaces];
            if (existing >= 0) {
              workspaces[existing] = mapped;
            } else {
              workspaces.push(mapped);
            }
            return { ...prev, workspaces };
          }
        );
      }

      if (message.type === 'snapshot_removed') {
        // Remove workspace from cache
        utils.workspace.getProjectSummaryState.setData(
          { projectId: projectId! },
          (prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              workspaces: prev.workspaces.filter(w => w.id !== message.workspaceId),
            };
          }
        );
      }
    },
    [projectId, utils]
  );

  useWebSocketTransport({
    url,
    onMessage: handleMessage,
    queuePolicy: 'drop', // Snapshot sync is receive-only; no outbound queue needed
  });
}
```

### Pattern 2: Shape Mapping Function (SnapshotEntry -> ServerWorkspace)
**What:** A pure function that maps a `WorkspaceSnapshotEntry` to the shape expected by the sidebar's `ServerWorkspace` type. This function handles the naming differences (`kanbanColumn` -> `cachedKanbanColumn`, ISO string -> Date for `createdAt`, etc.).
**When to use:** Every time a snapshot message is processed.
**Example:**
```typescript
// Source: Derived from comparing WorkspaceSnapshotEntry and getProjectSummaryState return types

import type { WorkspaceSnapshotEntry } from '@/backend/services/workspace-snapshot-store.service';
import type { ServerWorkspace } from '@/frontend/components/use-workspace-list-state';

export function mapSnapshotEntryToServerWorkspace(entry: WorkspaceSnapshotEntry): ServerWorkspace {
  return {
    id: entry.workspaceId,
    name: entry.name,
    createdAt: entry.createdAt, // Both accept string
    branchName: entry.branchName,
    prUrl: entry.prUrl,
    prNumber: entry.prNumber,
    prState: entry.prState,
    prCiStatus: entry.prCiStatus,
    isWorking: entry.isWorking,
    gitStats: entry.gitStats,
    lastActivityAt: entry.lastActivityAt,
    ratchetEnabled: entry.ratchetEnabled,
    ratchetState: entry.ratchetState,
    sidebarStatus: entry.sidebarStatus,
    ratchetButtonAnimated: entry.ratchetButtonAnimated,
    flowPhase: entry.flowPhase,
    ciObservation: entry.ciObservation,
    runScriptStatus: entry.runScriptStatus,
    cachedKanbanColumn: entry.kanbanColumn,
    stateComputedAt: entry.computedAt,
    pendingRequestType: entry.pendingRequestType,
  };
}
```

### Pattern 3: Safety-Net Polling (Demoted Frequency)
**What:** Keep the existing `getProjectSummaryState` query but increase `refetchInterval` from 2000ms to 30000-60000ms. This ensures correctness even if WebSocket messages are missed (network issues, store bugs, reconnection gaps). This is a stated prior decision: "event-driven + safety-net poll."
**When to use:** Always -- the polling query remains the fallback.
**Example:**
```typescript
// In AppSidebar component:
const { data: projectStateData } = trpc.workspace.getProjectSummaryState.useQuery(
  { projectId: selectedProjectId ?? '' },
  {
    enabled: !!selectedProjectId && !isMocked,
    refetchInterval: isMocked ? false : 30_000, // Changed from 2000 to 30000
  }
);

// Mount the sync hook alongside
useProjectSnapshotSync(selectedProjectId && !isMocked ? selectedProjectId : undefined);
```

### Pattern 4: Vite Proxy for WebSocket in Development
**What:** Add a `/snapshots` entry to the Vite dev server proxy config so WebSocket connections are forwarded to the backend during development.
**When to use:** Required for development mode to work.
**Example:**
```typescript
// vite.config.ts
server: {
  proxy: {
    // ... existing entries ...
    '/snapshots': {
      target: backendUrl.replace(/^http/, 'ws'),
      ws: true,
    },
  },
},
```

### Pattern 5: Message Type Definitions (Client-Side)
**What:** Define TypeScript types for the three server-to-client snapshot message types. These should match the server's message format exactly.
**When to use:** For type-safe message handling in the sync hook.
**Example:**
```typescript
// These types match what the server sends in snapshots.handler.ts
import type { WorkspaceSnapshotEntry } from '@/backend/services/workspace-snapshot-store.service';

export type SnapshotServerMessage =
  | { type: 'snapshot_full'; projectId: string; entries: WorkspaceSnapshotEntry[] }
  | { type: 'snapshot_changed'; workspaceId: string; entry: WorkspaceSnapshotEntry }
  | { type: 'snapshot_removed'; workspaceId: string };
```

### Anti-Patterns to Avoid
- **Removing the tRPC query entirely:** The sidebar currently uses `getProjectSummaryState` for both `workspaces` and `reviewCount`. The WebSocket snapshot does NOT include `reviewCount`. Removing the query breaks the reviews badge. Keep the query at a reduced poll rate.
- **Creating a new query key for WS data and changing all consumers:** This would require touching every component that reads workspace data. Using `setData` on the existing query key is non-breaking.
- **Opening the WebSocket in every component that needs workspace data:** The sync hook should be mounted once (in `AppSidebar` or at the project layout level), not in every consumer. React Query's cache sharing handles the rest.
- **Ignoring the `prev` parameter in `setData`:** The `snapshot_changed` handler must merge with the existing cache (upsert one workspace), not replace the entire array. The `snapshot_full` handler should preserve `reviewCount` from the previous cache.
- **Not handling the case where `setData` is called before the query has fetched initially:** If the WebSocket connects and sends data before `getProjectSummaryState` has completed its first fetch, `setData` will set the cache to the WS data (which lacks `reviewCount`). The `prev` parameter will be `undefined`. Handle this by defaulting `reviewCount` to 0.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| WebSocket connection with reconnection | Custom reconnection logic | `useWebSocketTransport` hook | Already handles exponential backoff, jitter, intentional close, cleanup, message queuing |
| WebSocket URL construction | Manual URL building | `buildWebSocketUrl('/snapshots', { projectId })` | Handles ws/wss protocol, host detection, query params |
| React Query cache updates | Custom state management | `utils.workspace.getProjectSummaryState.setData()` | Automatically notifies all subscribers, handles cache deduplication |
| JSON message parsing | Custom parser | `useWebSocketTransport` does JSON.parse internally | Already handles parse errors silently |

**Key insight:** This phase is almost entirely "glue code" connecting the existing WebSocket transport hook to the existing React Query cache. The WebSocket handler (Phase 15), the transport hook, the React Query setup, and the sidebar components already exist. The new code is: (1) a ~50-line mapping function, (2) a ~60-line sync hook, (3) a one-line change to mount the hook, (4) a one-line change to `refetchInterval`, (5) a one-line change to `vite.config.ts`.

## Common Pitfalls

### Pitfall 1: reviewCount Lost on snapshot_full
**What goes wrong:** The `snapshot_full` message contains workspace entries but no `reviewCount`. If `setData` replaces the entire cache without preserving `reviewCount`, the review badge in the sidebar disappears.
**Why it happens:** The snapshot store is workspace-centric; `reviewCount` is a per-project GitHub metric fetched separately by `getProjectSummaryState`.
**How to avoid:** In the `setData` callback for `snapshot_full`, use the `prev` parameter to preserve `reviewCount`: `{ workspaces: mapped, reviewCount: prev?.reviewCount ?? 0 }`.
**Warning signs:** Reviews badge showing 0 after every WebSocket message, then flashing the correct count after the safety-net poll runs.

### Pitfall 2: Stale Cache After Reconnection
**What goes wrong:** WebSocket disconnects, client misses updates, then reconnects. If only deltas were processed (no full snapshot on reconnect), the cache remains stale.
**Why it happens:** Deltas assume the client has a complete baseline. If messages were missed during disconnection, the baseline is incomplete.
**How to avoid:** This is already handled by the Phase 15 design: every WebSocket connect (including reconnect) sends a `snapshot_full` message. The client sync hook processes this as a full cache replacement (preserving `reviewCount`). The `useWebSocketTransport` hook handles reconnection automatically.
**Warning signs:** N/A -- this is handled by design, but verify in tests that `snapshot_full` properly replaces stale data.

### Pitfall 3: Race Between setData and refetch
**What goes wrong:** A WebSocket message arrives and calls `setData`, but a millisecond later the safety-net poll completes and overwrites the WebSocket data with potentially older server data (because the DB query is slower than the in-memory snapshot).
**Why it happens:** React Query's `refetchInterval` runs independently of `setData`. If the refetch returns slightly stale data, it overwrites the more recent WS-pushed data.
**How to avoid:** Set a high `staleTime` on the query (e.g., 25000ms when `refetchInterval` is 30000ms). This means after `setData` marks the cache as fresh, the poll won't overwrite it for 25 seconds. Alternatively, increase `refetchInterval` to 60s to make this race extremely unlikely. The safety-net poll should be rare enough that it almost never races with WS updates.
**Warning signs:** Sidebar state flickering back and forth every 30 seconds.

### Pitfall 4: Missing Vite Proxy for /snapshots
**What goes wrong:** In development mode, WebSocket connections to `/snapshots` fail because Vite doesn't know to proxy them to the backend.
**Why it happens:** The Vite config currently proxies `/chat`, `/terminal`, `/dev-logs` but not `/snapshots`.
**How to avoid:** Add `/snapshots` to the Vite proxy config with `ws: true`.
**Warning signs:** WebSocket connections fail with 404 in development mode but work in production.

### Pitfall 5: Multiple Hook Instances Causing Duplicate Connections
**What goes wrong:** If `useProjectSnapshotSync` is mounted in multiple places (e.g., both `AppSidebar` and `ProjectLayout`), multiple WebSocket connections open to the same `/snapshots?projectId=X` endpoint.
**Why it happens:** Each hook instance creates its own `useWebSocketTransport` connection.
**How to avoid:** Mount the hook in exactly one place. `AppSidebar` is the natural location since it's the component that selects the project and consumes the sidebar data. Do NOT mount it in `ProjectLayout` or other places.
**Warning signs:** Double WebSocket connections visible in browser DevTools Network tab, double message processing.

### Pitfall 6: createdAt Type Mismatch
**What goes wrong:** The `getProjectSummaryState` query returns `createdAt` as a Prisma `Date` object (via superjson). The snapshot store returns `createdAt` as an ISO string. If the mapping function passes a string where a Date is expected, sorting or comparison logic may break.
**Why it happens:** The sidebar's `ServerWorkspace` type declares `createdAt: string | Date`, so both are accepted. But `getCreatedAtMs()` in `use-workspace-list-state.ts` handles both cases (instanceof Date check + string parsing). The mapping should pass the string as-is.
**How to avoid:** The `ServerWorkspace` type already handles both `string | Date`. The mapping function should pass `entry.createdAt` (ISO string) directly. The `getCreatedAtMs` helper already handles both.
**Warning signs:** Workspace ordering bugs in the sidebar (newest first sorting broken).

## Code Examples

Verified patterns from the existing codebase:

### Using useWebSocketTransport (from use-dev-logs.ts)
```typescript
// Source: src/components/workspace/use-dev-logs.ts

const url = buildWebSocketUrl('/dev-logs', { workspaceId });

const { connected } = useWebSocketTransport({
  url,
  onMessage: handleMessage,
  onConnected: handleConnected,
  onDisconnected: handleDisconnected,
  queuePolicy: 'drop',
});
```

### Using setData for cache updates (from app-sidebar.tsx)
```typescript
// Source: src/frontend/components/app-sidebar.tsx (lines 335-345)

const updateWorkspaceOrder = trpc.userSettings.updateWorkspaceOrder.useMutation({
  onMutate: async ({ projectId, workspaceIds }) => {
    await utils.userSettings.getWorkspaceOrder.cancel({ projectId });
    const previousOrder = utils.userSettings.getWorkspaceOrder.getData({ projectId });
    utils.userSettings.getWorkspaceOrder.setData({ projectId }, workspaceIds);
    return { previousOrder };
  },
});
```

### The Current 2-Second Polling Query (what we're replacing)
```typescript
// Source: src/frontend/components/app-sidebar.tsx (lines 297-300)

const { data: projectStateData } = trpc.workspace.getProjectSummaryState.useQuery(
  { projectId: selectedProjectId ?? '' },
  { enabled: !!selectedProjectId && !isMocked, refetchInterval: isMocked ? false : 2000 }
);
```

### WebSocket Server Message Types (from Phase 15 handler)
```typescript
// Source: src/backend/routers/websocket/snapshots.handler.ts

// Three message types sent from server:
// 1. snapshot_full - sent on every connect/reconnect
//    { type: 'snapshot_full', projectId: string, entries: WorkspaceSnapshotEntry[] }
//
// 2. snapshot_changed - sent on each workspace update
//    { type: 'snapshot_changed', workspaceId: string, entry: WorkspaceSnapshotEntry }
//
// 3. snapshot_removed - sent when workspace is archived/deleted
//    { type: 'snapshot_removed', workspaceId: string }
```

### WorkspaceSnapshotEntry Fields Relevant to Sidebar
```typescript
// Source: src/backend/services/workspace-snapshot-store.service.ts

// Fields the sidebar uses from WorkspaceSnapshotEntry:
// workspaceId -> id
// name, createdAt, branchName, prUrl, prNumber, prState, prCiStatus
// isWorking, gitStats, lastActivityAt
// ratchetEnabled, ratchetState
// sidebarStatus (pre-derived: { activityState, ciState })
// ratchetButtonAnimated, flowPhase, ciObservation
// runScriptStatus
// kanbanColumn -> cachedKanbanColumn
// computedAt -> stateComputedAt
// pendingRequestType
```

### How AppSidebar Consumes the Data (flow)
```
AppSidebar
  -> trpc.workspace.getProjectSummaryState.useQuery({ projectId })
  -> returns { workspaces: ServerWorkspace[], reviewCount: number }
  -> workspaces passed to useWorkspaceListState(serverWorkspaces)
  -> produces sorted WorkspaceListItem[] with UI states (normal/creating/archiving)
  -> rendered by WorkspaceList -> SortableWorkspaceItem/StaticWorkspaceItem
  -> each item uses: workspace-sidebar-items.tsx (ActiveWorkspaceItem)
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| 2-second tRPC polling for sidebar | WebSocket push + safety-net poll (30-60s) | v1.1 (Phase 16) | ~200ms update latency instead of 0-2000ms; reduced server load |
| Server computes all workspace state on each poll | In-memory snapshot store with pre-derived state | v1.1 (Phase 11-14) | No DB queries for sidebar updates; state pushed from store events |
| No WebSocket for workspace state | Project-scoped /snapshots endpoint | v1.1 (Phase 15) | Full snapshot on connect, per-workspace deltas on change |

## Open Questions

1. **Where should the `useProjectSnapshotSync` hook be mounted?**
   - What we know: It must be mounted exactly once per project. `AppSidebar` is the primary consumer and already has the `selectedProjectId`.
   - What's unclear: Should it be in `AppSidebar` itself, or lifted to a higher level (e.g., `TRPCProvider` or `RootLayout`)? If lifted, it would benefit the kanban board too (which also polls `listWithKanbanState` at 15s).
   - Recommendation: **Mount in `AppSidebar` for Phase 16.** This is the simplest change with the smallest blast radius. Phase 17 (kanban integration) can lift it if needed. The sidebar is always rendered when projects exist, so the hook will always be active when needed.

2. **Should the snapshot sync also update `listWithKanbanState` cache?**
   - What we know: The kanban board uses `trpc.workspace.listWithKanbanState.useQuery` with a 15s poll. The snapshot entries contain `kanbanColumn` which maps to the kanban view's data needs.
   - What's unclear: Whether the kanban board's data shape can be fully satisfied by snapshot entries.
   - Recommendation: **Out of scope for Phase 16.** The phase description explicitly targets the sidebar. Phase 17 handles kanban/other views. Do not update `listWithKanbanState` cache in this phase.

3. **Should there be a shared TypeScript type for snapshot messages?**
   - What we know: Phase 15 defines message types implicitly in the handler. The client needs matching types.
   - What's unclear: Whether to put types in `src/shared/` or in the hook file.
   - Recommendation: **Define types in the hook file or in a co-located types file.** The snapshot message types are simple (3 variants) and used only by the sync hook. If Phase 17 needs them too, they can be moved to `src/shared/` at that time.

4. **How does the `getProjectSummaryState` return shape handle superjson serialization?**
   - What we know: The tRPC client uses superjson for serialization. `createdAt` is returned as a Prisma `Date`, which superjson serializes/deserializes as a `Date` object on the client. Snapshot entries send `createdAt` as an ISO string.
   - What's unclear: Whether the React Query cache expects a `Date` object or whether a string works in practice.
   - Recommendation: **The `ServerWorkspace` type already declares `createdAt: string | Date`.** The `getCreatedAtMs()` helper handles both. Pass the ISO string from the snapshot entry directly. This is safe.

## Sources

### Primary (HIGH confidence)
- **Codebase analysis:** `src/frontend/components/app-sidebar.tsx` -- sidebar component with 2s `getProjectSummaryState` polling (line 299), project selection, workspace list consumption
- **Codebase analysis:** `src/frontend/components/use-workspace-list-state.ts` -- `ServerWorkspace` type definition (lines 11-38), `WorkspaceListItem` extends it with `uiState`, sorting logic, optimistic create/archive states
- **Codebase analysis:** `src/frontend/components/workspace-sidebar-items.tsx` -- sidebar item components that consume `WorkspaceListItem` fields (status dot, ratchet toggle, PR button, CI badge, git stats)
- **Codebase analysis:** `src/hooks/use-websocket-transport.ts` -- `useWebSocketTransport` hook with reconnection, queuePolicy, connected state (used by chat, terminal, dev-logs)
- **Codebase analysis:** `src/lib/websocket-config.ts` -- `buildWebSocketUrl()`, `getReconnectDelay()`, `MAX_RECONNECT_ATTEMPTS`
- **Codebase analysis:** `src/frontend/lib/providers.tsx` -- `TRPCProvider` with `QueryClient` configuration (`staleTime: 5000`, `refetchOnWindowFocus: false`)
- **Codebase analysis:** `src/frontend/lib/trpc.ts` -- tRPC client setup with httpBatchLink and superjson
- **Codebase analysis:** `src/backend/services/workspace-snapshot-store.service.ts` -- `WorkspaceSnapshotEntry` type (lines 74-123), field shape, event types
- **Codebase analysis:** `src/backend/routers/websocket/snapshots.handler.ts` -- server-side message format for `snapshot_full`, `snapshot_changed`, `snapshot_removed`
- **Codebase analysis:** `src/backend/domains/workspace/query/workspace-query.service.ts` -- `getProjectSummaryState` return shape (lines 179-222): `{ workspaces: [...], reviewCount }`
- **Codebase analysis:** `vite.config.ts` -- proxy config for `/chat`, `/terminal`, `/dev-logs` (missing `/snapshots`)
- **Codebase analysis:** `src/components/workspace/use-dev-logs.ts` -- closest analog for receive-only WS hook pattern with `useWebSocketTransport` and `queuePolicy: 'drop'`
- **Phase 15 docs:** `.planning/phases/15-websocket-transport/15-RESEARCH.md`, `15-01-PLAN.md`, `15-01-SUMMARY.md`, `15-VERIFICATION.md` -- complete Phase 15 implementation details

### Secondary (MEDIUM confidence)
- **Codebase analysis:** `src/frontend/components/app-sidebar.tsx` lines 335-345 -- `setData` usage pattern for optimistic cache updates (workspace ordering)
- **Codebase analysis:** `src/client/routes/projects/workspaces/use-workspace-detail.ts` lines 183-192 -- `setData` usage pattern for optimistic cache updates (session list)
- **Codebase analysis:** 7 call sites of `getProjectSummaryState.invalidate()` across the codebase -- shows which mutations trigger sidebar refreshes; these will still work alongside WS updates

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies; exclusively uses existing hooks and React Query patterns from the codebase
- Architecture: HIGH -- direct application of existing `useWebSocketTransport` + `setData` patterns; shape mapping is mechanical
- Pitfalls: HIGH -- identified from direct code analysis of type mismatches, race conditions, and proxy config; all verifiable
- Shape mapping: HIGH -- both types (`WorkspaceSnapshotEntry` and `getProjectSummaryState` return) are fully documented in the codebase with exact field lists

**Research date:** 2026-02-11
**Valid until:** 2026-03-11 (stable domain -- all components are internal codebase patterns)
