# Session Tracking Architecture

This document explains how Conductor tracks active Claude sessions and keeps the UI up to date.

## Overview

There are **two parallel mechanisms** for tracking session state:

1. **Polling (tRPC queries)** - Used by sidebar/kanban to show which workspaces have active sessions
2. **WebSocket (real-time)** - Used by chat panel to show real-time processing status for the current session

## Backend Session State

### In-Memory Process Tracking

`SessionService` (`src/backend/services/session.service.ts`) maintains an in-memory map of active Claude processes:

```typescript
const activeClaudeProcesses = new Map<string, ClaudeProcess>();
```

Key methods:
- `startClaudeSession(sessionId)` - Spawns process, adds to map, sets DB status to `RUNNING`
- `stopClaudeSession(sessionId)` - Gracefully stops process, removes from map, sets DB status to `IDLE`
- `isSessionWorking(sessionId)` - Returns `true` if process status is `'running'`
- `isAnySessionWorking(sessionIds[])` - Batch check for multiple sessions

### Process Status Lifecycle

`ClaudeProcess` (`src/backend/claude/process.ts`) tracks a status field:

| Status | Meaning |
|--------|---------|
| `starting` | Process spawned, waiting for initialization |
| `ready` | Initialized, idle/waiting for user input |
| `running` | **Actively processing** (message exchange happening) |
| `exited` | Process terminated |

Status transitions based on message types:
- `assistant` or `user` message → `running`
- `result` message → `ready`

**Important:** A session is considered "working" only when status is `'running'` - meaning Claude is actively thinking/executing, not just that a process exists.

### Database Session Status

The database stores a separate `SessionStatus` enum (`IDLE`, `RUNNING`, `PAUSED`, `COMPLETED`, `FAILED`) for persistence, but the real-time "working" status comes from the in-memory process state.

## API Contract

### Polling Endpoints (tRPC)

```typescript
// Unified sidebar state (workspaces + working status + git stats + review count)
workspace.getProjectSummaryState({ projectId }) → {
  workspaces: Array<{
    id: string;
    name: string;
    branchName: string | null;
    prUrl: string | null;
    prNumber: number | null;
    prState: PRState;
    prCiStatus: CIStatus;
    isWorking: boolean;
    gitStats: { total, additions, deletions, hasUncommitted } | null;
  }>;
  reviewCount: number;
}
```

This endpoint queries the in-memory `SessionService` for working status (not the database).

### WebSocket Protocol

The `/chat` WebSocket sends status messages:

```typescript
// When session receives session_id (process ready and working):
{ type: 'status', running: true }

// When Claude returns a 'result' (turn complete, waiting for input):
{ type: 'status', running: false }
```

Additional session lifecycle messages:
- `{ type: 'starting' }` - Process is spinning up
- `{ type: 'started' }` - Process started successfully
- `{ type: 'stopped' }` - Process was stopped
- `{ type: 'process_exit', code }` - Process exited

## Frontend Implementation

### Sidebar (Unified Polling)

`app-sidebar.tsx` polls for all sidebar data every 2 seconds via a single unified endpoint:

```typescript
const { data: projectState } = trpc.workspace.getProjectSummaryState.useQuery(
  { projectId: selectedProjectId ?? '' },
  { enabled: !!selectedProjectId, refetchInterval: 2000 }
);

const workspaces = projectState?.workspaces;
const reviewCount = projectState?.reviewCount ?? 0;
```

Each workspace object includes `isWorking` and `gitStats` directly, eliminating the need for separate lookups. The spinning green indicator uses `workspace.isWorking`.

### Chat Panel (WebSocket)

`useChatWebSocket` hook maintains local `running` state that updates in real-time:

```typescript
// Handler for 'status' messages:
function handleStatusMessage(data, ctx) {
  ctx.setRunning(data.running ?? false);
}

// Also set to false when 'result' message received:
if (claudeMsg.type === 'result') {
  ctx.setRunning(false);
}
```

This `running` state drives:
- Status dot color (yellow pulsing when processing)
- Input field disable state
- "Claude is thinking..." placeholder
- Loading indicator

### Tab/Session Tracking

Each open workspace establishes its own WebSocket connection:
- URL includes `sessionId` (database session ID) and `connectionId` (unique per browser window)
- Backend maintains `Map<sessionId, Set<WebSocket>>` to route messages
- Tab switches trigger reconnect with new session ID, backend sends history with current `running` status

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        BACKEND                                   │
│                                                                  │
│  SessionService                    WebSocket Handler             │
│  ┌─────────────────────┐          ┌─────────────────────────┐   │
│  │ activeClaudeProcesses│          │ Per-session connections │   │
│  │ Map<sessionId,       │◄────────►│ Map<sessionId,          │   │
│  │     ClaudeProcess>   │          │     Set<WebSocket>>     │   │
│  └─────────────────────┘          └─────────────────────────┘   │
│         ▲                                    │                   │
│         │ isAnySessionWorking()              │ {type:'status',   │
│         │ returns status==='running'         │  running: bool}   │
│         │                                    ▼                   │
└─────────┼────────────────────────────────────────────────────────┘
          │                                    │
     tRPC Query                           WebSocket
     (every 2s)                           (real-time)
          │                                    │
┌─────────┼────────────────────────────────────┼───────────────────┐
│         ▼                                    ▼                   │
│  ┌─────────────────┐               ┌─────────────────────────┐  │
│  │ Sidebar         │               │ Chat Panel              │  │
│  │                 │               │ useChatWebSocket hook   │  │
│  │ projectState:   │               │                         │  │
│  │   workspaces[]  │               │ running: boolean        │  │
│  │   reviewCount   │               │ (per-session state)     │  │
│  │                 │               │                         │  │
│  └─────────────────┘               └─────────────────────────┘  │
│                                                                  │
│                         FRONTEND                                 │
└──────────────────────────────────────────────────────────────────┘
```

## Current Polling Summary

The sidebar uses a single unified endpoint:

| Query | Interval | Purpose |
|-------|----------|---------|
| `workspace.getProjectSummaryState` | 2s | All sidebar data (workspaces, working status, git stats, review count) |

The workspace detail page polls:
| Query | Interval | Purpose |
|-------|----------|---------|
| `workspace.get` | 10s | Single workspace details |
| `session.listClaudeSessions` | 5s | Sessions list for workspace |
| `workspace.getGitStatus` | 5s | Detailed git status (right panel) |

---

## Improvement Opportunities

### ~~1. Unified World State Endpoint~~ ✅ IMPLEMENTED

**Implemented as `workspace.getProjectSummaryState`** - The sidebar now uses a single endpoint that returns:
- Workspaces with `isWorking` status (from SessionService)
- Git stats per workspace (total, additions, deletions, hasUncommitted)
- PR review count for badge

This replaced 4 separate endpoints (`workspace.list`, `session.getWorkspacesWorkingStatus`, `workspace.getBatchGitStats`, `prReview.listReviewRequests`) with a single 2-second polling call.

### 2. Push-Based Updates via WebSocket

**Problem:** 1-second polling for working status is wasteful when most workspaces are idle.

**Proposal:** Use WebSocket for workspace state changes:
- Keep a single "world state" WebSocket connection per browser window
- Backend pushes updates when:
  - Any session starts/stops (working status change)
  - Git status changes (after tool calls that modify files)
  - PR status changes (webhook from GitHub)

**Trade-offs:**
- More complex backend (need to track which workspaces each client cares about)
- Need fallback polling for reliability
- May be overkill if polling is fast enough

### 3. Smarter Polling with Staleness Hints

**Problem:** Fixed intervals don't adapt to activity.

**Proposal:** Backend returns "next poll hint" with responses:
```typescript
{
  data: { ... },
  pollHint: {
    suggestedInterval: 5000,  // No activity, slow down
    staleAfter: 10000,        // Data definitely stale after this
  }
}
```

- When sessions are active, suggest 1s polling
- When idle, suggest 10-30s polling
- Client adjusts `refetchInterval` dynamically

### 4. Consolidate Session Queries

**Problem:** Workspace detail page queries sessions separately from workspace.

**Proposal:** Include sessions in workspace response:
```typescript
workspace.get({ id, includeSessions: true }) → {
  ...workspace,
  sessions?: ClaudeSession[];
}
```

### 5. Server-Sent Events (SSE) for Simpler Push

**Alternative to WebSocket:** If full duplex isn't needed for world state, SSE is simpler:
- Backend sends events when state changes
- No need to manage bidirectional connection
- Better browser support for reconnection
- Could coexist with existing WebSocket for chat

### Recommended Next Steps

1. ~~**Quick win:** Merge endpoints into unified state~~ ✅ Done
2. **Medium effort:** Add push-based updates for working status changes
3. **Longer term:** Smarter polling with staleness hints or SSE for state changes
