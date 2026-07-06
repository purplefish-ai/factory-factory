# 🔔 Workspace Agent Completion Notification System - Implementation Proposal

## Executive Summary

**Goal:** Notify user via OS desktop notification when all Claude sessions in a workspace finish working, but only when the app window is not focused or the chat is not visible.

**Key Design Decisions:**
- ✅ OS desktop notification (using existing `notification.service.ts`)
- ✅ Per-workspace scope (all sessions must finish)
- ✅ Suppress when app window is focused OR chat is visible

## Architecture Overview

### Components to Modify/Create

```
Backend:
├── src/backend/services/workspace-activity.service.ts (NEW)
│   └── Tracks running state of all sessions per workspace
├── src/backend/routers/websocket/chat.handler.ts (MODIFY)
│   └── Emit workspace-level events when session state changes
└── src/backend/services/notification.service.ts (MODIFY)
    └── Add workspace completion notification method

Frontend:
├── src/client/hooks/use-window-focus.ts (NEW)
│   └── Track browser/Electron window focus state
└── src/components/workspace/WorkspaceNotificationManager.tsx (NEW)
    └── Listen for workspace events and trigger notifications

Electron:
└── electron/main/index.ts (MODIFY)
    └── Expose window focus state to renderer
```

### Component Interaction Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           WORKSPACE WITH SESSIONS                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                      │
│  │  Session 1   │  │  Session 2   │  │  Session 3   │                      │
│  │  (running)   │  │  (running)   │  │   (idle)     │                      │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘                      │
│         │                 │                                                 │
└─────────┼─────────────────┼─────────────────────────────────────────────────┘
          │                 │
          │  session_id     │  result
          │  event          │  event
          ▼                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        BACKEND (Node.js/Express)                            │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │  chat.handler.ts (WebSocket Handler)                               │    │
│  │  ┌──────────────────────────────────────────────────────────────┐ │    │
│  │  │  setupChatClientEvents()                                      │ │    │
│  │  │                                                               │ │    │
│  │  │  client.on('session_id') ────────────┐                       │ │    │
│  │  │  client.on('result')     ────────┐   │                       │ │    │
│  │  └──────────────────────────────────┼───┼───────────────────────┘ │    │
│  └─────────────────────────────────────┼───┼─────────────────────────┘    │
│                                        │   │                               │
│                        ┌───────────────┘   └───────────────┐               │
│                        │ markSessionRunning()   markSessionIdle()          │
│                        ▼                                    │               │
│  ┌─────────────────────────────────────────────────────────┼──────────┐    │
│  │  workspace-activity.service.ts                          │          │    │
│  │  ┌────────────────────────────────────────────────────┐ │          │    │
│  │  │  workspaceStates Map                               │ │          │    │
│  │  │  {                                                 │ │          │    │
│  │  │    workspaceId: {                                 │ │          │    │
│  │  │      runningSessions: Map<sessionId, generation>,  ◄──────────┼─┘    │    │
│  │  │      lastActivityAt: Date                         │ │            │    │
│  │  │    }                                              │ │            │    │
│  │  │  }                                                │ │            │    │
│  │  └────────────────────────────────────────────────────┘ │            │    │
│  │                                                         │            │    │
│  │  ┌────────────────────────────────────────────────────┐ │            │    │
│  │  │  Event: 'workspace_idle'                          │ │            │    │
│  │  │  (emitted when runningSessions.size === 0)        │ │            │    │
│  │  └──────────────────────────┬─────────────────────────┘ │            │    │
│  └─────────────────────────────┼───────────────────────────┘            │    │
│                                │                                         │    │
│                                ▼                                         │    │
│  ┌─────────────────────────────────────────────────────────────────┐    │    │
│  │  workspace_idle event handler                                   │    │    │
│  │  ┌──────────────────────────────────────────────────────────┐  │    │    │
│  │  │  1. Query workspace by ID                                │  │    │    │
│  │  │  2. Emit 'request_notification' with:                    │  │    │    │
│  │  │     - workspaceId                                        │  │    │    │
│  │  │     - workspaceName                                      │  │    │    │
│  │  │     - sessionCount                                       │  │    │    │
│  │  └──────────────────────────────────────────────────────────┘  │    │    │
│  └──────────────────────────────┬──────────────────────────────────┘    │    │
│                                 │                                        │    │
│                                 ▼                                        │    │
│  ┌─────────────────────────────────────────────────────────────────┐    │    │
│  │  setupWorkspaceNotifications()                                  │    │    │
│  │  ┌──────────────────────────────────────────────────────────┐  │    │    │
│  │  │  Listen to 'request_notification'                        │  │    │    │
│  │  │  Broadcast to all WebSocket clients viewing workspace:  │  │    │    │
│  │  │  {                                                       │  │    │    │
│  │  │    type: 'workspace_notification_request',              │  │    │    │
│  │  │    workspaceId, workspaceName, sessionCount             │  │    │    │
│  │  │  }                                                       │  │    │    │
│  │  └──────────────────────────────────────────────────────────┘  │    │    │
│  └──────────────────────────────┬──────────────────────────────────┘    │    │
└─────────────────────────────────┼───────────────────────────────────────┘    │
                                  │                                            │
                                  │ WebSocket Message                          │
                                  │                                            │
                                  ▼                                            │
┌─────────────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (React/Browser)                             │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  use-chat-websocket.ts                                              │   │
│  │  ┌──────────────────────────────────────────────────────────────┐  │   │
│  │  │  ws.onmessage handler                                        │  │   │
│  │  │  ┌────────────────────────────────────────────────────────┐ │  │   │
│  │  │  │  if (type === 'workspace_notification_request')        │ │  │   │
│  │  │  │    dispatch CustomEvent('workspace-notification-req')  │ │  │   │
│  │  │  └────────────────────────────────────────────────────────┘ │  │   │
│  │  └──────────────────────────────────────────────────────────────┘  │   │
│  └────────────────────────────────┬────────────────────────────────────┘   │
│                                   │                                        │
│                                   │ CustomEvent                            │
│                                   ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  WorkspaceNotificationManager.tsx                                   │   │
│  │  ┌──────────────────────────────────────────────────────────────┐  │   │
│  │  │  Listen to 'workspace-notification-request' event           │  │   │
│  │  │                                                              │  │   │
│  │  │  ┌────────────────────────────────────────────────────────┐ │  │   │
│  │  │  │  SUPPRESSION LOGIC CHECK:                             │ │  │   │
│  │  │  │                                                        │ │  │   │
│  │  │  │  isWindowFocused ◄──── use-window-focus.ts ◄────┐     │ │  │   │
│  │  │  │       ↓                        ▲                │     │ │  │   │
│  │  │  │  isChatVisible ← location.pathname              │     │ │  │   │
│  │  │  │       ↓                                         │     │ │  │   │
│  │  │  │  shouldSuppress = isWindowFocused || visible    │     │ │  │   │
│  │  │  │       ↓                                         │     │ │  │   │
│  │  │  │  if (shouldSuppress) return; ───────────────────┘     │ │  │   │
│  │  │  │       ↓                                               │ │  │   │
│  │  │  │  else: sendWorkspaceNotification()                    │ │  │   │
│  │  │  └────────────────────────────────────────────────────────┘ │  │   │
│  │  └──────────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────┬───────────────────────────────────┘   │
│                                    │                                       │
│                                    ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Browser Notification API                                           │   │
│  │  ┌──────────────────────────────────────────────────────────────┐  │   │
│  │  │  new Notification('Workspace Ready: My Feature')            │  │   │
│  │  │    body: 'All 2 agents finished...'                         │  │   │
│  │  │    icon: '/favicon.ico'                                     │  │   │
│  │  └──────────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                        ┌───────────────────────┐
                        │   OS NOTIFICATION     │
                        │  ┌─────────────────┐  │
                        │  │ 🔔 Workspace    │  │
                        │  │    Ready: ...   │  │
                        │  └─────────────────┘  │
                        └───────────────────────┘
```

### Detailed Event Flow

**Scenario: Two sessions in a workspace, both finish sequentially**

```
Time  │ Event                          │ Component                    │ State Change
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T0    │ Session 1 starts processing    │ ClaudeClient                 │
      │ emits 'session_id'             │                              │
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T1    │ chat.handler receives event    │ chat.handler.ts              │
      │ calls markSessionRunning()     │ setupChatClientEvents()      │
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T2    │ Add session1 to runningSet     │ workspace-activity.service   │ runningSessions:
      │                                │                              │ Set { session1 }
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T3    │ Session 2 starts processing    │ ClaudeClient                 │
      │ emits 'session_id'             │                              │
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T4    │ chat.handler receives event    │ chat.handler.ts              │
      │ calls markSessionRunning()     │ setupChatClientEvents()      │
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T5    │ Add session2 to runningSet     │ workspace-activity.service   │ runningSessions:
      │                                │                              │ Set { s1, s2 }
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T6    │ Session 1 finishes             │ ClaudeClient                 │
      │ emits 'result'                 │                              │
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T7    │ chat.handler receives result   │ chat.handler.ts              │
      │ calls markSessionIdle()        │ setupChatClientEvents()      │
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T8    │ Remove session1 from runningSet│ workspace-activity.service   │ runningSessions:
      │ Check: size === 0? NO          │                              │ Set { s2 }
      │ NO notification triggered      │                              │ (still running)
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T9    │ Session 2 finishes             │ ClaudeClient                 │
      │ emits 'result'                 │                              │
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T10   │ chat.handler receives result   │ chat.handler.ts              │
      │ calls markSessionIdle()        │ setupChatClientEvents()      │
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T11   │ Remove session2 from runningSet│ workspace-activity.service   │ runningSessions:
      │ Check: size === 0? YES         │                              │ Set {}
      │ ✅ Emit 'workspace_idle'       │                              │ (ALL DONE!)
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T12   │ workspace_idle handler runs    │ workspace-activity.service   │
      │ Query workspace from DB        │ event listener               │
      │ Emit 'request_notification'    │                              │
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T13   │ Broadcast to WebSocket clients │ setupWorkspaceNotifications()│
      │ type: workspace_notification_  │ chat.handler.ts              │
      │       request                  │                              │
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T14   │ WebSocket receives message     │ use-chat-websocket.ts        │
      │ Dispatch CustomEvent           │ Frontend                     │
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T15   │ WorkspaceNotificationManager   │ WorkspaceNotificationManager │
      │ receives CustomEvent           │ .tsx                         │
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T16   │ Check suppression logic:       │ WorkspaceNotificationManager │
      │ - isWindowFocused? NO          │ .tsx                         │
      │ - isChatVisible? NO            │                              │
      │ - shouldSuppress? NO           │                              │
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T17   │ ✅ Call new Notification()     │ Browser Notification API     │
      │ Display OS notification        │                              │
──────┼────────────────────────────────┼──────────────────────────────┼──────────────────
T18   │ 🔔 User sees notification!     │ Operating System             │
      │                                │                              │
```

### Sequence Diagrams

#### Flow 1: Session Starts Running (No Notification)

```
┌──────────┐  ┌──────────────┐  ┌────────────────────────┐  ┌─────────────────┐
│  Claude  │  │ chat.handler │  │ workspace-activity     │  │   WebSocket     │
│  Client  │  │    .ts       │  │      .service.ts       │  │   Clients       │
└────┬─────┘  └──────┬───────┘  └───────────┬────────────┘  └────────┬────────┘
     │               │                      │                        │
     │ session_id    │                      │                        │
     │───────────────>                      │                        │
     │               │                      │                        │
     │               │ markSessionRunning() │                        │
     │               │─────────────────────>│                        │
     │               │                      │                        │
     │               │                      │ Add to runningSet      │
     │               │                      │ Set { session1 }       │
     │               │                      │                        │
     │               │ forwardToConnections()                        │
     │               │──────────────────────────────────────────────>│
     │               │  { type: 'status',                            │
     │               │    running: true }                            │
     │               │                      │                        │
     │               │                      │                        │
     │     User sees "Claude is thinking..."                         │
     │               │                      │                        │
```

#### Flow 2: Multiple Sessions - First Finishes (No Notification)

```
┌──────────┐  ┌──────────────┐  ┌────────────────────────┐  ┌─────────────────┐
│  Claude  │  │ chat.handler │  │ workspace-activity     │  │   WebSocket     │
│ Client 1 │  │    .ts       │  │      .service.ts       │  │   Clients       │
└────┬─────┘  └──────┬───────┘  └───────────┬────────────┘  └────────┬────────┘
     │               │                      │                        │
     │               │          State: runningSessions =              │
     │               │          Set { session1, session2 }            │
     │               │                      │                        │
     │  result       │                      │                        │
     │───────────────>                      │                        │
     │               │                      │                        │
     │               │ markSessionIdle()    │                        │
     │               │─────────────────────>│                        │
     │               │                      │                        │
     │               │                      │ Remove session1        │
     │               │                      │ Set { session2 }       │
     │               │                      │                        │
     │               │                      │ Check: size === 0?     │
     │               │                      │   NO ✗                 │
     │               │                      │                        │
     │               │                      │ (No event emitted)     │
     │               │                      │                        │
     │               │ forwardToConnections()                        │
     │               │──────────────────────────────────────────────>│
     │               │  { type: 'status',                            │
     │               │    running: false }                           │
     │               │                      │                        │
     │               │                      │                        │
     │     Session 1 done, but Session 2 still running...            │
     │               │                      │                        │
```

#### Flow 3: Last Session Finishes - Notification Triggered (Window Unfocused)

```
┌──────────┐  ┌──────────────┐  ┌────────────────────────┐  ┌─────────────────┐  ┌──────────────────┐  ┌──────────┐
│  Claude  │  │ chat.handler │  │ workspace-activity     │  │   WebSocket     │  │  Notification    │  │    OS    │
│ Client 2 │  │    .ts       │  │      .service.ts       │  │   Clients       │  │    Manager.tsx   │  │          │
└────┬─────┘  └──────┬───────┘  └───────────┬────────────┘  └────────┬────────┘  └────────┬─────────┘  └────┬─────┘
     │               │                      │                        │                    │                 │
     │  result       │                      │                        │                    │                 │
     │───────────────>                      │                        │                    │                 │
     │               │                      │                        │                    │                 │
     │               │ markSessionIdle()    │                        │                    │                 │
     │               │─────────────────────>│                        │                    │                 │
     │               │                      │                        │                    │                 │
     │               │                      │ Remove session2        │                    │                 │
     │               │                      │ Set {}                 │                    │                 │
     │               │                      │                        │                    │                 │
     │               │                      │ Check: size === 0?     │                    │                 │
     │               │                      │   YES ✓                │                    │                 │
     │               │                      │                        │                    │                 │
     │               │                      │ emit('workspace_idle') │                    │                 │
     │               │                      │────────┐               │                    │                 │
     │               │                      │        │               │                    │                 │
     │               │                      │<───────┘               │                    │                 │
     │               │                      │                        │                    │                 │
     │               │                      │ Query workspace from DB                     │                 │
     │               │                      │ (get name, sessionCount)                    │                 │
     │               │                      │                        │                    │                 │
     │               │                      │ emit('request_notification')                │                 │
     │               │                      │────────┐               │                    │                 │
     │               │                      │        │               │                    │                 │
     │               │<─────────────────────┼────────┘               │                    │                 │
     │               │                      │                        │                    │                 │
     │               │ setupWorkspaceNotifications()                 │                    │                 │
     │               │   listener receives event                     │                    │                 │
     │               │                      │                        │                    │                 │
     │               │ Broadcast to WebSocket clients                │                    │                 │
     │               │──────────────────────────────────────────────>│                    │                 │
     │               │  {                   │                        │                    │                 │
     │               │    type: 'workspace_notification_request',    │                    │                 │
     │               │    workspaceId: 'ws-123',                     │                    │                 │
     │               │    workspaceName: 'My Feature',               │                    │                 │
     │               │    sessionCount: 2                            │                    │                 │
     │               │  }                   │                        │                    │                 │
     │               │                      │                        │                    │                 │
     │               │                      │                        │ CustomEvent        │                 │
     │               │                      │                        │ ('workspace-       │                 │
     │               │                      │                        │  notification-     │                 │
     │               │                      │                        │  request')         │                 │
     │               │                      │                        │───────────────────>│                 │
     │               │                      │                        │                    │                 │
     │               │                      │                        │                    │ Check:          │
     │               │                      │                        │                    │ isWindowFocused?│
     │               │                      │                        │                    │   NO ✗          │
     │               │                      │                        │                    │                 │
     │               │                      │                        │                    │ Check:          │
     │               │                      │                        │                    │ isChatVisible?  │
     │               │                      │                        │                    │   NO ✗          │
     │               │                      │                        │                    │                 │
     │               │                      │                        │                    │ shouldSuppress? │
     │               │                      │                        │                    │   NO ✗          │
     │               │                      │                        │                    │                 │
     │               │                      │                        │                    │ new Notification()
     │               │                      │                        │                    │────────────────>│
     │               │                      │                        │                    │                 │
     │               │                      │                        │                    │                 │
     │               │                      │                        │                    │    🔔 Display   │
     │               │                      │                        │                    │                 │
     │               │                      │                        │                    │                 │
```

#### Flow 4: Last Session Finishes - Notification Suppressed (Window Focused)

```
┌──────────┐  ┌──────────────┐  ┌────────────────────────┐  ┌─────────────────┐  ┌──────────────────┐
│  Claude  │  │ chat.handler │  │ workspace-activity     │  │   WebSocket     │  │  Notification    │
│ Client 2 │  │    .ts       │  │      .service.ts       │  │   Clients       │  │    Manager.tsx   │
└────┬─────┘  └──────┬───────┘  └───────────┬────────────┘  └────────┬────────┘  └────────┬─────────┘
     │               │                      │                        │                    │
     │  result       │                      │                        │                    │
     │───────────────>                      │                        │                    │
     │               │                      │                        │                    │
     │               │ markSessionIdle()    │                        │                    │
     │               │─────────────────────>│                        │                    │
     │               │                      │                        │                    │
     │               │                      │ Remove session2        │                    │
     │               │                      │ Set {}                 │                    │
     │               │                      │                        │                    │
     │               │                      │ emit('workspace_idle') │                    │
     │               │                      │                        │                    │
     │               │                      │ emit('request_notification')                │
     │               │                      │                        │                    │
     │               │ Broadcast workspace_notification_request      │                    │
     │               │──────────────────────────────────────────────>│                    │
     │               │                      │                        │                    │
     │               │                      │                        │ CustomEvent        │
     │               │                      │                        │───────────────────>│
     │               │                      │                        │                    │
     │               │                      │                        │                    │ Check:          │
     │               │                      │                        │                    │ isWindowFocused?│
     │               │                      │                        │                    │   YES ✓         │
     │               │                      │                        │                    │                 │
     │               │                      │                        │                    │ shouldSuppress? │
     │               │                      │                        │                    │   YES ✓         │
     │               │                      │                        │                    │                 │
     │               │                      │                        │                    │ return;         │
     │               │                      │                        │                    │ (suppressed)    │
     │               │                      │                        │                    │                 │
     │                                                                                                      │
     │     ℹ️  User is actively looking at the app - no notification needed                                │
     │               │                      │                        │                    │                 │
```

#### Flow 5: Window Focus Detection (Electron)

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
│  Electron    │  │   Electron   │  │  use-window- │  │  Notification    │
│  Main Window │  │   Preload    │  │  focus.ts    │  │    Manager.tsx   │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘
       │                 │                 │                    │
       │                 │                 │ useEffect() mount  │
       │                 │                 │<───────────────────│
       │                 │                 │                    │
       │                 │ onWindowFocusChanged(callback)       │
       │                 │<────────────────┼────────────────────│
       │                 │                 │                    │
       │                 │ ipcRenderer.on('window-focus-changed')
       │                 │ ────────┐       │                    │
       │                 │         │       │                    │
       │                 │<────────┘       │                    │
       │                 │                 │                    │
       │                 │ return cleanup  │                    │
       │                 │────────────────>│                    │
       │                 │                 │                    │
       │                 │                 │                    │
       │                 │                 │                    │
   [User switches to different app]       │                    │
       │                 │                 │                    │
       │ blur event      │                 │                    │
       │ ────────┐       │                 │                    │
       │         │       │                 │                    │
       │<────────┘       │                 │                    │
       │                 │                 │                    │
       │ webContents.send('window-focus-changed', false)        │
       │────────────────>│                 │                    │
       │                 │                 │                    │
       │                 │ callback(false) │                    │
       │                 │────────────────>│                    │
       │                 │                 │                    │
       │                 │                 │ setIsFocused(false)│
       │                 │                 │───────────────────>│
       │                 │                 │                    │
       │                 │                 │                    │
   [User switches back to app]            │                    │
       │                 │                 │                    │
       │ focus event     │                 │                    │
       │ ────────┐       │                 │                    │
       │         │       │                 │                    │
       │<────────┘       │                 │                    │
       │                 │                 │                    │
       │ webContents.send('window-focus-changed', true)         │
       │────────────────>│                 │                    │
       │                 │                 │                    │
       │                 │ callback(true)  │                    │
       │                 │────────────────>│                    │
       │                 │                 │                    │
       │                 │                 │ setIsFocused(true) │
       │                 │                 │───────────────────>│
       │                 │                 │                    │
```

#### Flow 6: Complete End-to-End Flow (Happy Path)

```
User Context: Working on "Feature X" workspace with 2 sessions running,
              switches to browser to read docs. Both sessions finish while away.

┌──────┐  ┌──────────┐  ┌──────────────┐  ┌────────────────┐  ┌──────────┐  ┌───────────┐  ┌─────┐
│ User │  │ Session1 │  │ Session2     │  │ workspace-     │  │ Frontend │  │ Browser   │  │ OS  │
│      │  │ (Claude) │  │ (Claude)     │  │ activity svc   │  │ Manager  │  │ Notif API │  │     │
└──┬───┘  └────┬─────┘  └──────┬───────┘  └───────┬────────┘  └────┬─────┘  └─────┬─────┘  └──┬──┘
   │           │                │                  │                │              │           │
   │  Switches to browser to read docs             │                │              │           │
   │──────────────────────────────────────────────>│                │              │           │
   │           │                │                  │                │              │           │
   │           │                │                  │        window.blur event      │           │
   │           │                │                  │                │<─────────────│           │
   │           │                │                  │                │              │           │
   │           │                │                  │        isWindowFocused = false│           │
   │           │                │                  │                │              │           │
   │           │                │                  │                │              │           │
   │     Session 1 finishes task                   │                │              │           │
   │           │                │                  │                │              │           │
   │           │ result         │                  │                │              │           │
   │           │────────────────┼─────────────────>│                │              │           │
   │           │                │                  │                │              │           │
   │           │                │          markSessionIdle(s1)      │              │           │
   │           │                │          runningSet = {s2}        │              │           │
   │           │                │          (Still running - no event)              │           │
   │           │                │                  │                │              │           │
   │           │                │                  │                │              │           │
   │     Session 2 finishes task (2 min later)     │                │              │           │
   │           │                │                  │                │              │           │
   │           │                │ result           │                │              │           │
   │           │                │─────────────────>│                │              │           │
   │           │                │                  │                │              │           │
   │           │                │          markSessionIdle(s2)      │              │           │
   │           │                │          runningSet = {}          │              │           │
   │           │                │                  │                │              │           │
   │           │                │          ALL SESSIONS DONE! ✓     │              │           │
   │           │                │          emit('workspace_idle')   │              │           │
   │           │                │                  │                │              │           │
   │           │                │          Query workspace "Feature X"             │           │
   │           │                │          emit('request_notification')            │           │
   │           │                │                  │                │              │           │
   │           │                │          Broadcast via WebSocket  │              │           │
   │           │                │                  │───────────────>│              │           │
   │           │                │                  │                │              │           │
   │           │                │          CustomEvent             │              │           │
   │           │                │                  │                │              │           │
   │           │                │          Suppression Check:      │              │           │
   │           │                │          - isWindowFocused? NO ✓ │              │           │
   │           │                │          - isChatVisible? NO ✓   │              │           │
   │           │                │          - shouldSuppress? NO ✓  │              │           │
   │           │                │                  │                │              │           │
   │           │                │                  │        new Notification()     │           │
   │           │                │                  │                │─────────────>│           │
   │           │                │                  │                │              │           │
   │           │                │                  │                │      Display │           │
   │           │                │                  │                │──────────────┼──────────>│
   │           │                │                  │                │              │           │
   │           │                │                  │                │              │  🔔 Ping! │
   │           │                │                  │                │              │           │
   │  Sees notification: "Workspace Ready: Feature X"                              │           │
   │  "All 2 agents finished and ready for your attention"                         │           │
   │<─────────────────────────────────────────────────────────────────────────────┼───────────│
   │           │                │                  │                │              │           │
   │  Clicks notification to return to app         │                │              │           │
   │──────────────────────────────────────────────>│                │              │           │
   │           │                │                  │                │              │           │
```

## Detailed Design

### 1. Backend: Workspace Activity Tracker Service

**File:** `src/backend/services/workspace-activity.service.ts` (NEW)

This service maintains a real-time map of which workspaces have running sessions.

```typescript
/**
 * Workspace Activity Service
 *
 * Tracks the running state of all Claude sessions per workspace.
 * Emits events when all sessions in a workspace finish.
 */

import { EventEmitter } from 'node:events';
import { createLogger } from './logger.service';
import { sessionService } from './session.service';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { notificationService } from './notification.service';

const logger = createLogger('workspace-activity');

interface WorkspaceActivityState {
  workspaceId: string;
  runningSessions: Map<string, number>; // Session ID to current activity generation
  currentGeneration: number;
  lastActivityAt: Date;
}

class WorkspaceActivityService extends EventEmitter {
  private workspaceStates = new Map<string, WorkspaceActivityState>();

  constructor() {
    super();

    // Listen for workspace idle events and trigger notifications
    this.on('workspace_idle', async ({ workspaceId, finishedAt }) => {
      try {
        const workspace = await workspaceAccessor.findById(workspaceId);
        if (!workspace) {
          logger.warn('Workspace not found for notification', { workspaceId });
          return;
        }

        // Emit event to frontend for suppression check
        this.emit('request_notification', {
          workspaceId,
          workspaceName: workspace.name,
          sessionCount: workspace.claudeSessions.length,
          finishedAt,
        });
      } catch (error) {
        logger.error('Failed to process workspace idle event', error as Error, { workspaceId });
      }
    });
  }

  /**
   * Mark a session as started/running in a workspace
   */
  markSessionRunning(workspaceId: string, sessionId: string): number {
    let state = this.workspaceStates.get(workspaceId);

    if (!state) {
      state = {
        workspaceId,
        runningSessions: new Map(),
        currentGeneration: 0,
        lastActivityAt: new Date(),
      };
      this.workspaceStates.set(workspaceId, state);
    }

    const wasIdle = state.runningSessions.size === 0;
    state.currentGeneration += 1;
    const generation = state.currentGeneration;
    state.runningSessions.set(sessionId, generation);
    state.lastActivityAt = new Date();

    this.emit('session_activity_changed', {
      workspaceId,
      sessionId,
      isWorking: true,
      runningSessionCount: state.runningSessions.size,
      updatedAt: state.lastActivityAt,
    });

    if (wasIdle) {
      logger.debug('Workspace became active', { workspaceId, sessionId });
      this.emit('workspace_active', { workspaceId });
    }

    return generation;
  }

  /**
   * Mark a session as finished/idle in a workspace
   */
  markSessionIdle(workspaceId: string, sessionId: string, generation?: number): void {
    const state = this.workspaceStates.get(workspaceId);

    if (!state) {
      return; // No state tracked for this workspace
    }

    const currentGeneration = state.runningSessions.get(sessionId);
    if (currentGeneration === undefined) {
      return;
    }

    if (generation !== undefined && currentGeneration !== generation) {
      logger.debug('Ignoring stale workspace session idle transition', {
        workspaceId,
        sessionId,
        generation,
        currentGeneration,
      });
      return;
    }

    const wasActive = state.runningSessions.size > 0;
    state.runningSessions.delete(sessionId);
    state.lastActivityAt = new Date();

    this.emit('session_activity_changed', {
      workspaceId,
      sessionId,
      isWorking: false,
      runningSessionCount: state.runningSessions.size,
      updatedAt: state.lastActivityAt,
    });

    if (wasActive && state.runningSessions.size === 0) {
      logger.info('All sessions finished in workspace', { workspaceId });
      this.emit('workspace_idle', {
        workspaceId,
        finishedAt: state.lastActivityAt
      });
    }
  }

  /**
   * Check if any sessions are running in a workspace
   */
  isWorkspaceActive(workspaceId: string): boolean {
    const state = this.workspaceStates.get(workspaceId);
    return state ? state.runningSessions.size > 0 : false;
  }

  /**
   * Get count of running sessions in a workspace
   */
  getRunningSessionCount(workspaceId: string): number {
    const state = this.workspaceStates.get(workspaceId);
    return state ? state.runningSessions.size : 0;
  }

  /**
   * Clean up workspace state when workspace is archived/deleted
   */
  clearWorkspace(workspaceId: string): void {
    this.workspaceStates.delete(workspaceId);
  }

  /**
   * Initialize state from existing running sessions (for server restart recovery)
   */
  async initializeFromExistingSessions(): Promise<void> {
    // Query all active sessions and rebuild state
    const activeSessions = sessionService.getAllActiveSessions();

    for (const { sessionId, workspaceId, isRunning } of activeSessions) {
      if (isRunning) {
        this.markSessionRunning(workspaceId, sessionId);
      }
    }

    logger.info('Initialized workspace activity state', {
      workspaceCount: this.workspaceStates.size,
    });
  }
}

export const workspaceActivityService = new WorkspaceActivityService();
```

### 2. Backend: Update Chat Handler to Track Workspace Activity

**File:** `src/backend/routers/websocket/chat.handler.ts` (MODIFY)

Add workspace activity tracking when session states change:

**Location 1:** Add import at top of file (after line 18):
```typescript
import { workspaceActivityService } from '../../services/workspace-activity.service';
```

**Location 2:** In `setupChatClientEvents()`, update the `session_id` event handler (around line 173):
```typescript
client.on('session_id', (claudeSessionId) => {
  if (DEBUG_CHAT_WS) {
    logger.info('[Chat WS] Received session_id from Claude CLI', {
      dbSessionId,
      claudeSessionId,
    });
  }

  // Drain any pending messages
  const pending = pendingMessages.get(dbSessionId);
  pendingMessages.delete(dbSessionId);
  if (pending && pending.length > 0) {
    logger.info('[Chat WS] Draining pending messages on session_id', {
      dbSessionId,
      count: pending.length,
    });
    for (const msg of pending) {
      client.sendMessage(msg.content);
    }
  }

  // NEW: Mark workspace as active
  workspaceActivityService.markSessionRunning(context.workspaceId, dbSessionId);

  forwardToConnections(dbSessionId, {
    type: 'status',
    running: true,
  });
});
```

**Location 3:** In `setupChatClientEvents()`, update the `result` event handler (around line 262):
```typescript
client.on('result', (result) => {
  if (DEBUG_CHAT_WS) {
    const res = result as { uuid?: string };
    logger.info('[Chat WS] Received result event from client', { dbSessionId, uuid: res.uuid });
  }
  sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: 'result', data: result });
  forwardToConnections(dbSessionId, { type: 'claude_message', data: result });

  // NEW: Mark session as idle
  workspaceActivityService.markSessionIdle(context.workspaceId, dbSessionId);

  forwardToConnections(dbSessionId, {
    type: 'status',
    running: false,
  });
});
```

**Location 4:** Add workspace notification forwarding (after `setupChatClientEvents` function, around line 290):
```typescript
/**
 * Set up workspace-level notification forwarding.
 * Call this once during handler initialization.
 */
let workspaceNotificationsSetup = false;

function setupWorkspaceNotifications(): void {
  if (workspaceNotificationsSetup) {
    return; // Already set up
  }
  workspaceNotificationsSetup = true;

  workspaceActivityService.on('request_notification', async (data) => {
    const { workspaceId, workspaceName, sessionCount, finishedAt } = data;

    logger.debug('Broadcasting workspace notification request', { workspaceId });

    // Send to all connections viewing this workspace
    for (const info of chatConnections.values()) {
      if (info.dbSessionId && info.ws.readyState === 1) {
        try {
          const session = await claudeSessionAccessor.findById(info.dbSessionId);
          if (session?.workspaceId === workspaceId) {
            info.ws.send(JSON.stringify({
              type: 'workspace_notification_request',
              workspaceId,
              workspaceName,
              sessionCount,
              finishedAt: finishedAt.toISOString(),
            }));
          }
        } catch (error) {
          logger.error('Failed to check session workspace', error as Error, {
            dbSessionId: info.dbSessionId,
          });
        }
      }
    }
  });
}
```

**Location 5:** Call `setupWorkspaceNotifications()` in the upgrade handler (around line 614, inside `wss.handleUpgrade`):
```typescript
wss.handleUpgrade(request, socket, head, (ws) => {
  logger.info('Chat WebSocket connection established', {
    connectionId,
    dbSessionId,
  });

  // Set up workspace notification forwarding (idempotent)
  setupWorkspaceNotifications();

  wsAliveMap.set(ws, true);
  ws.on('pong', () => wsAliveMap.set(ws, true));

  // ... rest of the handler ...
});
```

### 3. Backend: Add Notification Method

**File:** `src/backend/services/notification.service.ts` (MODIFY)

Add a workspace completion notification method (around line 335, before the final export):

```typescript
/**
 * Send a workspace completion notification
 */
async notifyWorkspaceComplete(
  workspaceName: string,
  workspaceId: string,
  sessionCount: number
): Promise<void> {
  const message = sessionCount === 1
    ? 'Agent finished and is ready for your attention'
    : `All ${sessionCount} agents finished and ready for your attention`;

  await this.notify(`Workspace Ready: ${workspaceName}`, message);
}
```

### 4. Frontend: Window Focus Detection Hook

**File:** `src/client/hooks/use-window-focus.ts` (NEW)

```typescript
import { useEffect, useState } from 'react';

/**
 * Track whether the app window is focused.
 * Works in both browser and Electron.
 */
export function useWindowFocus(): boolean {
  const [isFocused, setIsFocused] = useState(() => {
    // Initial state
    if (typeof document !== 'undefined') {
      return document.hasFocus();
    }
    return true;
  });

  useEffect(() => {
    // Check if running in Electron with focus API
    if (window.electron?.onWindowFocusChanged) {
      return window.electron.onWindowFocusChanged(setIsFocused);
    }

    // Fallback to browser APIs
    const handleFocus = () => setIsFocused(true);
    const handleBlur = () => setIsFocused(false);
    const handleVisibilityChange = () => {
      setIsFocused(!document.hidden && document.hasFocus());
    };

    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return isFocused;
}
```

### 5. Frontend: Workspace Notification Manager

**File:** `src/components/workspace/WorkspaceNotificationManager.tsx` (NEW)

```typescript
import { useEffect } from 'react';
import { useParams, useLocation } from 'react-router';
import { useWindowFocus } from '../../hooks/use-window-focus';

interface NotificationRequest {
  workspaceId: string;
  workspaceName: string;
  sessionCount: number;
  finishedAt: string;
}

/**
 * Manages workspace completion notifications.
 * Handles suppression logic based on window focus and visible workspace.
 */
export function WorkspaceNotificationManager() {
  const { workspaceId: currentWorkspaceId } = useParams();
  const location = useLocation();
  const isWindowFocused = useWindowFocus();

  useEffect(() => {
    // Listen for notification requests from backend
    const handleNotificationRequest = (event: CustomEvent<NotificationRequest>) => {
      try {
        const request = event.detail;
        handleWorkspaceNotification(request);
      } catch (error) {
        console.error('Failed to handle notification request', error);
      }
    };

    window.addEventListener('workspace-notification-request', handleNotificationRequest as EventListener);

    return () => {
      window.removeEventListener('workspace-notification-request', handleNotificationRequest as EventListener);
    };
  }, [currentWorkspaceId, location.pathname, isWindowFocused]);

  const handleWorkspaceNotification = (request: NotificationRequest) => {
    const { workspaceId, workspaceName, sessionCount } = request;

    // Suppression Logic
    const isChatVisible = location.pathname.includes(`/workspace/${workspaceId}`);
    const shouldSuppress = isWindowFocused || isChatVisible;

    if (shouldSuppress) {
      console.debug('Notification suppressed', {
        reason: isWindowFocused ? 'window_focused' : 'chat_visible',
        workspaceId,
      });
      return;
    }

    // Send notification
    sendWorkspaceNotification(workspaceName, sessionCount);
  };

  return null; // No UI, just notification logic
}

function sendWorkspaceNotification(workspaceName: string, sessionCount: number): void {
  if (!('Notification' in window)) {
    console.warn('Browser does not support notifications');
    return;
  }

  // Request permission if needed
  if (Notification.permission === 'default') {
    Notification.requestPermission().then((permission) => {
      if (permission === 'granted') {
        showNotification(workspaceName, sessionCount);
      }
    });
  } else if (Notification.permission === 'granted') {
    showNotification(workspaceName, sessionCount);
  }
}

function showNotification(workspaceName: string, sessionCount: number): void {
  const message = sessionCount === 1
    ? 'Agent finished and is ready for your attention'
    : `All ${sessionCount} agents finished and ready for your attention`;

  new Notification(`Workspace Ready: ${workspaceName}`, {
    body: message,
    icon: '/favicon.ico',
    tag: `workspace-complete-${workspaceName}`, // Prevents duplicates
    requireInteraction: false,
  });
}
```

### 6. Frontend: Integration with Chat WebSocket

**File:** `src/components/chat/use-chat-websocket.ts` (MODIFY)

Update the WebSocket message handler to pass notification requests to the manager.

Find the `ws.onmessage` handler and add handling for the new message type:

```typescript
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  // ... existing message handling (status, claude_message, etc.) ...

  // NEW: Handle workspace notification requests
  if (data.type === 'workspace_notification_request') {
    // Dispatch custom event for WorkspaceNotificationManager
    window.dispatchEvent(new CustomEvent('workspace-notification-request', {
      detail: {
        workspaceId: data.workspaceId,
        workspaceName: data.workspaceName,
        sessionCount: data.sessionCount,
        finishedAt: data.finishedAt,
      }
    }));
    return;
  }

  // ... rest of message handling ...
};
```

### 7. Frontend: Add Manager to App Root

**File:** `src/client/router.tsx` or main app component (MODIFY)

Add the WorkspaceNotificationManager to your app root so it runs globally:

```typescript
import { WorkspaceNotificationManager } from './components/workspace/WorkspaceNotificationManager';

// In your root component or router:
export function App() {
  return (
    <>
      <WorkspaceNotificationManager />
      {/* ... rest of your app ... */}
    </>
  );
}
```

### 8. Electron: Expose Window Focus State

**File:** `electron/main/index.ts` (MODIFY)

Add window focus event handlers in the `createWindow` function (after line 42):

```typescript
mainWindow.loadURL(url);
console.log('[electron] Window created and URL loaded');

// NEW: Track window focus state
mainWindow.on('focus', () => {
  mainWindow?.webContents.send('window-focus-changed', true);
});

mainWindow.on('blur', () => {
  mainWindow?.webContents.send('window-focus-changed', false);
});
```

**File:** `electron/preload/index.ts` (MODIFY)

Expose the focus API to the renderer:

```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  // ... existing APIs (dialog:showOpen, etc.) ...

  /**
   * Listen for window focus changes (Electron only)
   */
  onWindowFocusChanged: (callback: (isFocused: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isFocused: boolean) => {
      callback(isFocused);
    };
    ipcRenderer.on('window-focus-changed', handler);

    // Return cleanup function
    return () => {
      ipcRenderer.removeListener('window-focus-changed', handler);
    };
  },
});
```

**File:** `src/types/electron.d.ts` (MODIFY or CREATE)

Add TypeScript types for the new API:

```typescript
export interface ElectronAPI {
  dialog: {
    showOpen: (options: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>;
  };

  // NEW: Window focus API
  onWindowFocusChanged?: (callback: (isFocused: boolean) => void) => () => void;
}

declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}
```

## Implementation Plan

### Phase 1: Backend Foundation (1-2 hours)
1. Create `workspace-activity.service.ts`
2. Update `chat.handler.ts` to track session state changes
3. Add workspace notification method to `notification.service.ts`
4. Wire up workspace idle event to notification request

### Phase 2: Frontend Integration (1-2 hours)
1. Create `use-window-focus.ts` hook
2. Create `WorkspaceNotificationManager.tsx` component
3. Update chat WebSocket to forward notification requests
4. Add notification manager to app root

### Phase 3: Electron Enhancement (30 min)
1. Update Electron main process to track focus
2. Update preload script to expose focus API
3. Update TypeScript types for Electron API

### Phase 4: Testing & Polish (1 hour)
1. Test notification suppression logic
2. Test multi-session workspace scenarios
3. Test Electron and browser environments
4. Verify notification permissions work correctly

## File Changes Summary

### New Files (3)
- `src/backend/services/workspace-activity.service.ts` - Workspace activity tracking
- `src/client/hooks/use-window-focus.ts` - Window focus detection
- `src/components/workspace/WorkspaceNotificationManager.tsx` - Notification manager component

### Modified Files (6)
- `src/backend/routers/websocket/chat.handler.ts` - Add workspace activity tracking
- `src/backend/services/notification.service.ts` - Add workspace notification method
- `src/components/chat/use-chat-websocket.ts` - Forward notification requests
- `src/client/router.tsx` - Add notification manager to app
- `electron/main/index.ts` - Track window focus events
- `electron/preload/index.ts` - Expose focus API
- `src/types/electron.d.ts` - Add TypeScript types

### Export Updates (1)
- `src/backend/services/index.ts` - Export `workspaceActivityService`

## Testing Checklist

- [ ] Single session in workspace finishes → notification sent (when unfocused)
- [ ] Multiple sessions in workspace, only last one finishing → notification sent
- [ ] Multiple sessions, one finishes while others run → no notification
- [ ] Window is focused → notification suppressed
- [ ] Chat/workspace is visible in UI → notification suppressed
- [ ] Window unfocused + different workspace visible → notification sent
- [ ] Browser environment → Web Notification API works
- [ ] Electron environment → native notifications work
- [ ] Notification permission request works correctly
- [ ] Duplicate notifications prevented (same workspace finishing twice)

## Benefits of This Approach

1. **Minimal Disruption:** Leverages existing infrastructure (`notification.service.ts`, WebSocket system, session tracking)

2. **Clean Separation:** Backend tracks activity, frontend decides suppression

3. **Workspace-Scoped:** Properly handles workspaces with multiple concurrent sessions

4. **Smart Suppression:** Dual-check (window focus + chat visibility) prevents notification spam

5. **Electron-Ready:** Works in both browser and Electron with proper OS notifications

6. **Extensible:** Easy to add user preferences, custom sounds, or different notification types later

## Future Enhancements (Optional)

- User preferences panel for notification settings
- Different notification sounds per workspace/priority
- Notification history/log
- Batch notifications (if multiple workspaces finish simultaneously)
- Notification action buttons (e.g., "View Workspace")
- Integration with system Do Not Disturb mode
- Custom notification templates per workspace type

## Questions & Notes

- **Browser Notification Permissions:** Users will need to grant notification permissions the first time. Consider adding a prompt/onboarding flow.
- **Testing Strategy:** Should test with multiple browser tabs open to ensure suppression logic works correctly.
- **Performance:** The workspace activity service keeps state in memory. For very large numbers of workspaces, consider periodic cleanup of idle workspace states.
