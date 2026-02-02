# Chat Message Flow Architecture

This document describes how chat messages flow between the frontend and backend, including session resume, reconnection, and state synchronization.

## Overview

The chat system uses a **store-then-forward** pattern with a **single broadcast point** to ensure all connected frontends receive identical messages regardless of when they connect.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           BACKEND SERVICES                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ClaudeClient                ChatEventForwarderService                  │
│   (Claude CLI)  ─────emit────▶  (Event Handlers)                        │
│                                       │                                  │
│                                       │ store + forward                  │
│                                       ▼                                  │
│   MessageStateService ◀───────── storeEvent()                           │
│   (In-Memory State)                   │                                  │
│         │                             │                                  │
│         │ sendSnapshot()              │ forwardToSession()               │
│         │                             │                                  │
│         └─────────────────────────────┼──────────────────────────────┐  │
│                                       │                              │  │
│                                       ▼                              ▼  │
│                          ┌─────────────────────────┐                    │
│                          │ ChatConnectionService   │                    │
│                          │ forwardToSession()      │ ◀── SINGLE PATH   │
│                          │ (THE ONLY BROADCAST)    │                    │
│                          └─────────────────────────┘                    │
│                                       │                                  │
└───────────────────────────────────────┼──────────────────────────────────┘
                                        │ WebSocket
                                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND                                       │
├─────────────────────────────────────────────────────────────────────────┤
│   WebSocket Transport ─────▶ ChatReducer ─────▶ React State             │
└─────────────────────────────────────────────────────────────────────────┘
```

## Core Principle: Single Broadcast Point

**All messages to the frontend go through `chatConnectionService.forwardToSession()`.**

This function:
1. Broadcasts to ALL WebSocket connections viewing a specific session
2. Serializes the message once, sends to multiple connections
3. Logs every message for debugging via `sessionFileLogger`

Location: `src/backend/services/chat-connection.service.ts`

```typescript
forwardToSession(dbSessionId: string | null, data: unknown, exclude?: WebSocket): void
```

## Store-Then-Forward Pattern

Every event from Claude is stored before forwarding:

```typescript
// In chat-event-forwarder.service.ts
messageStateService.storeEvent(dbSessionId, msg);
chatConnectionService.forwardToSession(dbSessionId, msg);
```

This pattern appears for:
- Status messages (running: true/false)
- Claude stream events (tool use, thinking, text)
- User messages with tool results
- Result messages (completion)

**Why?** When a frontend reconnects (page reload while Claude is running), we can replay all stored events to bring the UI back in sync.

## Message Flow Scenarios

### Scenario 1: New Session (Frontend Connected)

```
User sends message
        │
        ▼
┌───────────────────┐
│ Frontend WebSocket│
│ queue_message     │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ MessageQueueSvc   │──▶ messageStateService.createUserMessage()
│ enqueue()         │    (emits MESSAGE_STATE_CHANGED: ACCEPTED)
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ tryDispatch       │
│ NextMessage()     │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ ClaudeClient      │
│ sendMessage()     │
└───────────────────┘
        │
        ▼
┌───────────────────┐     ┌──────────────────┐
│ Claude CLI        │────▶│ Event Handlers   │
│ (subprocess)      │     │ (on stream,etc)  │
└───────────────────┘     └──────────────────┘
                                   │
                                   │ For each event:
                                   │ 1. storeEvent()
                                   │ 2. forwardToSession()
                                   ▼
                          ┌──────────────────┐
                          │ All Connected    │
                          │ Frontends        │
                          └──────────────────┘
```

### Scenario 2: Page Reload (Claude Still Running)

```
Frontend reconnects via WebSocket
        │
        ▼
┌───────────────────────────────────────────┐
│ chat.handler.ts: handleChatUpgrade()      │
│                                           │
│ 1. Register connection                    │
│ 2. Send initial status                    │
│ 3. Call messageStateService.sendSnapshot()│
└───────────────────────────────────────────┘
        │
        │ sendSnapshot() internally calls
        │ forwardToSession() with current state
        ▼
┌───────────────────────────────────────────┐
│ Frontend receives MESSAGES_SNAPSHOT       │
│ - Pre-built ChatMessage[] array           │
│ - Current sessionStatus                   │
│ - pendingInteractiveRequest (if any)      │
└───────────────────────────────────────────┘
```

**Key insight:** The frontend receives the same message format (`messages_snapshot`) whether:
- Connecting for the first time
- Reconnecting after page reload
- Reconnecting after network interruption

### Scenario 3: Cold Start (No Claude Process Running)

```
Frontend sends load_session
        │
        ▼
┌───────────────────────────────────────────┐
│ handleLoadSessionMessage()                │
│                                           │
│ Check: existingClient?.isRunning()        │
│        ↓ NO (cold start)                  │
│                                           │
│ loadHistoryFromJSONL():                   │
│   1. SessionManager.getHistory()          │
│      (reads ~/.claude/projects/.../       │
│       conversation.jsonl)                 │
│   2. messageStateService.loadFromHistory()│
│   3. messageStateService.sendSnapshot()   │
└───────────────────────────────────────────┘
        │
        │ sendSnapshot() → forwardToSession()
        ▼
┌───────────────────────────────────────────┐
│ Frontend receives MESSAGES_SNAPSHOT       │
│ (same format as live session!)            │
└───────────────────────────────────────────┘
```

## Key Services

### ChatConnectionService

**Purpose:** Manages WebSocket connections and provides the single broadcast point.

**Location:** `src/backend/services/chat-connection.service.ts`

Key methods:
- `register(connectionId, info)` - Track a new WebSocket connection
- `unregister(connectionId)` - Remove a closed connection
- `forwardToSession(sessionId, data, exclude?)` - **THE SINGLE BROADCAST POINT**

### MessageStateService

**Purpose:** Manages message state with a state machine model, stores events for replay.

**Location:** `src/backend/services/message-state.service.ts`

Key methods:
- `createUserMessage(sessionId, msg)` - Create user message in ACCEPTED state
- `storeEvent(sessionId, event)` - Store raw WebSocket event for replay
- `getStoredEvents(sessionId)` - Get all stored events for replay
- `loadFromHistory(sessionId, history)` - Load messages from JSONL history
- `sendSnapshot(sessionId, status, pendingRequest?)` - Send full state to all frontends
- `computeSessionStatus(sessionId, isRunning)` - Determine current session phase

### ChatEventForwarderService

**Purpose:** Sets up event listeners on ClaudeClient and routes events to WebSocket.

**Location:** `src/backend/services/chat-event-forwarder.service.ts`

Key methods:
- `setupClientEvents(sessionId, client, context, onDispatch)` - Wire up all event handlers
- `getPendingRequest(sessionId)` - Get pending interactive request for restore
- `clearPendingRequest(sessionId)` - Clear pending request on stop/response

### ChatMessageHandlerService

**Purpose:** Handles all incoming WebSocket message types.

**Location:** `src/backend/services/chat-message-handlers.service.ts`

Key methods:
- `handleMessage(ws, sessionId, workingDir, message)` - Route message to handler
- `tryDispatchNextMessage(sessionId)` - Dispatch next queued message to Claude
- `handleLoadSessionMessage(...)` - Load session and send snapshot
- `replayEventsForRunningClient(ws, sessionId, client)` - Replay stored events

## Frontend Message Handling

### WebSocket → Reducer Flow

```
WebSocket.onmessage
        │
        ▼
createActionFromWebSocketMessage(data)
        │
        ▼
dispatch(action)
        │
        ▼
chatReducer(state, action)
        │
        ▼
New React State
```

### Key Actions

| WebSocket Type | Redux Action | Effect |
|----------------|--------------|--------|
| `messages_snapshot` | `MESSAGES_SNAPSHOT` | Replace all messages, set status, set pending request |
| `message_state_changed` | `MESSAGE_STATE_CHANGED` | Update message state (ACCEPTED, DISPATCHED, COMMITTED, etc.) |
| `claude_message` | `WS_CLAUDE_MESSAGE` | Add Claude message to list (filtered for relevant events) |
| `status` | `WS_STATUS` | Update running state |
| `user_question` | `WS_USER_QUESTION` | Show question dialog |
| `permission_request` | `WS_PERMISSION_REQUEST` | Show permission dialog |

### Message State Machine

User messages go through states:

```
PENDING → SENT → ACCEPTED → DISPATCHED → COMMITTED
                    ↘ REJECTED/FAILED/CANCELLED
```

Claude messages:

```
STREAMING → COMPLETE
```

## Session Status States

The `sessionStatus` discriminated union tracks the session lifecycle:

```
idle → loading → starting → ready ↔ running → stopping → ready
```

| Phase | Meaning |
|-------|---------|
| `idle` | No session selected |
| `loading` | Loading session from DB/JSONL |
| `starting` | Claude process is starting |
| `ready` | Claude is idle, ready for input |
| `running` | Claude is processing a message |
| `stopping` | Stop requested, waiting for process to exit |

## Interactive Requests (Questions/Permissions)

When Claude needs user input (e.g., `AskUserQuestion` or `ExitPlanMode`):

1. **Backend stores request:** `pendingInteractiveRequests.set(sessionId, request)`
2. **Frontend receives:** via `user_question` or `permission_request` message
3. **On reconnect:** Request is included in `messages_snapshot.pendingInteractiveRequest`
4. **User responds:** Frontend sends `question_response` or `permission_response`
5. **Backend clears:** `clearPendingRequestIfMatches(sessionId, requestId)`

## Data Persistence

### In-Memory (Session Running)

- **MessageStateService:** Stores `MessageWithState` objects and raw events
- **ChatEventForwarderService:** Stores pending interactive requests

### On Disk (Session Not Running)

- **JSONL files:** `~/.claude/projects/<hash>/conversation.jsonl`
- Loaded via `SessionManager.getHistory(claudeSessionId, workingDir)`
- Converted to `HistoryMessage[]` then to `MessageWithState[]`

### Database (Prisma/SQLite)

- **ClaudeSession:** `claudeSessionId` links to JSONL file location
- **Workspace:** Contains session relationships

## Reconnection Guarantees

The architecture guarantees:

1. **Same messages:** Whether live streaming or reconnecting, frontends receive identical `ChatMessage[]`
2. **No message loss:** Store-then-forward ensures events are captured before broadcast
3. **State consistency:** `sendSnapshot()` provides complete state in one message
4. **Interactive request preservation:** Pending questions/permissions survive reconnect

## File Locations

| Service | Path |
|---------|------|
| ChatConnectionService | `src/backend/services/chat-connection.service.ts` |
| MessageStateService | `src/backend/services/message-state.service.ts` |
| ChatEventForwarderService | `src/backend/services/chat-event-forwarder.service.ts` |
| ChatMessageHandlerService | `src/backend/services/chat-message-handlers.service.ts` |
| Chat WebSocket Handler | `src/backend/routers/websocket/chat.handler.ts` |
| Frontend Chat Reducer | `src/components/chat/chat-reducer.ts` |
| Frontend WebSocket Hook | `src/components/chat/use-chat-websocket.ts` |
| Frontend State Hook | `src/components/chat/use-chat-state.ts` |
