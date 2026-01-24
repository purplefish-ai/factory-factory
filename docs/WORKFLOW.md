# Factory Factory Workflow

This document describes the complete end-to-end workflow from epic creation through PR merge and human notification.

## Overview

Factory Factory uses a three-tier agent hierarchy:

```
Orchestrator (1 per system) → monitors health, manages supervisors
    └── Supervisor (1 per epic) → breaks down tasks, reviews/merges PRs
            └── Worker (1 per subtask) → implements in isolated git worktree
```

### Reconciliation-Based Architecture

The system uses a **level-triggered, declarative state management approach**:

- **Events update state** - Inngest events and MCP tool calls modify database state
- **Reconciler acts on mismatches** - A reconciliation loop compares desired vs actual state and remediates
- **Self-healing** - Crashed agents, orphaned tasks, and missing infrastructure are automatically recovered

This is simpler and more robust than pure event-driven architecture. See [Reconciliation](#reconciliation) for details.

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

**Trigger:** Reconciler detects top-level task in PLANNING state without a supervisor

**Flow:**
1. Human creates task → Inngest fires `task.top_level.created`
2. Handler triggers reconciliation via `reconcile.requested` event
3. **Reconciler runs** (Phase 2: Top-Level Tasks):
   - Finds tasks with `parentId = null` in PLANNING state without supervisor
   - Creates Agent record (type: `SUPERVISOR`, `desiredExecutionState: ACTIVE`)
   - Calls `createTopLevelTaskInfrastructure()`:
     - Creates git worktree branching from project's default branch
     - Branch: `factoryfactory/top-level-{taskId:8}`
4. **Reconciler runs** (Phase 4: Agent States):
   - Detects `desiredExecutionState: ACTIVE` but `executionState: IDLE`
   - Calls `transitionToActive()` → starts Claude Code session in tmux
5. Task state: `PLANNING → IN_PROGRESS`
6. Supervisor starts monitoring loops (JavaScript `setInterval` callbacks):
   - 5-second: monitor Claude output, parse/execute tool calls
   - 30-second: check inbox, notify about review queue
   - 7-minute: worker health checks

**Key Files:**
- Reconciler: `src/backend/services/reconciliation.service.ts`
- Inngest trigger: `src/backend/inngest/functions/reconciliation.ts`
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
   - **Worker started immediately** via direct `startWorker(taskId)` call (no Inngest event)

**Planning Guidelines:**
- 2-5 subtasks per epic (balance granularity vs coordination overhead)
- Each task should be "atomic" - one focused change
- Descriptions include all context needed for implementation

**Key Files:**
- MCP tool: `src/backend/routers/mcp/task.mcp.ts` (createTask)
- Planning prompt: `prompts/supervisor-planning.md`

---

### 4. Worker Execution

**Trigger:** Direct call from `mcp__task__create` → `startWorker(taskId)`

**Flow:**
1. `startWorker()` creates Agent record (type: `WORKER`, `desiredExecutionState: ACTIVE`)
2. Triggers reconciliation via `reconcile.requested` event
3. **Reconciler runs** (Phase 3: Leaf Tasks):
   - Detects task in PENDING state with missing infrastructure
   - Creates git worktree branching from **epic branch** (not main!)
     - Branch: `factoryfactory/task-{taskId:8}`
     - This ensures workers have latest merged code
   - Updates task: set `worktreePath`, `branchName`, `assignedAgentId`
4. **Reconciler runs** (Phase 4: Agent States):
   - Detects `desiredExecutionState: ACTIVE` but `executionState: IDLE`
   - Calls `transitionToActive()` → starts Claude Code session in tmux
5. Task state: `PENDING → IN_PROGRESS`
6. Worker starts monitoring loops (JavaScript `setInterval` callbacks):
   - 5-second: monitor output, execute tool calls
   - 10-second: check inbox for supervisor messages (rebase requests, feedback)

**Worker Implementation Phase:**
1. Worker reads task description via `mcp__agent__get_task`
2. Makes code changes in isolated worktree
3. Commits changes to their branch
4. When ready, calls `mcp__task__create_pr`:
   - Creates PR from worker branch → epic branch
   - Updates task state: `IN_PROGRESS → REVIEW`
   - Sends mail to supervisor
   - Fires desktop notification

**Worker MCP Tools:**
| Tool | Purpose |
|------|---------|
| `mcp__task__update_state` | Transition task state |
| `mcp__task__create_pr` | Submit work for review |
| `mcp__task__get_pr_status` | Check PR mergability/review status |
| `mcp__git__get_diff` | View changes |
| `mcp__git__rebase` | Rebase onto updated epic branch |
| `mcp__mail__*` | Communication with supervisor |

**Key Files:**
- Agent: `src/backend/agents/worker/worker.agent.ts`
- Lifecycle: `src/backend/agents/worker/lifecycle.ts`
- Permissions: `src/backend/routers/mcp/permissions.ts`
- Reconciler: `src/backend/services/reconciliation.service.ts`

---

### 5. Supervisor Review

**Actor:** Supervisor agent monitoring review queue

**Flow:**
1. Every 30 seconds, supervisor's inbox check loop runs
2. Calls `taskAccessor.getReviewQueue()` - returns tasks in REVIEW state (FIFO by `updatedAt`)
3. When NEW tasks appear in queue, supervisor is prompted: "NEW TASKS READY FOR REVIEW"
4. Supervisor can list queue with `mcp__task__get_review_queue`
5. For each task, supervisor can:

**APPROVE** (`mcp__task__approve`):
```
1. Validate task is in REVIEW state
2. Merge worker branch INTO epic branch (git merge)
3. Push epic branch to origin
4. Mark task: REVIEW → COMPLETED
5. Clean up worker session (set desiredExecutionState: IDLE)
6. For ALL OTHER tasks still in REVIEW:
   - Set state to BLOCKED
   - Send rebase request mail to workers
   - Workers must rebase against updated epic branch
```

**REQUEST CHANGES** (`mcp__task__request_changes`):
```
1. Send feedback mail to worker with specific feedback
2. Mark task: REVIEW → IN_PROGRESS
3. Worker receives mail via 10-second inbox check
4. Worker continues work and resubmits
```

**Sequential Merge Strategy:**
- Only ONE merge happens at a time
- After merge, ALL other pending reviews are BLOCKED
- Blocked workers must rebase: `git fetch && git rebase origin/{epicBranch}`
- This prevents complex merge conflicts
- Workers are notified via mail to rebase and resubmit

**Supervisor MCP Tools:**
| Tool | Purpose |
|------|---------|
| `mcp__task__create` | Create subtasks (starts worker immediately) |
| `mcp__task__list` | List all subtasks with optional state filter |
| `mcp__task__get_review_queue` | Get tasks in REVIEW state (FIFO order) |
| `mcp__task__approve` | Merge worker branch, mark completed |
| `mcp__task__request_changes` | Send feedback, move back to IN_PROGRESS |
| `mcp__task__force_complete` | Manual completion (for conflict recovery) |
| `mcp__task__create_final_pr` | Create PR from epic → main |

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
  └── factoryfactory/top-level-{epicId:8}   ← Epic branch (supervisor's worktree)
        │
        ├── factoryfactory/task-{taskId1:8} ← Worker 1 branch
        ├── factoryfactory/task-{taskId2:8} ← Worker 2 branch
        └── factoryfactory/task-{taskId3:8} ← Worker 3 branch

Worker PRs target: epic branch
Final PR targets: main

Note: {:8} indicates first 8 characters of the ID are used
```

---

## State Machines

**Important:** Task state and agent state are separate concerns. Task state is about the *work*, agent state is about the *executor*. See `docs/RECONCILIATION_DESIGN.md` for details.

### Task States (About the Work)

Task state answers: "What's the status of this deliverable?"

**Top-Level Task (Epic):**
```
PLANNING → IN_PROGRESS → COMPLETED
                      → FAILED
                      → BLOCKED
                      → CANCELLED
```

**Subtask:**
```
PENDING → IN_PROGRESS → REVIEW → COMPLETED
   ↓           ↓          ↓
 BLOCKED    FAILED    IN_PROGRESS (rework)
```

Note: `IN_PROGRESS` does NOT imply an agent is actively running. The task could be in progress with the agent paused (deferred work).

**Valid State Transitions:**

| From State | Allowed Transitions |
|------------|---------------------|
| PENDING | IN_PROGRESS, BLOCKED, FAILED |
| PLANNING | IN_PROGRESS, FAILED |
| IN_PROGRESS | REVIEW, BLOCKED, FAILED |
| REVIEW | COMPLETED, IN_PROGRESS, BLOCKED |
| BLOCKED | IN_PROGRESS, FAILED, PENDING |
| COMPLETED | *(terminal state)* |
| FAILED | IN_PROGRESS, PENDING *(can retry)* |

### Agent Execution States (About the Executor)

Agent state answers: "What's happening with this executor?"

```
┌─────────────────────────────────────────────────────────────┐
│  desiredExecutionState    │  What we WANT the agent to do  │
├───────────────────────────┼────────────────────────────────┤
│  ACTIVE                   │  Should be running             │
│  PAUSED                   │  Should NOT be running         │
│  IDLE                     │  No task, available            │
└───────────────────────────┴────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  executionState           │  What the agent IS doing       │
├───────────────────────────┼────────────────────────────────┤
│  ACTIVE                   │  Session running               │
│  PAUSED                   │  Intentionally stopped         │
│  IDLE                     │  Not assigned to work          │
│  CRASHED                  │  Was running, died             │
└───────────────────────────┴────────────────────────────────┘
```

The reconciler compares `desiredExecutionState` vs `executionState` and remediates.

### Example Scenarios

| Task State | Agent Desired | Agent Actual | Meaning |
|------------|---------------|--------------|---------|
| IN_PROGRESS | ACTIVE | ACTIVE | Normal: work happening |
| IN_PROGRESS | ACTIVE | CRASHED | Problem: reconciler will restart |
| IN_PROGRESS | PAUSED | PAUSED | Deferred: paused overnight |
| REVIEW | IDLE | IDLE | Normal: awaiting review |
| BLOCKED | PAUSED | PAUSED | Waiting on dependency |

---

## Reconciliation

The reconciler is the core state management mechanism. It runs as a four-phase loop that ensures reality matches desired state.

### Triggering

**Hybrid triggering** - both periodic and event-driven:

- **Cron:** Every 30 seconds via Inngest (`reconciliation/cron`)
- **Events:** `reconcile.requested` event with optional `taskId`/`agentId` for targeted reconciliation
- **Fallback:** If Inngest not running, reconciliation runs directly

### Four-Phase Reconciliation Loop

**Phase 1 - Crash Detection:**
```
Find agents where:
  - executionState = ACTIVE
  - lastHeartbeat > threshold (configurable, default from settings)
Mark as CRASHED, log recovery attempt
```

**Phase 2 - Top-Level Tasks:**
```
Find tasks where:
  - parentId = null (is epic)
  - state = PLANNING
  - no supervisor agent assigned
Create supervisor agent with desiredExecutionState: ACTIVE
Create git worktree infrastructure
```

**Phase 3 - Leaf Tasks:**
```
Find tasks where:
  - parentId != null (is subtask)
  - state = PENDING
  - missing infrastructure (no worktree, no branch)
Create worker agent if needed
Create git worktree branching from epic branch
Update task with infrastructure paths
```

**Phase 4 - Agent States:**
```
For each agent, compare desiredExecutionState vs executionState:
  - ACTIVE desired + (IDLE|CRASHED|PAUSED) actual → transitionToActive()
  - IDLE desired + (ACTIVE|PAUSED|CRASHED) actual → transitionToIdle()
  - PAUSED desired + ACTIVE actual → transitionToPaused()
```

### Infrastructure Tracking

Tasks and agents track infrastructure state:

**Task Fields:**
- `worktreePath` - Path to git worktree
- `branchName` - Git branch name
- `prUrl` - GitHub PR URL
- `assignedAgentId` - Worker agent ID
- `lastReconcileAt` - Last reconciliation timestamp
- `reconcileFailures` - JSON array of reconciliation errors

**Agent Fields:**
- `currentTaskId` - Associated task
- `tmuxSessionName` - Tmux session name (e.g., `supervisor-{id}`)
- `sessionId` - Claude Code CLI session ID (for resume on crash)
- `lastHeartbeat` - Last agent heartbeat
- `executionState` / `desiredExecutionState` - State pair for reconciliation

### Self-Healing Behavior

The reconciler automatically handles:

1. **Crashed agents** - Detected via stale heartbeat, restarted with session resume
2. **Orphaned tasks** - Tasks without assigned agents get agents created
3. **Missing infrastructure** - Worktrees/branches created if missing
4. **State drift** - Any mismatch between desired and actual state is remediated

**Key Files:**
- Reconciler: `src/backend/services/reconciliation.service.ts`
- Inngest functions: `src/backend/inngest/functions/reconciliation.ts`
- Design doc: `docs/RECONCILIATION_DESIGN.md`

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

**Detection (two mechanisms):**
1. **Reconciler crash detection** - Phase 1 checks for stale heartbeats (every 30 seconds)
2. **Supervisor health check** - 7-minute loop detects unhealthy workers

**Recovery Flow:**
1. Agent marked as `executionState: CRASHED`
2. Reconciler detects mismatch (`desired: ACTIVE`, `actual: CRASHED`)
3. `transitionToActive()` called with session resume (preserves context)
4. If recovery fails repeatedly:
   - Desktop notification to human
   - Mail to supervisor
   - Task marked FAILED
   - Reconcile failures logged to `task.reconcileFailures`

### Supervisor Failure

**Detection:**
1. Reconciler crash detection via stale heartbeat
2. Orchestrator health check (if running)

**Recovery Flow:**
1. Agent marked as `executionState: CRASHED`
2. Reconciler restarts with session resume
3. Crash loop detection (multiple crashes within 1 hour)
4. If crash loop detected:
   - Critical error notification (bypasses quiet hours)
   - System marked unhealthy

### Conflict Resolution

1. Git merge attempted automatically during `mcp__task__approve`
2. If conflicts occur, merge fails with error
3. Supervisor options:
   - Request changes from worker to fix conflicts
   - Manually resolve in epic branch worktree
   - Use `mcp__task__force_complete` to mark task done after manual fix

---

## Key File Reference

| Component | Location |
|-----------|----------|
| **Data Layer** | |
| Database schema | `prisma/schema.prisma` |
| Task accessor | `src/backend/resource_accessors/task.accessor.ts` |
| Agent accessor | `src/backend/resource_accessors/agent.accessor.ts` |
| Mail accessor | `src/backend/resource_accessors/mail.accessor.ts` |
| **Reconciliation** | |
| Reconciler service | `src/backend/services/reconciliation.service.ts` |
| Inngest reconciliation | `src/backend/inngest/functions/reconciliation.ts` |
| Design doc | `docs/RECONCILIATION_DESIGN.md` |
| **Agent System** | |
| Supervisor agent | `src/backend/agents/supervisor/supervisor.agent.ts` |
| Supervisor lifecycle | `src/backend/agents/supervisor/lifecycle.ts` |
| Worker agent | `src/backend/agents/worker/worker.agent.ts` |
| Worker lifecycle | `src/backend/agents/worker/lifecycle.ts` |
| **MCP Tools** | |
| Task tools | `src/backend/routers/mcp/task.mcp.ts` |
| Git tools | `src/backend/routers/mcp/git.mcp.ts` |
| Mail tools | `src/backend/routers/mcp/mail.mcp.ts` |
| Agent tools | `src/backend/routers/mcp/agent.mcp.ts` |
| Permissions | `src/backend/routers/mcp/permissions.ts` |
| **Inngest Events** | |
| Event definitions | `src/backend/inngest/events.ts` |
| Top-level task created | `src/backend/inngest/functions/top-level-task-created.ts` |
| Task created | `src/backend/inngest/functions/task-created.ts` |
| Agent completed | `src/backend/inngest/functions/agent-completed.ts` |
| **Clients & Services** | |
| Git client | `src/backend/clients/git.client.ts` |
| GitHub client | `src/backend/clients/github.client.ts` |
| Notification service | `src/backend/services/notification.service.ts` |
| **Prompts** | |
| Supervisor prompts | `prompts/supervisor-*.md` |
| Worker prompts | `prompts/worker-*.md` |
