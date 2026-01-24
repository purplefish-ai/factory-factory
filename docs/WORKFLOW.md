# Factory Factory Workflow

This document describes the complete end-to-end workflow from epic creation through PR merge and human notification.

## Overview

Factory Factory uses a three-tier agent hierarchy:

```
Orchestrator (1 per system) → monitors health, manages supervisors
    └── Supervisor (1 per epic) → breaks down tasks, reviews/merges PRs
            └── Worker (1 per subtask) → implements in isolated git worktree
```

## Complete Workflow

### 1. Epic Creation

**Entry Point:** Human creates epic via UI at `/projects/[slug]/epics/new`

**Flow:**
1. Human fills form (title, description, design document)
2. TRPC call: `task.create({parentId: null})`
3. Task created in database with `state: PLANNING`
4. Inngest event fired: `task.top_level.created`

**Key Files:**
- UI: `src/app/projects/[slug]/epics/new/page.tsx`
- API: `src/backend/trpc/task.trpc.ts`
- Event: `src/backend/inngest/events.ts`

---

### 2. Supervisor Creation

**Trigger:** Inngest handler `topLevelTaskCreatedHandler`

**Flow:**
1. Verify task exists and has `parentId = null`
2. Create Agent record (type: `SUPERVISOR`)
3. Create git worktree branching from project's default branch
   - Branch: `factoryfactory/top-level-{taskId:8}`
4. Start Claude Code session in tmux
5. Update task state: `PLANNING → IN_PROGRESS`
6. Start monitoring loops:
   - 5-second: monitor Claude output, parse/execute tool calls
   - 30-second: check inbox, notify about review queue
   - 7-minute: worker health checks

**Key Files:**
- Handler: `src/backend/inngest/functions/top-level-task-created.ts`
- Lifecycle: `src/backend/agents/supervisor/lifecycle.ts`
- Agent: `src/backend/agents/supervisor/supervisor.agent.ts`

---

### 3. Task Breakdown

**Actor:** Supervisor agent (Claude Code)

**Flow:**
1. Supervisor reads task description and design document
2. Analyzes work required
3. Creates subtasks via `mcp__task__create` tool
   - Each subtask has clear title, description, acceptance criteria
   - Subtasks are atomic and independently implementable
4. For each subtask created:
   - Task record created with `parentId: epicId`, `state: PENDING`
   - `startWorker(taskId)` called immediately

**Planning Guidelines:**
- 2-5 subtasks per epic (balance granularity vs coordination overhead)
- Each task should be "atomic" - one focused change
- Descriptions include all context needed for implementation

**Key Files:**
- MCP tool: `src/backend/routers/mcp/task.mcp.ts` (createTask)
- Planning prompt: `prompts/supervisor-planning.md`

---

### 4. Worker Execution

**Trigger:** Called directly from `mcp__task__create` → `startWorker()`

**Flow:**
1. Create Agent record (type: `WORKER`)
2. Create git worktree branching from **epic branch** (not main!)
   - Branch: `factoryfactory/task-{agentId:8}`
   - This ensures workers have latest merged code
3. Update task: `state: ASSIGNED`, set `worktreePath`, `branchName`, `assignedAgentId`
4. Start Claude Code session in tmux
5. Start monitoring loops:
   - 5-second: monitor output, execute tool calls
   - 30-second: check inbox for supervisor messages

**Worker Implementation Phase:**
1. Worker reads task description via `mcp__agent__get_task`
2. Makes code changes in isolated worktree
3. Commits changes to their branch
4. When ready, calls `mcp__task__create_pr`:
   - Creates PR from worker branch → epic branch
   - Updates task state: `IN_PROGRESS → REVIEW`
   - Sends mail to supervisor

**Worker MCP Tools:**
| Tool | Purpose |
|------|---------|
| `mcp__task__update_state` | Transition task state |
| `mcp__task__create_pr` | Submit work for review |
| `mcp__git__get_diff` | View changes |
| `mcp__git__rebase` | Rebase onto updated epic branch |
| `mcp__mail__*` | Communication with supervisor |

**Key Files:**
- Agent: `src/backend/agents/worker/worker.agent.ts`
- Lifecycle: `src/backend/agents/worker/lifecycle.ts`
- Permissions: `src/backend/routers/mcp/permissions.ts`

---

### 5. Supervisor Review

**Actor:** Supervisor agent monitoring review queue

**Flow:**
1. Every 30 seconds, supervisor checks `taskAccessor.getReviewQueue()`
2. Tasks in REVIEW state returned in FIFO order (by `updatedAt`)
3. Supervisor prompted when new tasks appear in queue
4. For each task, supervisor can:

**APPROVE** (`mcp__task__approve`):
```
1. Merge worker branch INTO epic branch
2. Push epic branch to origin
3. Mark task: REVIEW → COMPLETED
4. Clean up worker session
5. For OTHER tasks still in REVIEW:
   - Set state to BLOCKED
   - Send rebase request mail to workers
```

**REQUEST CHANGES** (`mcp__task__request_changes`):
```
1. Send feedback mail to worker
2. Mark task: REVIEW → IN_PROGRESS
3. Worker continues work
```

**Sequential Merge Strategy:**
- Only ONE merge happens at a time
- Other pending reviews are BLOCKED
- Blocked workers must rebase: `git fetch && git rebase origin/{epicBranch}`
- This prevents complex merge conflicts

**Key Files:**
- Review queue: `src/backend/resource_accessors/task.accessor.ts`
- Approve/request changes: `src/backend/routers/mcp/task.mcp.ts`
- Review prompt: `prompts/supervisor-review.md`

---

### 6. Final PR to Main

**Trigger:** All subtasks in terminal state (COMPLETED or FAILED)

**Flow:**
1. Supervisor calls `mcp__task__create_final_pr`
2. Validation: all subtasks must be COMPLETED or FAILED
3. Create PR: epic branch → main
   - Title: `[Task] {epicTitle}`
   - Description: summary of completed/failed subtasks
4. Clean up ALL worker sessions for this epic
5. Mark epic task: `COMPLETED`
6. Send completion mail to human
7. Fire Inngest event: `agent.completed`

**Key Files:**
- Final PR: `src/backend/routers/mcp/task.mcp.ts` (createFinalPR)
- GitHub client: `src/backend/clients/github.client.ts`

---

### 7. Human Notification

**Three notification channels:**

**Desktop Notifications:**
- macOS: osascript with Glass.aiff sound
- Linux: notify-send (fallback to zenity)
- Windows: PowerShell Toast Notifications
- Configurable quiet hours

**Mail Inbox (Web UI):**
- View at `/projects/[slug]/mail`
- Real-time polling (5-second refresh)
- Filter by: My Inbox, All Mail, Agent Inbox
- Supports threading and replies

**Decision Logs:**
- Audit trail of all agent decisions
- Used for debugging and post-mortems

**Notification Events:**
| Event | Notification |
|-------|--------------|
| Epic complete | Desktop + Mail with PR URL |
| Task failed | Desktop (forced) + Mail |
| Critical error | Desktop (forced, bypasses quiet hours) |
| Worker message | Mail only |

**Key Files:**
- Notification service: `src/backend/services/notification.service.ts`
- Mail accessor: `src/backend/resource_accessors/mail.accessor.ts`
- Mail UI: `src/app/projects/[slug]/mail/`

---

## Branch Architecture

```
main
  │
  └── factoryfactory/top-level-{epicId}     ← Epic branch (supervisor's worktree)
        │
        ├── factoryfactory/task-{agentId1}  ← Worker 1 branch
        ├── factoryfactory/task-{agentId2}  ← Worker 2 branch
        └── factoryfactory/task-{agentId3}  ← Worker 3 branch

Worker PRs target: epic branch
Final PR targets: main
```

---

## State Machines

### Task States

**Top-Level Task (Epic):**
```
PLANNING → IN_PROGRESS → COMPLETED
                      → FAILED
                      → BLOCKED
                      → CANCELLED
```

**Subtask:**
```
PENDING → ASSIGNED → IN_PROGRESS → REVIEW → COMPLETED
   ↓                     ↓           ↓
 BLOCKED              FAILED      IN_PROGRESS (rework)
```

### Agent States

```
IDLE → BUSY ↔ WAITING
        ↓
      FAILED
```

---

## Communication Patterns

### Agent-to-Agent (via Mail System)

| From | To | Purpose |
|------|----|---------|
| Worker | Supervisor | Task complete notification |
| Supervisor | Worker | Rebase request |
| Supervisor | Worker | Change request feedback |
| System | Supervisor | Worker recovery notification |

### System-to-Human

| Trigger | Channel |
|---------|---------|
| Epic complete | Desktop + Mail |
| Task failed (permanent) | Desktop + Mail |
| Critical error | Desktop (forced) |
| Agent message | Mail |

---

## Error Handling & Recovery

### Worker Failure
1. Supervisor health check detects unhealthy worker (every 7 minutes)
2. Recovery attempted (up to max retries)
3. If permanent failure:
   - Desktop notification to human
   - Mail to supervisor
   - Task marked FAILED

### Supervisor Failure
1. Orchestrator health check detects unhealthy supervisor
2. Crash loop detection (multiple crashes within 1 hour)
3. Recovery with session resumption (preserves context)
4. If crash loop detected:
   - Critical error notification (bypasses quiet hours)
   - System marked unhealthy

### Conflict Resolution
1. Git merge attempted automatically
2. If conflicts occur, merge fails
3. Supervisor must manually resolve using `mcp__task__force_complete`
4. Manual resolution in epic branch worktree, then force complete

---

## Key File Reference

| Component | Location |
|-----------|----------|
| Database schema | `prisma/schema.prisma` |
| Task accessor | `src/backend/resource_accessors/task.accessor.ts` |
| Agent accessor | `src/backend/resource_accessors/agent.accessor.ts` |
| Mail accessor | `src/backend/resource_accessors/mail.accessor.ts` |
| Inngest events | `src/backend/inngest/events.ts` |
| Inngest handlers | `src/backend/inngest/functions/*.ts` |
| Supervisor agent | `src/backend/agents/supervisor/supervisor.agent.ts` |
| Worker agent | `src/backend/agents/worker/worker.agent.ts` |
| MCP tools | `src/backend/routers/mcp/*.ts` |
| Git client | `src/backend/clients/git.client.ts` |
| GitHub client | `src/backend/clients/github.client.ts` |
| Notification service | `src/backend/services/notification.service.ts` |
| Prompts | `prompts/*.md` |
