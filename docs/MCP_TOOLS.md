# MCP Tools Documentation

This document describes all available MCP (Model Context Protocol) tools that agents can use to interact with the system.

## Overview

The MCP server provides a registry of tools that agents can invoke. Each tool call is:
- **Permission-checked** based on agent type
- **Automatically logged** to the DecisionLog table
- **Retried** on transient failures
- **Escalated** to supervisors on critical failures

## Tool Execution

### Endpoint

```
POST /mcp/execute
```

### Request Format

```json
{
  "agentId": "agent-id-here",
  "toolName": "mcp__mail__send",
  "input": {
    "toAgentId": "recipient-id",
    "subject": "Hello",
    "body": "This is a message"
  }
}
```

### Response Format

**Success:**
```json
{
  "success": true,
  "data": {
    "mailId": "mail-123",
    "timestamp": "2026-01-22T..."
  },
  "timestamp": "2026-01-22T..."
}
```

**Error:**
```json
{
  "success": false,
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "Tool 'mcp__mail__send' is not allowed for agent type 'WORKER'",
    "details": {}
  },
  "timestamp": "2026-01-22T..."
}
```

## Tool Permission System

### Agent Types and Permissions

#### SUPERVISOR
- **Allowed:** All tools (`*`)
- **Disallowed:** None

#### ORCHESTRATOR
- **Allowed:**
  - `mcp__mail__*`
  - `mcp__agent__*`
  - `mcp__system__*`
  - `mcp__task__*`
  - `mcp__epic__*`
- **Disallowed:**
  - `mcp__supervisor__*`

#### WORKER
- **Allowed:**
  - `mcp__mail__*`
  - `mcp__agent__get_status`
  - `mcp__agent__get_task`
  - `mcp__agent__get_epic`
  - `mcp__system__log_decision`
  - `mcp__task__update_status`
  - `mcp__task__add_comment`
- **Disallowed:**
  - `mcp__supervisor__*`
  - `mcp__orchestrator__*`
  - `mcp__epic__*`
  - `mcp__task__create`
  - `mcp__task__assign`

## Mail Tools

### mcp__mail__list_inbox

List mail in the agent's inbox.

**Input:**
```json
{
  "includeRead": false  // Optional, default: false
}
```

**Output:**
```json
{
  "count": 2,
  "unreadCount": 1,
  "mails": [
    {
      "id": "mail-123",
      "fromAgentId": "agent-456",
      "fromAgentType": "SUPERVISOR",
      "subject": "Task Assignment",
      "body": "Please work on task XYZ",
      "isRead": false,
      "createdAt": "2026-01-22T...",
      "readAt": null
    }
  ]
}
```

**Permissions:** SUPERVISOR, ORCHESTRATOR, WORKER

---

### mcp__mail__read

Read a specific mail and mark it as read.

**Input:**
```json
{
  "mailId": "mail-123"
}
```

**Output:**
```json
{
  "id": "mail-123",
  "fromAgentId": "agent-456",
  "fromAgentType": "SUPERVISOR",
  "subject": "Task Assignment",
  "body": "Please work on task XYZ",
  "isRead": true,
  "createdAt": "2026-01-22T...",
  "readAt": "2026-01-22T..."
}
```

**Errors:**
- `RESOURCE_NOT_FOUND`: Mail doesn't exist
- `PERMISSION_DENIED`: Mail belongs to another agent

**Permissions:** SUPERVISOR, ORCHESTRATOR, WORKER

---

### mcp__mail__send

Send mail to another agent or to a human.

**Input:**
```json
{
  "toAgentId": "agent-789",  // Optional, mutually exclusive with toHuman
  "toHuman": false,           // Optional, mutually exclusive with toAgentId
  "subject": "Need Help",
  "body": "I'm stuck on this task and need assistance"
}
```

**Output:**
```json
{
  "mailId": "mail-456",
  "timestamp": "2026-01-22T..."
}
```

**Errors:**
- `INVALID_INPUT`: Must specify either `toAgentId` or `toHuman: true`

**Side Effects:**
- Fires `mail.sent` Inngest event
- Updates sender's `lastActiveAt` timestamp

**Permissions:** SUPERVISOR, ORCHESTRATOR, WORKER

---

### mcp__mail__reply

Reply to a received mail.

**Input:**
```json
{
  "originalMailId": "mail-123",
  "body": "Thanks, I'll get started on that task"
}
```

**Output:**
```json
{
  "mailId": "mail-789",
  "timestamp": "2026-01-22T..."
}
```

**Errors:**
- `RESOURCE_NOT_FOUND`: Original mail doesn't exist
- `PERMISSION_DENIED`: Can only reply to mail you received

**Side Effects:**
- Automatically adds "Re: " prefix to subject if not present
- Sends reply to the original sender
- Fires `mail.sent` Inngest event

**Permissions:** SUPERVISOR, ORCHESTRATOR, WORKER

---

## Agent Introspection Tools

### mcp__agent__get_status

Get the current agent's status and metadata.

**Input:**
```json
{}
```

**Output:**
```json
{
  "id": "agent-123",
  "type": "WORKER",
  "state": "BUSY",
  "currentEpicId": "epic-456",
  "currentTaskId": "task-789",
  "tmuxSessionName": "worker-123-session",
  "lastActiveAt": "2026-01-22T...",
  "createdAt": "2026-01-22T...",
  "updatedAt": "2026-01-22T..."
}
```

**Permissions:** SUPERVISOR, ORCHESTRATOR, WORKER

---

### mcp__agent__get_task

Get the current agent's task details (WORKER only).

**Input:**
```json
{}
```

**Output:**
```json
{
  "id": "task-789",
  "title": "Implement user authentication",
  "description": "Add JWT-based authentication to the API",
  "state": "IN_PROGRESS",
  "epicId": "epic-456",
  "worktreePath": "/path/to/worktree",
  "branchName": "feature/auth",
  "prUrl": null,
  "createdAt": "2026-01-22T...",
  "updatedAt": "2026-01-22T..."
}
```

**Errors:**
- `INVALID_AGENT_STATE`: Agent is not a WORKER
- `INVALID_AGENT_STATE`: WORKER doesn't have a current task

**Permissions:** WORKER only

---

### mcp__agent__get_epic

Get the current agent's epic details.

**Input:**
```json
{}
```

**Output:**
```json
{
  "id": "epic-456",
  "linearIssueId": "LIN-123",
  "linearIssueUrl": "https://linear.app/...",
  "title": "User Management System",
  "description": "Complete overhaul of user management",
  "state": "IN_PROGRESS",
  "createdAt": "2026-01-22T...",
  "updatedAt": "2026-01-22T...",
  "completedAt": null
}
```

**Logic:**
- **SUPERVISOR/ORCHESTRATOR:** Uses `agent.currentEpicId`
- **WORKER:** Gets epic via `task.epicId`

**Errors:**
- `INVALID_AGENT_STATE`: Agent doesn't have a current epic
- `INVALID_AGENT_STATE`: WORKER doesn't have a current task
- `RESOURCE_NOT_FOUND`: Epic not found

**Permissions:** SUPERVISOR, ORCHESTRATOR, WORKER

---

## System Tools

### mcp__system__log_decision

Manually log a decision or business logic event.

**Input:**
```json
{
  "title": "Decided to refactor authentication",
  "body": "The current auth implementation has security issues. Refactoring to use JWT tokens instead of session cookies."
}
```

**Output:**
```json
{
  "logId": "log-123",
  "timestamp": "2026-01-22T..."
}
```

**Permissions:** SUPERVISOR, ORCHESTRATOR, WORKER

---

## Decision Logging

All MCP tool calls are automatically logged to the `DecisionLog` table with three types:

### Automatic Logs

1. **Tool Invocation** (before execution)
   - Decision: `Invoked tool: mcp__mail__send`
   - Reasoning: `Automatic tool invocation log`
   - Context: JSON of input parameters

2. **Tool Result** (after success)
   - Decision: `Tool result: mcp__mail__send`
   - Reasoning: `Automatic tool result log`
   - Context: JSON of output data

3. **Tool Error** (after failure)
   - Decision: `Tool error: mcp__mail__send`
   - Reasoning: `Automatic tool error log`
   - Context: JSON with error message and stack trace

### Manual Logs

Agents can create custom decision logs using `mcp__system__log_decision` for business logic documentation.

---

## Error Handling

### Error Codes

- `PERMISSION_DENIED` - Agent doesn't have permission to use this tool
- `TOOL_NOT_FOUND` - Tool doesn't exist in registry
- `INVALID_INPUT` - Input validation failed
- `AGENT_NOT_FOUND` - Agent ID doesn't exist
- `RESOURCE_NOT_FOUND` - Referenced resource (mail, task, epic) doesn't exist
- `INVALID_AGENT_STATE` - Agent is in wrong state for this operation
- `INTERNAL_ERROR` - Unexpected server error
- `TRANSIENT_ERROR` - Temporary failure (will be retried)

### Retry Logic

- Transient errors are retried up to 3 times
- Retry delay: 1000ms between attempts
- Errors matching patterns: `/timeout/i`, `/connection/i`, `/network/i`

### Escalation

#### Normal Tool Failures
- Creates mail to agent's supervisor
- Includes error details and stack trace

#### Critical Tool Failures
- Tools marked as critical: `mcp__mail__send`, `mcp__agent__get_task`, `mcp__agent__get_epic`, `mcp__task__update_status`, `mcp__epic__update_status`
- Always sends mail to human
- Marked with ⚠️ CRITICAL prefix

---

## Events

### mail.sent

Fired whenever mail is sent via `mcp__mail__send` or `mcp__mail__reply`.

**Event Data:**
```json
{
  "mailId": "mail-123",
  "toAgentId": "agent-456",
  "isForHuman": false,
  "subject": "Need Help"
}
```

**Handler:** `src/backend/inngest/functions/mail-sent.ts`

**Current Behavior:** Logs event to console

**Future:** Trigger notifications, wake up receiving agent

---

## Examples

### Example 1: Worker sends mail to supervisor

```bash
curl -X POST http://localhost:3001/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "worker-123",
    "toolName": "mcp__mail__send",
    "input": {
      "toAgentId": "supervisor-456",
      "subject": "Task Blocked",
      "body": "I need help unblocking this task"
    }
  }'
```

### Example 2: Supervisor reads inbox

```bash
curl -X POST http://localhost:3001/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "supervisor-456",
    "toolName": "mcp__mail__list_inbox",
    "input": {}
  }'
```

### Example 3: Worker logs a decision

```bash
curl -X POST http://localhost:3001/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "worker-123",
    "toolName": "mcp__system__log_decision",
    "input": {
      "title": "Chose implementation approach",
      "body": "Decided to use Redis for caching instead of in-memory cache for better scalability"
    }
  }'
```

---

## Testing

See `src/backend/testing/test-scenarios.ts` for comprehensive test examples.

Run tests:
```bash
npm run backend:dev
# In another terminal:
tsx src/backend/testing/test-scenarios.ts
```
