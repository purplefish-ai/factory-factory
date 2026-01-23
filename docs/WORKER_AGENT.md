# Worker Agent Documentation

## Overview

Worker agents are autonomous software engineers that execute specific coding tasks. Each worker is responsible for:
- Understanding their assigned task
- Writing code to implement the feature or fix
- Running tests to verify their changes
- Creating a pull request for review

## Architecture

### Claude Code CLI Integration

Workers use the **Claude Code CLI** instead of the Anthropic SDK. This provides:

- ✅ **OAuth Authentication**: Users authenticate once with `claude login` (no API keys needed)
- ✅ **Session Persistence**: Workers can resume after crashes
- ✅ **Full Observability**: All worker activity is visible in tmux sessions
- ✅ **Subscription Billing**: Usage billed to Claude subscription (Free/Pro/Team)

### Process Model

```
FactoryFactory Backend
 └── Worker Agent
     └── Tmux Session (worker-abc12345)
         └── Claude Code CLI Process
             ├── Environment: ANTHROPIC_API_KEY removed ✓
             ├── Reads ~/.claude.json (OAuth) ✓
             ├── System prompt injected via --append-system-prompt-file ✓
             ├── Permissions: --dangerously-skip-permissions ✓
             └── Communication: tmux send-keys/capture-pane ✓
```

### Worker Lifecycle

1. **Creation**: Task is created and assigned to worker
2. **Initialization**: Worker creates git worktree and tmux session
3. **Execution**: Worker runs Claude Code CLI and begins work
4. **Monitoring**: Backend monitors tmux output for tool calls
5. **Tool Execution**: Backend executes MCP tools on worker's behalf
6. **Completion**: Worker creates PR and updates task state
7. **Cleanup**: Tmux session preserved for inspection

## Prerequisites

### For Users

Before using workers, users must:

1. **Install Claude Code CLI**:
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

2. **Authenticate with Claude**:
   ```bash
   claude login
   ```
   This opens a browser for OAuth authentication and stores credentials in `~/.claude.json`.

3. **Verify Setup**:
   ```bash
   claude --version
   ls ~/.claude/.credentials.json  # Should exist
   ```

### For Developers

Environment variables:

```bash
# No ANTHROPIC_API_KEY needed! Uses OAuth instead.

# Optional: Override default model
WORKER_MODEL=claude-sonnet-4-5-20250929

# Git configuration
GIT_BASE_REPO_PATH=/path/to/repo
GIT_WORKTREE_BASE=/tmp/factoryfactory-worktrees

# Database
DATABASE_URL=postgresql://...

# Inngest (optional for Phase 2)
INNGEST_EVENT_KEY=...
INNGEST_SIGNING_KEY=...
```

## Creating and Starting Workers

### Via API

**1. Create a Task**:

```bash
curl -X POST http://localhost:3000/api/tasks/create \
  -H "Content-Type: application/json" \
  -d '{
    "epicId": "epic_abc123",
    "title": "Add GET /hello endpoint",
    "description": "Create a simple endpoint that returns {message: \"Hello World\"}"
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "taskId": "task_xyz789",
    "epicId": "epic_abc123",
    "title": "Add GET /hello endpoint",
    "state": "PENDING",
    "createdAt": "2026-01-23T..."
  }
}
```

**2. Start a Worker**:

```bash
curl -X POST http://localhost:3000/api/tasks/start-worker \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "task_xyz789"
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "agentId": "agent_def456",
    "taskId": "task_xyz789",
    "tmuxSession": "worker-agent_de",
    "isRunning": true
  }
}
```

**3. Check Task Status**:

```bash
curl http://localhost:3000/api/tasks/status/task_xyz789
```

Response:
```json
{
  "success": true,
  "data": {
    "taskId": "task_xyz789",
    "title": "Add GET /hello endpoint",
    "state": "IN_PROGRESS",
    "assignedAgentId": "agent_def456",
    "worktreePath": "/tmp/factoryfactory-worktrees/task-agent_de",
    "branchName": "task/task-agent_de",
    "prUrl": null,
    "worker": {
      "agentId": "agent_def456",
      "isRunning": true,
      "agentState": "BUSY",
      "taskId": "task_xyz789",
      "tmuxSession": "worker-agent_de"
    }
  }
}
```

### Via Inngest Events

Workers can be automatically started when tasks are created:

```typescript
await inngest.send({
  name: 'task.created',
  data: {
    taskId: 'task_xyz789',
    epicId: 'epic_abc123',
    title: 'Add GET /hello endpoint'
  }
});
```

The `task.created` event handler will automatically start a worker.

## Monitoring Workers

### View Worker Activity

Attach to worker's tmux session:

```bash
# List all worker sessions
tmux list-sessions | grep worker-

# Attach to specific worker
tmux attach -t worker-agent_de
```

Press `Ctrl+B` then `D` to detach without stopping the worker.

### Worker Logs

All worker actions are logged to:
- **Console**: Backend logs show worker creation, tool calls, and completion
- **Tmux Output**: Full Claude Code CLI output
- **Decision Logs**: Database records of all MCP tool calls

### Worker Status

Check if worker is still running:

```bash
curl http://localhost:3000/api/tasks/status/task_xyz789
```

Look at `worker.isRunning` and `worker.agentState` fields.

## Worker MCP Tools

Workers have access to these MCP tools:

### Task Management
- `mcp__agent__get_task`: Get assigned task details
- `mcp__agent__get_epic`: Get epic context
- `mcp__task__update_state`: Update task state (PENDING → IN_PROGRESS → REVIEW → COMPLETED)
- `mcp__task__create_pr`: Create pull request to epic branch
- `mcp__task__get_pr_status`: Check PR status

### Git Operations
- `mcp__git__get_diff`: View changes between task and epic branches
- `mcp__git__rebase`: Rebase task branch onto epic branch

### Communication
- `mcp__mail__send`: Send mail to supervisor or other agents
- `mcp__mail__get_inbox`: Check inbox for messages

## Worker Workflow Example

Here's what a typical worker does:

```
1. Worker starts in tmux session
2. Claude receives system prompt with task details
3. Claude calls mcp__agent__get_task to see assignment
4. Claude calls mcp__task__update_state(IN_PROGRESS)
5. Claude reads existing code
6. Claude writes new code in worktree
7. Claude runs tests
8. Claude calls mcp__git__get_diff to review changes
9. Claude calls mcp__task__create_pr to create PR
10. Task state automatically updates to REVIEW
11. Claude calls mcp__mail__send to notify supervisor
12. Worker completes, tmux session remains for inspection
```

## Stopping Workers

### Graceful Stop

```bash
curl -X POST http://localhost:3000/api/tasks/stop-worker \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "agent_def456"
  }'
```

This sends `Ctrl+C` to Claude and updates agent state to IDLE.

### Force Kill and Cleanup

```bash
curl -X POST http://localhost:3000/api/tasks/kill-worker \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "agent_def456"
  }'
```

This:
- Stops the worker
- Kills the tmux session
- Deletes the git worktree
- Cleans up temporary files

## Error Handling

### Authentication Errors

If Claude Code is not authenticated:

```json
{
  "error": "Claude Code is not properly set up",
  "details": "❌ Claude Code Setup Issues:\n\n1. Claude Code is not authenticated...",
  "authStatus": {
    "isInstalled": true,
    "isAuthenticated": false,
    "credentialsPath": "/Users/you/.claude/.credentials.json",
    "errors": [...]
  }
}
```

**Solution**: Run `claude login`

### Worker Failures

If worker encounters errors:
- Task state updates to `FAILED`
- `failureReason` field contains error message
- Tmux session preserved for debugging

### Tool Call Failures

If MCP tool fails:
- Error is returned to Claude
- Claude can retry or take alternative action
- All failures logged to decision log

## Troubleshooting

### Worker Not Starting

1. Check Claude Code installation:
   ```bash
   which claude
   ```

2. Check authentication:
   ```bash
   ls ~/.claude/.credentials.json
   ```

3. Check backend logs for errors

### Worker Stuck

1. Attach to tmux session to see what Claude is doing:
   ```bash
   tmux attach -t worker-agent_de
   ```

2. Check if Claude is waiting for input

3. Check backend logs for tool execution errors

### Worker Completed But No PR

1. Check task state:
   ```bash
   curl http://localhost:3000/api/tasks/status/task_xyz789
   ```

2. Check for `failureReason` field

3. Attach to tmux session to see Claude's output

4. Check decision logs for tool call failures

## Advanced Topics

### Session Resume

Workers support resume after crashes:

```typescript
// Backend automatically stores sessionId in database
// If worker crashes, can resume with same session ID
await resumeSession(agentId, sessionId, workingDir);
```

### Custom Models

Override default model per agent type:

```bash
export WORKER_MODEL=claude-opus-4-5-20251101
```

### Tool Call Parsing

Backend parses Claude CLI output for tool calls:

```typescript
// Looks for patterns like:
// <tool_use>
//   <tool_name>mcp__task__update_state</tool_name>
//   <tool_input>{"state": "IN_PROGRESS"}</tool_input>
// </tool_use>
```

### MCP Bridge

The MCP bridge:
1. Monitors tmux output every 5 seconds
2. Parses tool calls from Claude output
3. Executes tools via `executeMcpTool()`
4. Formats results and sends back to Claude via tmux

## Next Steps

In Phase 3, we'll add:
- **Supervisor Agent**: Coordinates workers and reviews PRs
- **Rebase Cascade**: Automatic rebasing when epic updates
- **Task Assignment**: Supervisor creates and assigns tasks to workers
- **PR Review**: Supervisor reviews and approves/rejects PRs

## See Also

- [PHASE-2.md](../PHASE-2.md) - Phase 2 implementation plan
- [MCP_TOOLS.md](./MCP_TOOLS.md) - Complete MCP tool reference
- [CLAUDE_CODE_SETUP.md](./CLAUDE_CODE_SETUP.md) - Claude Code installation guide
