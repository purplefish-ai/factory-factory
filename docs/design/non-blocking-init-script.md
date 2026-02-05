# Design: Non-Blocking Init Script Execution

**Issue:** [#561 - Allow users to start chatting before init script completes](https://github.com/purplefish-ai/factory-factory/issues/561)

**Author:** Claude Code
**Date:** 2026-02-05
**Status:** Draft - Awaiting Approval

---

## Problem Statement

Currently, when a user creates a new workspace with an init script configured, the UI shows a blocking overlay that prevents any interaction until the init script completes. While PR #556 improved this by showing the init script logs during this blocking period, users still cannot:

1. Start composing their first message to Claude
2. Navigate the workspace UI
3. Queue up messages while the script runs

This makes workspace creation feel slower than necessary, especially for projects with lengthy init scripts (npm install, docker builds, etc.).

## Goals

1. Allow users to start chatting immediately after workspace creation
2. Queue messages while init script runs, dispatch them automatically once ready
3. Show init script output in a dedicated "Init Logs" tab (similar to Dev Logs)
4. Maintain a responsive UI throughout the initialization process
5. Allow users to continue even if init script fails (non-blocking error)

## Non-Goals

- Changing how init scripts are executed (bash spawning, output streaming)
- Running init in an interactive terminal (too risky - user could accidentally close it)
- Requiring manual confirmation to send queued messages

---

## Solution Overview

Create an "Init Logs" panel (following the Dev Logs pattern) that displays init script output. Remove the blocking overlay for PROVISIONING state. Hold message dispatch until workspace is READY, then auto-dispatch queued messages.

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Init output display | New "Init Logs" tab (like Dev Logs) | Read-only, can't be accidentally closed, follows existing pattern |
| Auto-focus on init | Yes, focus Init Logs tab | User sees what's happening immediately |
| Message dispatch | Automatic when READY | Seamless UX, no manual confirmation needed |
| Failed init behavior | Non-blocking error banner | Users can still work even if init fails |
| Blocking overlay | Remove for PROVISIONING, keep for nothing | Fully non-blocking experience |

---

## Current Architecture

### Dev Logs Pattern (What We'll Follow)

The Dev Logs feature provides a good template:

```
┌─────────────────────────────────────────────────────────────────┐
│ Frontend                                                         │
│ ┌─────────────────┐    ┌──────────────────┐                     │
│ │ useDevLogs hook │───▶│ WebSocket        │                     │
│ │ - output state  │    │ /dev-logs        │                     │
│ │ - connected     │    │ ?workspaceId=... │                     │
│ └─────────────────┘    └────────┬─────────┘                     │
│         │                       │                                │
│         ▼                       │                                │
│ ┌─────────────────┐             │                                │
│ │ DevLogsPanel    │             │                                │
│ │ - renders output│             │                                │
│ └─────────────────┘             │                                │
└─────────────────────────────────┼───────────────────────────────┘
                                  │
┌─────────────────────────────────┼───────────────────────────────┐
│ Backend                         │                                │
│                    ┌────────────▼────────────┐                  │
│                    │ dev-logs.handler.ts     │                  │
│                    │ - sends output buffer   │                  │
│                    │ - subscribes to updates │                  │
│                    └────────────┬────────────┘                  │
│                                 │                                │
│                    ┌────────────▼────────────┐                  │
│                    │ runScriptService        │                  │
│                    │ - getOutputBuffer()     │                  │
│                    │ - subscribeToOutput()   │                  │
│                    └─────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────┘
```

### Current Init Script Flow

```
startup-script.service.ts
         │
         ▼
┌────────────────────────────────┐
│ executeScript()                │
│ - spawns bash process          │
│ - streams output via callback  │
│ - saves to workspace.initOutput│
│ - waits for completion         │
└────────────────────────────────┘
         │
         ▼
┌────────────────────────────────┐
│ workspaceAccessor              │
│ .appendInitOutput()            │
│ (debounced, 500ms / 4KB)       │
└────────────────────────────────┘
```

---

## Proposed Solution

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Frontend                                                         │
│ ┌──────────────────┐    ┌──────────────────┐                    │
│ │ useInitLogs hook │───▶│ WebSocket        │                    │
│ │ - output state   │    │ /init-logs       │  ◄── NEW           │
│ │ - connected      │    │ ?workspaceId=... │                    │
│ │ - status         │    └────────┬─────────┘                    │
│ └──────────────────┘             │                               │
│         │                        │                               │
│         ▼                        │                               │
│ ┌──────────────────┐             │                               │
│ │ InitLogsPanel    │  ◄── NEW    │                               │
│ │ - renders output │             │                               │
│ │ - shows status   │             │                               │
│ └──────────────────┘             │                               │
│                                  │                               │
│ ┌──────────────────┐             │                               │
│ │ InitStatusBanner │  ◄── NEW    │                               │
│ │ - non-blocking   │             │                               │
│ │ - error display  │             │                               │
│ └──────────────────┘             │                               │
└──────────────────────────────────┼──────────────────────────────┘
                                   │
┌──────────────────────────────────┼──────────────────────────────┐
│ Backend                          │                               │
│                     ┌────────────▼───────────┐                  │
│                     │ init-logs.handler.ts   │  ◄── NEW         │
│                     │ - sends output buffer  │                  │
│                     │ - sends status updates │                  │
│                     │ - subscribes to output │                  │
│                     └────────────┬───────────┘                  │
│                                  │                               │
│                     ┌────────────▼───────────┐                  │
│                     │ startupScriptService   │  (modified)      │
│                     │ - emit output events   │                  │
│                     │ - emit status events   │                  │
│                     └────────────────────────┘                  │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ chatMessageHandlerService (modified)                        │  │
│ │ - check workspace status before dispatch                    │  │
│ │ - hold messages if PROVISIONING                             │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ worktree-lifecycle.service (modified)                       │  │
│ │ - trigger dispatch when READY                               │  │
│ └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Detailed Implementation Plan

### Phase 1: Backend - Init Logs WebSocket Handler

**New file: `src/backend/routers/websocket/init-logs.handler.ts`**

Follow the `dev-logs.handler.ts` pattern:

```typescript
// Similar structure to dev-logs.handler.ts
export function createInitLogsUpgradeHandler(appContext: AppContext) {
  return function handleInitLogsUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
    wss: WebSocketServer,
    wsAliveMap: WeakMap<WebSocket, boolean>
  ): void {
    const workspaceId = url.searchParams.get('workspaceId');

    // 1. Send current workspace status (PROVISIONING, READY, FAILED)
    // 2. Send existing initOutput from database
    // 3. Subscribe to new output via startupScriptService
    // 4. Subscribe to status changes
  };
}
```

**Modify: `src/backend/services/startup-script.service.ts`**

Add event emitter pattern for real-time output streaming:

```typescript
class StartupScriptService {
  // NEW: Event emitters for real-time updates
  private outputSubscribers = new Map<string, Set<(data: string) => void>>();
  private statusSubscribers = new Map<string, Set<(status: WorkspaceStatus) => void>>();

  // NEW: In-memory output buffer (similar to runScriptService)
  private outputBuffers = new Map<string, string>();

  subscribeToOutput(workspaceId: string, callback: (data: string) => void): () => void;
  subscribeToStatus(workspaceId: string, callback: (status: WorkspaceStatus) => void): () => void;
  getOutputBuffer(workspaceId: string): string;
}
```

**Modify: `src/backend/routers/websocket/index.ts`**

Register the new WebSocket handler:

```typescript
// Add init-logs handler alongside dev-logs
if (pathname === '/init-logs') {
  handleInitLogsUpgrade(request, socket, head, url, initLogsWss, wsAliveMap);
  return;
}
```

### Phase 2: Backend - Hold Message Dispatch During PROVISIONING

**Modify: `src/backend/services/chat-message-handlers.service.ts`**

```typescript
async tryDispatchNextMessage(dbSessionId: string): Promise<void> {
  // ... existing guard logic ...

  // NEW: Check if workspace is ready before dispatching
  const session = await sessionRepository.findById(dbSessionId);
  if (session?.workspaceId) {
    const workspace = await workspaceAccessor.findById(session.workspaceId);
    if (workspace?.status === 'PROVISIONING' || workspace?.status === 'NEW') {
      // Workspace still initializing - keep message in queue
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Workspace not ready, holding message', {
          dbSessionId,
          status: workspace.status
        });
      }
      this.dispatchInProgress.set(dbSessionId, false);
      return; // Don't dequeue - leave message for later dispatch
    }
  }

  // ... rest of existing dispatch logic ...
}
```

### Phase 3: Backend - Trigger Dispatch When Ready

**Modify: `src/backend/services/worktree-lifecycle.service.ts`**

```typescript
// In the place where workspace transitions to READY
async function onWorkspaceReady(workspaceId: string): Promise<void> {
  // Find all sessions for this workspace
  const sessions = await sessionRepository.findByWorkspaceId(workspaceId);

  // Trigger dispatch for each session that has queued messages
  for (const session of sessions) {
    if (messageQueueService.hasMessages(session.id)) {
      logger.info('Dispatching queued messages after workspace ready', {
        workspaceId,
        sessionId: session.id,
        queueLength: messageQueueService.getQueueLength(session.id),
      });
      await chatMessageHandlerService.tryDispatchNextMessage(session.id);
    }
  }
}
```

### Phase 4: Frontend - Init Logs Hook and Panel

**New file: `src/components/workspace/use-init-logs.ts`**

```typescript
interface InitLogsMessage {
  type: 'output' | 'status';
  data?: string;
  status?: 'NEW' | 'PROVISIONING' | 'READY' | 'FAILED';
  errorMessage?: string;
}

interface UseInitLogsResult {
  connected: boolean;
  output: string;
  status: 'NEW' | 'PROVISIONING' | 'READY' | 'FAILED' | null;
  errorMessage: string | null;
  outputEndRef: React.RefObject<HTMLDivElement | null>;
}

export function useInitLogs(workspaceId: string): UseInitLogsResult {
  // Similar to useDevLogs but also tracks status
}
```

**New file: `src/components/workspace/init-logs-panel.tsx`**

```typescript
interface InitLogsPanelProps {
  output: string;
  status: 'NEW' | 'PROVISIONING' | 'READY' | 'FAILED' | null;
  errorMessage: string | null;
  outputEndRef: React.RefObject<HTMLDivElement | null>;
  className?: string;
}

export function InitLogsPanel({ output, status, errorMessage, outputEndRef, className }: InitLogsPanelProps) {
  return (
    <div className={cn('h-full bg-background', className)}>
      {/* Status indicator at top */}
      {status === 'PROVISIONING' && (
        <div className="flex items-center gap-2 px-4 py-2 bg-blue-500/10 border-b border-blue-500/20">
          <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
          <span className="text-sm text-blue-400">Running setup script...</span>
        </div>
      )}
      {status === 'READY' && (
        <div className="flex items-center gap-2 px-4 py-2 bg-green-500/10 border-b border-green-500/20">
          <CheckCircle className="h-4 w-4 text-green-500" />
          <span className="text-sm text-green-400">Setup complete</span>
        </div>
      )}
      {status === 'FAILED' && (
        <div className="flex items-center gap-2 px-4 py-2 bg-red-500/10 border-b border-red-500/20">
          <AlertTriangle className="h-4 w-4 text-red-500" />
          <span className="text-sm text-red-400">Setup failed: {errorMessage}</span>
        </div>
      )}

      {/* Output log */}
      <div className="h-full overflow-y-auto font-mono text-xs p-4 bg-black text-white">
        <pre className="whitespace-pre-wrap break-words">
          {output || 'Waiting for setup script output...'}
        </pre>
        <div ref={outputEndRef} />
      </div>
    </div>
  );
}
```

### Phase 5: Frontend - Integrate Init Logs Tab

**Modify: `src/components/workspace/right-panel.tsx`**

Add "Init Logs" as a new bottom panel tab (alongside Terminal and Dev Logs):

```typescript
type BottomPanelTab = 'terminal' | 'dev-logs' | 'init-logs';

// In component:
const initLogs = useInitLogs(workspaceId);

// Show Init Logs tab with status indicator
<TabButton
  label="Init Logs"
  icon={
    <span className={cn(
      'w-1.5 h-1.5 rounded-full',
      initLogs.status === 'PROVISIONING' && 'bg-blue-500 animate-pulse',
      initLogs.status === 'READY' && 'bg-green-500',
      initLogs.status === 'FAILED' && 'bg-red-500',
      !initLogs.status && 'bg-gray-500'
    )} />
  }
  isActive={activeBottomTab === 'init-logs'}
  onSelect={() => handleBottomTabChange('init-logs')}
/>
```

### Phase 6: Frontend - Auto-Focus Init Logs Tab

**Modify: `src/components/workspace/right-panel.tsx`**

Auto-switch to Init Logs when workspace is PROVISIONING:

```typescript
// Auto-focus Init Logs tab when workspace is provisioning
useEffect(() => {
  if (initLogs.status === 'PROVISIONING') {
    handleBottomTabChange('init-logs');
  }
}, [initLogs.status]);
```

### Phase 7: Frontend - Remove Blocking Overlay

**Modify: `src/client/routes/projects/workspaces/workspace-overlays.tsx`**

Remove the overlay entirely - we no longer need it since the Init Logs tab handles display:

```typescript
export function InitializationOverlay({ status, ... }) {
  // Only render for FAILED if we want a blocking error state
  // But per requirements, we want non-blocking, so return null
  return null;
}
```

**Modify: `src/client/routes/projects/workspaces/workspace-detail-container.tsx`**

Remove or simplify the `isInitializing` checks that show the overlay.

### Phase 8: Frontend - Non-Blocking Error Banner

**New component or modify existing:**

Show a dismissible error banner when init fails, but don't block the UI:

```typescript
// In workspace-detail-chat-content.tsx or similar
{workspace?.status === 'FAILED' && (
  <div className="bg-red-500/10 border-b border-red-500/20 px-4 py-2 flex items-center justify-between">
    <div className="flex items-center gap-2">
      <AlertTriangle className="h-4 w-4 text-red-500" />
      <span className="text-sm text-red-400">
        Setup script failed. You can still use this workspace.
      </span>
    </div>
    <Button variant="outline" size="sm" onClick={handleRetryInit}>
      Retry Setup
    </Button>
  </div>
)}
```

---

## File Changes Summary

### New Files
| File | Description |
|------|-------------|
| `src/backend/routers/websocket/init-logs.handler.ts` | WebSocket handler for init log streaming |
| `src/components/workspace/use-init-logs.ts` | React hook for init logs WebSocket |
| `src/components/workspace/init-logs-panel.tsx` | UI component for displaying init logs |

### Modified Files
| File | Changes |
|------|---------|
| `src/backend/services/startup-script.service.ts` | Add event emitters, output buffer |
| `src/backend/routers/websocket/index.ts` | Register init-logs handler |
| `src/backend/services/chat-message-handlers.service.ts` | Check workspace status before dispatch |
| `src/backend/services/worktree-lifecycle.service.ts` | Trigger dispatch on READY |
| `src/components/workspace/right-panel.tsx` | Add Init Logs tab, auto-focus logic |
| `src/client/routes/projects/workspaces/workspace-overlays.tsx` | Remove blocking overlay |
| `src/client/routes/projects/workspaces/workspace-detail-container.tsx` | Remove overlay usage |

---

## Testing Plan

### Unit Tests

1. **startup-script.service.test.ts**
   - Event subscription and unsubscription
   - Output buffer management
   - Status event emission

2. **chat-message-handlers.service.test.ts**
   - Messages held when workspace is PROVISIONING
   - Messages dispatched when workspace is READY
   - Messages dispatched immediately when workspace is already READY

3. **worktree-lifecycle.service.test.ts**
   - Queued messages dispatched on READY transition

### Integration Tests

1. Create workspace with init script → verify Init Logs tab shows output
2. Queue message during PROVISIONING → verify dispatch on READY
3. Init script failure → verify error banner, user can still chat
4. Multiple queued messages → verify FIFO dispatch order

### Manual Testing Checklist

- [ ] Create workspace with slow init script (`sleep 30 && echo done`)
- [ ] Verify Init Logs tab auto-focuses
- [ ] Verify chat UI is interactive during init
- [ ] Send message → verify "Queued" indicator
- [ ] Init completes → verify message auto-dispatches
- [ ] Create workspace with failing init (`exit 1`)
- [ ] Verify error banner appears, chat still works
- [ ] Retry init from banner → verify it works

---

## Rollout Plan

1. **Feature flag (optional):** Could gate behind `ENABLE_NON_BLOCKING_INIT` env var
2. **Backward compatible:** Existing workspaces unaffected
3. **No database migration needed:** Uses existing `initOutput` field

---

## Open Questions (Resolved)

| Question | Resolution |
|----------|------------|
| Auto-focus terminal during init? | Yes, auto-focus Init Logs tab |
| What if user closes init terminal? | N/A - using read-only Init Logs panel, not terminal |
| Queued messages visual state? | Already implemented in `queued-messages.tsx` |
| Message dispatch timing? | Automatic when status becomes READY |
| Failed init UX? | Non-blocking error banner, user can continue |

---

## References

- [PR #556 - Show init script logs during workspace creation](https://github.com/purplefish-ai/factory-factory/pull/556)
- [Issue #561 - Allow users to start chatting before init script completes](https://github.com/purplefish-ai/factory-factory/issues/561)
- `src/components/workspace/dev-logs-panel.tsx` - Pattern to follow
- `src/backend/routers/websocket/dev-logs.handler.ts` - Pattern to follow
