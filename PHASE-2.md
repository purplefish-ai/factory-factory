# Phase 2: Worker Agent & Task Execution ✅ COMPLETE

> **Status**: ✅ **COMPLETE** - Successfully validated on 2026-01-23
>
> **Validation**: Worker autonomously completed task "Add GET /hello endpoint v2" in 4m 22s
> - Created API endpoint with tests
> - Ran tests, linting, and type checking
> - Created PR: https://github.com/purplefish-ai/monorepo/pull/4282

## Overview
Implement the Worker agent with Claude Code CLI integration and the ability to execute tasks autonomously. Workers write code, create PRs, and work independently using Claude Code's built-in tools.

## Goals ✅
- ✅ Worker agent implementation using Claude Code CLI (not SDK)
- ✅ Claude Code process management with tmux sessions
- ✅ OAuth-based authentication (no API keys required)
- ✅ Manual task creation workflow via API
- ✅ End-to-end: Task → Worker codes feature → Creates PR

## Key Learnings & Architecture Decisions

### What Worked

1. **Claude Code's Built-in Tools**: Workers don't need custom MCP tools. Claude Code CLI has powerful built-in tools (Bash, Read, Write, Edit, Search) that are sufficient for autonomous coding.

2. **Full Context in System Prompt**: Providing task description, epic title, worktree path, and branch name directly in the system prompt lets workers start immediately without needing to query the backend.

3. **Atomic Tmux Commands**: Using `sh -c` to chain `set-buffer`, `paste-buffer`, and `send-keys Enter` prevents race conditions when sending messages.

4. **OAuth via ~/.claude.json**: Authentication file is at `~/.claude.json` (not `~/.claude/.credentials.json`). Matching vibe-kanban's approach.

### Architecture Change from Original Plan

**Original Plan**: Workers use custom MCP tools (`mcp__task__update_state`, `mcp__task__create_pr`, etc.) via MCP bridge that parses Claude output and executes tools.

**Actual Implementation**: Workers use Claude Code's built-in tools directly. They:
- Explore codebase with `Search` and `Read`
- Write code with `Write` and `Edit`
- Run tests and git commands with `Bash`
- Create PRs with `gh pr create`

This is simpler and more reliable than the MCP bridge approach.

## Implementation Summary

### Files Created/Modified

```
src/backend/
├── clients/
│   ├── claude-auth.ts       # NEW: Authentication checking
│   └── claude-code.client.ts # NEW: Claude Code CLI wrapper
├── agents/worker/
│   ├── worker.agent.ts      # MODIFIED: Uses CLI instead of SDK
│   ├── worker.prompts.ts    # MODIFIED: Simplified, no MCP tools
│   └── lifecycle.ts         # EXISTS: Worker lifecycle management
├── routers/api/
│   └── task.router.ts       # EXISTS: Task management API
└── inngest/functions/
    └── task-created.ts      # EXISTS: Auto-start workers

prisma/
└── schema.prisma            # MODIFIED: Added sessionId to Agent

docs/
└── WORKER_AGENT.md          # NEW: Worker documentation

scripts/
└── create-test-epic.ts      # NEW: Test epic creation script
```

### Key Components

#### 1. Claude Code Authentication (`claude-auth.ts`)
- `isClaudeCodeInstalled()` - Checks for `claude` CLI in PATH
- `isClaudeAuthenticated()` - Checks for `~/.claude.json`
- `validateClaudeSetup()` - Returns detailed status
- `requireClaudeSetup()` - Throws helpful error if not set up

#### 2. Claude Code Client (`claude-code.client.ts`)
- `createWorkerSession()` - Creates tmux session with Claude Code
- `sendMessage()` - Atomic message sending via tmux
- `captureOutput()` - Captures tmux pane content
- `stopSession()` / `killSession()` - Graceful and force stop
- Removes `ANTHROPIC_API_KEY` from environment to force OAuth

#### 3. Worker Agent (`worker.agent.ts`)
- `createWorker(taskId)` - Creates agent, worktree, tmux session
- `runWorker(agentId)` - Sends initial message, monitors progress
- `stopWorker()` / `killWorker()` - Stop and cleanup

#### 4. Worker Prompt (`worker.prompts.ts`)
- Simple, focused prompt for autonomous coding
- Includes full task context (description, worktree, branch)
- Instructs worker to use git commands and gh CLI
- No MCP tools referenced

### API Endpoints

```
POST /api/tasks/create        - Create new task
POST /api/tasks/start-worker  - Start worker for task
GET  /api/tasks/status/:id    - Get task and worker status
POST /api/tasks/stop-worker   - Stop worker gracefully
POST /api/tasks/kill-worker   - Force kill and cleanup
POST /api/tasks/recreate-worker - Recreate failed worker
```

## Smoke Test Results ✅

| Test | Status |
|------|--------|
| Claude Code installed | ✅ |
| Claude authenticated (`~/.claude.json`) | ✅ |
| `validateClaudeSetup()` returns success | ✅ |
| Epic creation via script | ✅ |
| Task creation via API | ✅ |
| Worker start via API | ✅ |
| Claude spawns in tmux | ✅ |
| Worker explores codebase | ✅ |
| Worker writes code | ✅ |
| Worker runs tests | ✅ |
| Worker commits changes | ✅ |
| Worker pushes branch | ✅ |
| Worker creates PR | ✅ |
| Tmux session observable | ✅ |
| OAuth (no API key) | ✅ |

## Usage

### Prerequisites

```bash
# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Authenticate (one time)
claude login

# Verify
claude --version
ls ~/.claude.json
```

### Starting a Worker

```bash
# 1. Start backend
npm run backend:dev

# 2. Create epic (first time only)
npx tsx scripts/create-test-epic.ts

# 3. Create task
curl -X POST http://localhost:3001/api/tasks/create \
  -H "Content-Type: application/json" \
  -d '{"epicId": "<EPIC_ID>", "title": "Add feature X", "description": "..."}'

# 4. Start worker
curl -X POST http://localhost:3001/api/tasks/start-worker \
  -H "Content-Type: application/json" \
  -d '{"taskId": "<TASK_ID>"}'

# 5. Watch worker (optional)
tmux attach -t worker-<AGENT_ID>
```

## Environment Variables

```bash
# Database
DATABASE_URL=postgresql://...

# Git (required)
GIT_BASE_REPO_PATH=/path/to/repo
GIT_WORKTREE_BASE=/tmp/factoryfactory-worktrees

# Server
BACKEND_PORT=3001

# Optional
WORKER_MODEL=claude-sonnet-4-5-20250929
```

Note: `ANTHROPIC_API_KEY` is **not needed** - uses OAuth via `claude login`.

## Known Limitations & Future Work

See `v2-backlog-todo-list.md` for detailed backlog. Key items:

1. **Multi-Project Support** (High Priority)
   - Currently `GIT_BASE_REPO_PATH` is env var
   - Need `Project` model to support multiple repos

2. **MCP Tool Integration** (Medium Priority)
   - Could register backend as MCP server for richer integration
   - Workers could update task state directly via MCP

3. **Worker Dashboard** (Medium Priority)
   - UI to view active workers
   - Stream worker output in real-time

## Next Phase

**Phase 3: Supervisor Agent** will add:
- Supervisor that coordinates workers
- PR review workflow
- Task assignment and prioritization
- Rebase cascade management

## Git Tag

```bash
git tag phase-2-complete
```
