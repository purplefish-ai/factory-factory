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

## How to test manually

1. **Log in to the web app:**
   Open the web app in a browser. Log in with the account created in phase 3. Verify you see the workspace list.

2. **Create a workspace from a GitHub issue:**
   Click "New Workspace", paste a GitHub issue URL, submit. Verify:
   - Workspace appears in the list with status "Provisioning" then "Ready"
   - The VM has cloned the repo

3. **Send a message and see streaming response:**
   Open the workspace. Type a message to Claude. Verify:
   - Claude's response streams in token-by-token (not all at once)
   - Thinking indicators show during processing
   - Tool use events are visible

4. **Answer a question from Claude:**
   Send a prompt that triggers Claude to ask a user question (e.g., "Create a file called test.txt with whatever content you think is best, but ask me first"). Verify:
   - The question appears in the UI
   - You can type an answer and send it
   - Claude continues based on your answer

5. **Permission request flow:**
   Send a prompt that triggers a permission request. Verify:
   - The permission dialog appears
   - You can approve or deny
   - Claude proceeds or stops accordingly

6. **Reconnection:**
   With a session running, close the browser tab and reopen the workspace. Verify:
   - Full conversation history is restored (via `messages_snapshot`)
   - If Claude is still responding, streaming resumes

7. **Desktop and web see the same workspaces:**
   Send a workspace to cloud from desktop. Open the web app. Verify it appears in the web workspace list with correct status.

## Done when

A user can log into the web app, create a workspace from a GitHub issue, interact with Claude in real time (send messages, answer questions, approve permissions), and see streaming responses — the same experience they'd get on desktop.
