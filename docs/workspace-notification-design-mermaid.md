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

```mermaid
flowchart TB
    subgraph Workspace["Workspace with Sessions"]
        S1["Session 1<br/>(running)"]
        S2["Session 2<br/>(running)"]
        S3["Session 3<br/>(idle)"]
    end

    subgraph Backend["Backend (Node.js/Express)"]
        ChatHandler["chat.handler.ts<br/>WebSocket Handler"]

        subgraph ActivityService["workspace-activity.service.ts"]
            StateMap["workspaceStates Map<br/>{<br/>  workspaceId: {<br/>    runningSessions: Set<sessionId>,<br/>    lastActivityAt: Date<br/>  }<br/>}"]
            IdleEvent["Event: 'workspace_idle'<br/>(when runningSessions.size === 0)"]
            IdleHandler["workspace_idle handler:<br/>1. Query workspace by ID<br/>2. Emit 'request_notification'"]
        end

        WSSetup["setupWorkspaceNotifications()<br/>Listen to 'request_notification'<br/>Broadcast to WebSocket clients"]
    end

    subgraph Frontend["Frontend (React/Browser)"]
        WSClient["use-chat-websocket.ts<br/>ws.onmessage handler"]
        NotifMgr["WorkspaceNotificationManager.tsx<br/>Suppression Logic:<br/>- isWindowFocused?<br/>- isChatVisible?<br/>- shouldSuppress?"]
        BrowserAPI["Browser Notification API<br/>new Notification()"]
    end

    OS["OS Notification<br/>🔔 Workspace Ready"]

    S1 -->|session_id event| ChatHandler
    S2 -->|result event| ChatHandler
    ChatHandler -->|markSessionRunning()| StateMap
    ChatHandler -->|markSessionIdle()| StateMap
    StateMap --> IdleEvent
    IdleEvent --> IdleHandler
    IdleHandler --> WSSetup
    WSSetup -->|WebSocket Message<br/>workspace_notification_request| WSClient
    WSClient -->|CustomEvent| NotifMgr
    NotifMgr -->|if !shouldSuppress| BrowserAPI
    BrowserAPI --> OS

    style Workspace fill:#e1f5fe
    style Backend fill:#fff3e0
    style Frontend fill:#f3e5f5
    style OS fill:#c8e6c9
```

### Detailed Event Flow

**Scenario: Two sessions in a workspace, both finish sequentially**

```mermaid
gantt
    title Workspace Session Activity Timeline
    dateFormat X
    axisFormat %S

    section Session 1
    Running :s1, 0, 6
    Finished :milestone, 6, 0

    section Session 2
    Running :s2, 3, 9
    Finished :milestone, 9, 0

    section Workspace State
    1 Session Running :ws1, 0, 3
    2 Sessions Running :ws2, 3, 6
    1 Session Running :ws3, 6, 9
    All Done - Notify! :crit, milestone, 9, 0
```

**Detailed Timeline:**

| Time | Event | Component | State Change |
|------|-------|-----------|--------------|
| T0 | Session 1 starts processing<br/>emits 'session_id' | ClaudeClient | |
| T1 | chat.handler receives event<br/>calls markSessionRunning() | chat.handler.ts | |
| T2 | Add session1 to runningSet | workspace-activity.service | runningSessions:<br/>Set { session1 } |
| T3 | Session 2 starts processing<br/>emits 'session_id' | ClaudeClient | |
| T4 | chat.handler receives event<br/>calls markSessionRunning() | chat.handler.ts | |
| T5 | Add session2 to runningSet | workspace-activity.service | runningSessions:<br/>Set { s1, s2 } |
| T6 | Session 1 finishes<br/>emits 'result' | ClaudeClient | |
| T7 | chat.handler receives result<br/>calls markSessionIdle() | chat.handler.ts | |
| T8 | Remove session1 from runningSet<br/>Check: size === 0? NO<br/>NO notification triggered | workspace-activity.service | runningSessions:<br/>Set { s2 }<br/>(still running) |
| T9 | Session 2 finishes<br/>emits 'result' | ClaudeClient | |
| T10 | chat.handler receives result<br/>calls markSessionIdle() | chat.handler.ts | |
| T11 | Remove session2 from runningSet<br/>Check: size === 0? YES<br/>✅ Emit 'workspace_idle' | workspace-activity.service | runningSessions:<br/>Set {}<br/>(ALL DONE!) |
| T12 | workspace_idle handler runs<br/>Query workspace from DB<br/>Emit 'request_notification' | workspace-activity.service | |
| T13 | Broadcast to WebSocket clients<br/>type: workspace_notification_request | setupWorkspaceNotifications()<br/>chat.handler.ts | |
| T14 | WebSocket receives message<br/>Dispatch CustomEvent | use-chat-websocket.ts<br/>Frontend | |
| T15 | WorkspaceNotificationManager<br/>receives CustomEvent | WorkspaceNotificationManager.tsx | |
| T16 | Check suppression logic:<br/>- isWindowFocused? NO<br/>- isChatVisible? NO<br/>- shouldSuppress? NO | WorkspaceNotificationManager.tsx | |
| T17 | ✅ Call new Notification()<br/>Display OS notification | Browser Notification API | |
| T18 | 🔔 User sees notification! | Operating System | |

### Sequence Diagrams

#### Flow 1: Session Starts Running (No Notification)

```mermaid
sequenceDiagram
    participant Claude as Claude Client
    participant Handler as chat.handler.ts
    participant Activity as workspace-activity.service
    participant WS as WebSocket Clients

    Claude->>Handler: session_id event
    Handler->>Activity: markSessionRunning()
    Activity->>Activity: Add to runningSet<br/>Set { session1 }
    Handler->>WS: forwardToConnections()<br/>{ type: 'status', running: true }
    Note over WS: User sees "Claude is thinking..."
```

#### Flow 2: Multiple Sessions - First Finishes (No Notification)

```mermaid
sequenceDiagram
    participant Claude1 as Claude Client 1
    participant Handler as chat.handler.ts
    participant Activity as workspace-activity.service
    participant WS as WebSocket Clients

    Note over Activity: State: runningSessions =<br/>Set { session1, session2 }

    Claude1->>Handler: result event
    Handler->>Activity: markSessionIdle()
    Activity->>Activity: Remove session1<br/>Set { session2 }
    Activity->>Activity: Check: size === 0?<br/>NO ✗
    Note over Activity: (No event emitted)
    Handler->>WS: forwardToConnections()<br/>{ type: 'status', running: false }
    Note over WS: Session 1 done,<br/>but Session 2 still running...
```

#### Flow 3: Last Session Finishes - Notification Triggered (Window Unfocused)

```mermaid
sequenceDiagram
    participant Claude as Claude Client 2
    participant Handler as chat.handler.ts
    participant Activity as workspace-activity.service
    participant WS as WebSocket Clients
    participant NotifMgr as NotificationManager.tsx
    participant OS as OS

    Claude->>Handler: result event
    Handler->>Activity: markSessionIdle()
    Activity->>Activity: Remove session2<br/>Set {}
    Activity->>Activity: Check: size === 0?<br/>YES ✓
    Activity->>Activity: emit('workspace_idle')
    Activity->>Activity: Query workspace from DB<br/>(get name, sessionCount)
    Activity->>Activity: emit('request_notification')
    Activity->>Handler: setupWorkspaceNotifications()<br/>listener receives event
    Handler->>WS: Broadcast to WebSocket clients<br/>{<br/>  type: 'workspace_notification_request',<br/>  workspaceId: 'ws-123',<br/>  workspaceName: 'My Feature',<br/>  sessionCount: 2<br/>}
    WS->>NotifMgr: CustomEvent<br/>('workspace-notification-request')
    NotifMgr->>NotifMgr: Check: isWindowFocused?<br/>NO ✗
    NotifMgr->>NotifMgr: Check: isChatVisible?<br/>NO ✗
    NotifMgr->>NotifMgr: shouldSuppress?<br/>NO ✗
    NotifMgr->>OS: new Notification()
    Note over OS: 🔔 Display
```

#### Flow 4: Last Session Finishes - Notification Suppressed (Window Focused)

```mermaid
sequenceDiagram
    participant Claude as Claude Client 2
    participant Handler as chat.handler.ts
    participant Activity as workspace-activity.service
    participant WS as WebSocket Clients
    participant NotifMgr as NotificationManager.tsx

    Claude->>Handler: result event
    Handler->>Activity: markSessionIdle()
    Activity->>Activity: Remove session2<br/>Set {}
    Activity->>Activity: emit('workspace_idle')
    Activity->>Activity: emit('request_notification')
    Handler->>WS: Broadcast workspace_notification_request
    WS->>NotifMgr: CustomEvent
    NotifMgr->>NotifMgr: Check: isWindowFocused?<br/>YES ✓
    NotifMgr->>NotifMgr: shouldSuppress?<br/>YES ✓
    NotifMgr->>NotifMgr: return;<br/>(suppressed)
    Note over NotifMgr: ℹ️  User is actively looking<br/>at the app - no notification needed
```

#### Flow 5: Window Focus Detection (Electron)

```mermaid
sequenceDiagram
    participant Main as Electron Main Window
    participant Preload as Electron Preload
    participant Hook as use-window-focus.ts
    participant NotifMgr as NotificationManager.tsx

    NotifMgr->>Hook: useEffect() mount
    Hook->>Preload: onWindowFocusChanged(callback)
    Preload->>Preload: ipcRenderer.on('window-focus-changed')
    Preload->>Hook: return cleanup function

    Note over Main: [User switches to different app]
    Main->>Main: blur event
    Main->>Preload: webContents.send('window-focus-changed', false)
    Preload->>Hook: callback(false)
    Hook->>NotifMgr: setIsFocused(false)

    Note over Main: [User switches back to app]
    Main->>Main: focus event
    Main->>Preload: webContents.send('window-focus-changed', true)
    Preload->>Hook: callback(true)
    Hook->>NotifMgr: setIsFocused(true)
```

#### Flow 6: Complete End-to-End Flow (Happy Path)

**User Context:** Working on "Feature X" workspace with 2 sessions running, switches to browser to read docs. Both sessions finish while away.

```mermaid
sequenceDiagram
    participant User
    participant S1 as Session 1 (Claude)
    participant S2 as Session 2 (Claude)
    participant Activity as workspace-activity svc
    participant Frontend as Frontend Manager
    participant Browser as Browser Notif API
    participant OS

    User->>User: Switches to browser to read docs
    Note over Frontend: window.blur event<br/>isWindowFocused = false

    Note over S1: Session 1 finishes task
    S1->>Activity: result
    Activity->>Activity: markSessionIdle(s1)<br/>runningSet = {s2}
    Note over Activity: (Still running - no event)

    Note over S2: Session 2 finishes task<br/>(2 min later)
    S2->>Activity: result
    Activity->>Activity: markSessionIdle(s2)<br/>runningSet = {}
    Note over Activity: ALL SESSIONS DONE! ✓<br/>emit('workspace_idle')
    Activity->>Activity: Query workspace "Feature X"<br/>emit('request_notification')
    Activity->>Frontend: Broadcast via WebSocket
    Note over Frontend: CustomEvent<br/><br/>Suppression Check:<br/>- isWindowFocused? NO ✓<br/>- isChatVisible? NO ✓<br/>- shouldSuppress? NO ✓
    Frontend->>Browser: new Notification()
    Browser->>OS: Display
    Note over OS: 🔔 Ping!
    OS->>User: Sees notification:<br/>"Workspace Ready: Feature X"<br/>"All 2 agents finished and<br/>ready for your attention"
    User->>User: Clicks notification to return to app
```

## Detailed Design

[Rest of the design document continues as before with code samples...]

