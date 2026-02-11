# Phase 4: WebSocket Relay + Web Frontend

**Goal:** Wire up real-time communication and build a web UI so users can interact with cloud workspaces without the desktop app.

## 4.1 WebSocket Relay

FF Cloud acts as a message router between clients and VMs:

```
Client (web/desktop) <--WebSocket--> FF Cloud <--WebSocket--> VM (FF Core)
```

**Message routing:**
- Client sends message with `workspaceId`
- FF Cloud looks up which VM owns that workspace
- FF Cloud forwards message to the VM's WebSocket connection
- VM processes via FF Core, streams responses back through FF Cloud to client

**Message types** — reuse the same protocol desktop already uses:

| Type | Direction | Description |
|------|-----------|-------------|
| `user_message` | Client -> VM | User sends message to Claude |
| `claude_message` | VM -> Client | Claude's response (streaming) |
| `status` | VM -> Client | Session status (running/idle) |
| `user_question` | VM -> Client | Claude asks user a question |
| `permission_request` | VM -> Client | Permission prompt |
| `question_response` | Client -> VM | Answer to question |
| `permission_response` | Client -> VM | Permission approval/denial |
| `messages_snapshot` | VM -> Client | Full state on connect/reconnect |

**Auth:** JWT validated on every WebSocket connection (built in phase 3).

**Reconnection:** On reconnect, VM sends `messages_snapshot` with full conversation state so the client can catch up.

## 4.2 Web Frontend

A web app (React, similar stack to desktop UI) that connects to FF Cloud:

- **Workspace list:** View all cloud workspaces with status indicators
- **Create workspace:** From GitHub issue URL
- **Session view:** Send messages, see Claude's streaming responses, answer questions, approve/deny permissions
- **Workspace status:** Running, idle, waiting for input, error

The web frontend talks to FF Cloud via the same WebSocket relay and tRPC API. It does not talk to VMs directly.

## Done when

A user can log into the web app, create a workspace from a GitHub issue, interact with Claude in real time (send messages, answer questions, approve permissions), and see streaming responses — the same experience they'd get on desktop.
