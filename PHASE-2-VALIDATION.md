# Phase 2 Validation Checklist

## Quick Validation (5 minutes)

Run the automated smoke test:

```bash
./scripts/phase-2-smoke-test.sh
```

Or manually check:

### ✅ Step 1: TypeScript Compilation
```bash
npx tsc --noEmit
```
**Expected**: No errors

### ✅ Step 2: Start Backend Server
```bash
npm run dev:backend
```
**Expected Output**:
```
Initializing MCP tools...
Registered MCP tool: mcp__mail__send
Registered MCP tool: mcp__mail__get_inbox
Registered MCP tool: mcp__mail__read
Registered MCP tool: mcp__mail__reply
Registered MCP tool: mcp__agent__get_status
Registered MCP tool: mcp__agent__get_task
Registered MCP tool: mcp__agent__get_epic
Registered MCP tool: mcp__system__get_time
Registered MCP tool: mcp__task__update_state
Registered MCP tool: mcp__task__create_pr
Registered MCP tool: mcp__task__get_pr_status
Registered MCP tool: mcp__git__get_diff
Registered MCP tool: mcp__git__rebase
MCP tools initialized successfully
Backend server running on http://localhost:3001
```

### ✅ Step 3: Test Health Endpoint
```bash
curl http://localhost:3001/health
```
**Expected**: `{"status":"ok","timestamp":"...","service":"factoryfactory-backend"}`

### ✅ Step 4: Verify Files Exist
```bash
ls src/backend/clients/claude.client.ts
ls src/backend/agents/worker/worker.agent.ts
ls src/backend/agents/worker/worker.prompts.ts
ls src/backend/agents/worker/lifecycle.ts
ls src/backend/routers/mcp/task.mcp.ts
ls src/backend/routers/mcp/git.mcp.ts
ls src/backend/routers/api/task.router.ts
ls src/backend/inngest/functions/task-created.ts
```
**Expected**: All files exist

---

## Full End-to-End Validation (30 minutes)

### Prerequisites

1. **Set up environment variables**
   ```bash
   cp .env.example .env
   # Edit .env and fill in:
   # - GIT_BASE_REPO_PATH (path to test repo)
   # - GIT_WORKTREE_BASE (temp directory for worktrees)
   # - DATABASE_URL
   # Note: No ANTHROPIC_API_KEY needed - uses OAuth via `claude login`
   ```

2. **Database running and migrated**
   ```bash
   docker-compose up -d postgres
   npx prisma migrate dev
   ```

3. **Create a test epic** (via database or Linear)
   ```sql
   -- Example SQL to insert test epic
   INSERT INTO "Epic" (id, title, description, state, "createdAt", "updatedAt")
   VALUES (
     gen_random_uuid(),
     'Test Epic: Add Hello World Feature',
     'Test epic for Phase 2 validation',
     'ACTIVE',
     NOW(),
     NOW()
   );
   ```
   Note the epic ID for the next step.

### Test Scenario: Worker Completes Simple Task

#### 1️⃣ Create a Task

```bash
export EPIC_ID="<your-epic-id-here>"

curl -X POST http://localhost:3001/api/tasks/create \
  -H "Content-Type: application/json" \
  -d "{
    \"epicId\": \"$EPIC_ID\",
    \"title\": \"Add GET /hello endpoint\",
    \"description\": \"Create a simple GET endpoint at /hello that returns {message: 'Hello World'}\"
  }"
```

**Expected Response**:
```json
{
  "success": true,
  "data": {
    "taskId": "...",
    "epicId": "...",
    "title": "Add GET /hello endpoint",
    "state": "PENDING",
    "createdAt": "..."
  }
}
```

Save the `taskId` for next steps.

#### 2️⃣ Start Worker for Task

```bash
export TASK_ID="<task-id-from-above>"

curl -X POST http://localhost:3001/api/tasks/start-worker \
  -H "Content-Type: application/json" \
  -d "{\"taskId\": \"$TASK_ID\"}"
```

**Expected Response**:
```json
{
  "success": true,
  "data": {
    "agentId": "...",
    "taskId": "...",
    "tmuxSession": "worker-...",
    "isRunning": true
  }
}
```

#### 3️⃣ Monitor Worker Activity

**View tmux session**:
```bash
# List sessions
curl http://localhost:3001/api/terminal/sessions

# View specific session output
curl http://localhost:3001/api/terminal/session/worker-<session-id>/output
```

Or attach to tmux directly:
```bash
tmux attach-session -t worker-<session-id>
# Press Ctrl+B then D to detach
```

**Check backend logs** for worker activity:
- Tool invocations
- Decision logs
- State updates

#### 4️⃣ Verify Worker Progress

```bash
# Check task status
curl http://localhost:3001/api/tasks/status/$TASK_ID
```

**Expected**: State should progress through:
- `PENDING` → `ASSIGNED` → `IN_PROGRESS` → `REVIEW`

#### 5️⃣ Verify Outputs

**Check worktree created**:
```bash
ls $GIT_WORKTREE_BASE/task-*
```

**Check git branch created**:
```bash
cd $GIT_WORKTREE_BASE/task-*
git branch
# Should show: factoryfactory/task-...
```

**Check for code changes**:
```bash
cd $GIT_WORKTREE_BASE/task-*
git status
git log
```

**Check PR created** (if worker completed):
```bash
# The task status should include prUrl
curl http://localhost:3001/api/tasks/status/$TASK_ID | jq '.data.prUrl'
```

**Check decision logs** (in database):
```sql
SELECT * FROM "DecisionLog"
WHERE "agentId" = '<agent-id>'
ORDER BY "timestamp" DESC;
```

#### 6️⃣ Verify Mail Sent

```sql
-- Check mail table for completion notification
SELECT * FROM "Mail"
WHERE "fromAgentId" = '<worker-agent-id>'
ORDER BY "createdAt" DESC;
```

---

## Success Criteria Checklist

From PHASE-2.md, verify all of these:

- [ ] **Claude Client**: Can initialize Claude SDK and create agent
- [ ] **Worker Profile**: Worker uses correct model and permissions (from config)
- [ ] **Task Creation**: Can create task via API
- [ ] **Worker Start**: Can start worker for task via API
- [ ] **Agent Initialization**: Worker agent initializes with correct system prompt
- [ ] **Task Introspection**: Worker calls `mcp__agent__get_task` and gets task details
- [ ] **Epic Introspection**: Worker calls `mcp__agent__get_epic` and gets epic details
- [ ] **Code Writing**: Worker writes code in task worktree (visible in git status)
- [ ] **State Update**: Worker updates task state via `mcp__task__update_state`
- [ ] **PR Creation**: Worker creates PR via `mcp__task__create_pr`
- [ ] **PR Verification**: PR appears on GitHub with correct source/target branches
- [ ] **Mail Sending**: Worker sends completion mail (visible in Mail table)
- [ ] **Decision Logs**: All worker tool calls appear in decision logs
- [ ] **Tmux Session**: Can view worker activity in tmux session
- [ ] **Task State**: Task state updates to REVIEW after PR creation
- [ ] **Inngest Event**: `task.created` event triggers worker creation (optional)
- [ ] **Error Handling**: Worker handles tool errors gracefully

---

## Troubleshooting

### Worker doesn't start
- Check Claude is authenticated: `claude login`
- Check backend logs for errors
- Verify database connection
- Check tmux is installed: `which tmux`

### Git operations fail
- Verify `GIT_BASE_REPO_PATH` points to valid git repo
- Verify `GIT_WORKTREE_BASE` directory exists and is writable
- Check git is installed: `git --version`

### PR creation fails
- Verify GitHub CLI is installed: `gh --version`
- Verify authenticated: `gh auth status`
- Check repository has push access

### Worker hangs or loops infinitely
- Check worker iteration count (max 100)
- View tmux session to see what it's doing
- Check decision logs for repeated tool calls
- Stop worker manually: `POST /api/tasks/stop-worker`

### Claude API errors
- Check API key is valid
- Check rate limits
- Check network connectivity
- Review error in decision logs

---

## What to Look For

### Good Signs ✅
- Worker creates git worktree and branch
- Worker makes multiple tool calls (get_task, get_epic, etc.)
- Task state progresses: PENDING → ASSIGNED → IN_PROGRESS → REVIEW
- PR is created on GitHub
- Mail is sent to supervisor (or stored if no supervisor)
- Decision logs show all worker actions
- No TypeScript errors
- Server starts without errors

### Bad Signs ❌
- Worker crashes immediately
- No tool calls in decision logs
- Task stuck in PENDING or ASSIGNED
- No git worktree created
- No code changes visible
- TypeScript compilation errors
- Missing MCP tool registrations

---

## Phase 2 Complete! 🎉

If all checks pass, Phase 2 is successfully implemented and you're ready for Phase 3 (Supervisor agent).
