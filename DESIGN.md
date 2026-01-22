# FactoryFactory Design Document

## Overview

FactoryFactory is an autonomous multi-agent software development system that uses LLM-powered agents to collaboratively build software. Agents work in isolated git worktrees and communicate via an internal mail system, with all interactive work happening in dedicated tmux sessions.

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Human Interface                          │
│  Next.js Frontend (App Router + tRPC + tmux-js)             │
│  - Epic Management    - Agent Monitor                        │
│  - Task Viewer        - Mail Inbox (Human + All Agents)      │
└───────────────────────┬─────────────────────────────────────┘
                        │ tRPC + HTTP
┌───────────────────────▼─────────────────────────────────────┐
│                   Backend (Node.js)                          │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │   Routers   │  │   Clients    │  │   Agents     │       │
│  │             │  │              │  │              │       │
│  │ - tRPC API  │  │ - Git        │  │ - Orchestrator      │
│  │ - MCP       │  │ - Tmux       │  │ - Supervisor │       │
│  │             │  │ - Claude SDK │  │ - Worker     │       │
│  │             │  │ - Inngest    │  │              │       │
│  └─────────────┘  └──────────────┘  └──────────────┘       │
│         │                 │                  │               │
│  ┌──────▼─────────────────▼──────────────────▼────────┐    │
│  │         Resource Accessors (Prisma)                 │    │
│  └──────────────────────┬──────────────────────────────┘    │
└─────────────────────────┼───────────────────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────────────┐
│                  PostgreSQL Database                       │
│  - Epics    - Tasks    - Agents    - Mail                 │
└────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│                   External Systems                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │   Git    │  │   Tmux   │  │ Inngest  │              │
│  │ Worktrees│  │ Sessions │  │ (Async)  │              │
│  └──────────┘  └──────────┘  └──────────┘              │
└──────────────────────────────────────────────────────────┘
```

## Data Model

### Epic
High-level feature description that spawns multiple tasks.

```prisma
model Epic {
  id          String   @id @default(cuid())
  title       String
  description String   @db.Text
  design      String   @db.Text  // Markdown design doc
  worktreeName String  @unique   // Git worktree for this epic
  supervisorId String? @unique
  supervisor  Agent?   @relation("EpicSupervisor")
  tasks       Task[]
  state       EpicState @default(IN_PROGRESS)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

enum EpicState {
  IN_PROGRESS
  AWAITING_HUMAN_REVIEW  // Supervisor submitted PR to main, waiting for human
  COMPLETED
  FAILED
}
```

### Task
Individual work item that can be acted upon by a worker agent.

```prisma
model Task {
  id           String    @id @default(cuid())
  epicId       String
  epic         Epic      @relation(fields: [epicId], references: [id])
  title        String
  description  String    @db.Text
  worktreeName String    @unique
  agentId      String?   @unique
  agent        Agent?    @relation("TaskAgent")
  state        TaskState @default(PENDING)
  prUrl        String?   // PR URL when task completes
  attempts     Int       @default(0)  // Number of worker recreation attempts
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
}

enum TaskState {
  PENDING
  IN_PROGRESS
  PENDING_REVIEW      // PR submitted, waiting for supervisor review
  NEEDS_REBASE        // Supervisor requested rebase after another PR merged
  APPROVED            // Supervisor approved, about to be merged
  COMPLETED           // Merged into epic branch
  FAILED
}
```

### Agent
Active LLM agent with dedicated tmux session.

```prisma
model Agent {
  id            String        @id @default(cuid())
  type          AgentType
  tmuxSession   String        @unique
  taskId        String?       @unique
  task          Task?         @relation("TaskAgent", fields: [taskId], references: [id])
  epicId        String?       @unique
  epic          Epic?         @relation("EpicSupervisor", fields: [epicId], references: [id])
  state         AgentState    @default(IN_PROGRESS)
  lastHeartbeat DateTime      @default(now())  // Last message received from agent
  mailSent      Mail[]        @relation("SentMail")
  mailReceived  Mail[]        @relation("ReceivedMail")
  decisionLogs  DecisionLog[]
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt
}

enum AgentType {
  ORCHESTRATOR
  SUPERVISOR
  WORKER
}

enum AgentState {
  IN_PROGRESS
  DONE
  FAILED
}
```

### Mail
Internal messaging system for agent-to-agent and agent-to-human communication.

```prisma
model Mail {
  id          String   @id @default(cuid())
  fromAgentId String?
  fromAgent   Agent?   @relation("SentMail", fields: [fromAgentId], references: [id])
  toAgentId   String?
  toAgent     Agent?   @relation("ReceivedMail", fields: [toAgentId], references: [id])
  toHuman     Boolean  @default(false)  // If true, shows in human inbox
  subject     String
  body        String   @db.Text
  read        Boolean  @default(false)
  createdAt   DateTime @default(now())
}
```

### DecisionLog
Audit trail for all agent actions and tool calls, used for debugging.

```prisma
model DecisionLog {
  id        String   @id @default(cuid())
  agentId   String
  agent     Agent    @relation(fields: [agentId], references: [id])
  title     String   // Tool name or action type
  body      String   @db.Text  // Tool parameters, results, or action details
  createdAt DateTime @default(now())

  @@index([agentId, createdAt])
}
```

## Backend Architecture

### Folder Structure

```
src/backend/
├── resource_accessors/
│   ├── epic.accessor.ts
│   ├── task.accessor.ts
│   ├── agent.accessor.ts
│   ├── mail.accessor.ts
│   └── decision-log.accessor.ts
├── clients/
│   ├── git.client.ts         # Git CLI wrapper (worktree management)
│   ├── github.client.ts      # GitHub CLI wrapper (PR creation via gh)
│   ├── tmux.client.ts        # Tmux session management
│   ├── claude.client.ts      # Claude SDK integration
│   └── inngest.client.ts     # Inngest event client
├── routers/
│   ├── mcp/
│   │   ├── mail.mcp.ts       # Agent mail operations
│   │   └── agent.mcp.ts      # Agent introspection
│   └── api/
│       ├── epic.router.ts    # Epic CRUD (tRPC)
│       ├── task.router.ts    # Task viewing (tRPC)
│       ├── agent.router.ts   # Agent monitoring (tRPC)
│       └── mail.router.ts    # Human mail inbox (tRPC)
├── agents/
│   ├── orchestrator/
│   │   ├── orchestrator.agent.ts
│   │   └── orchestrator.prompts.ts
│   ├── supervisor/
│   │   ├── supervisor.agent.ts
│   │   └── supervisor.prompts.ts
│   └── worker/
│       ├── worker.agent.ts
│       └── worker.prompts.ts
├── inngest/
│   ├── functions/
│   │   ├── epic-created.ts          # epic.created handler
│   │   ├── task-created.ts          # task.created handler
│   │   ├── agent-completed.ts       # agent.completed handler
│   │   ├── mail-sent.ts             # mail.sent handler
│   │   ├── supervisor-check.ts      # Periodic supervisor checks
│   │   └── orchestrator-check.ts    # Periodic orchestrator checks
│   └── events.ts                     # Event schemas
├── prisma/
│   └── schema.prisma
└── index.ts                          # Main server entry
```

## Frontend Architecture

### Folder Structure

```
src/frontend/
├── app/
│   ├── layout.tsx
│   ├── page.tsx                    # Dashboard/Epic list
│   ├── epics/
│   │   ├── page.tsx                # Epic list
│   │   ├── [id]/
│   │   │   └── page.tsx            # Epic detail + tasks
│   │   └── new/
│   │       └── page.tsx            # Create epic
│   ├── tasks/
│   │   ├── page.tsx                # Task list
│   │   └── [id]/
│   │       └── page.tsx            # Task detail
│   ├── agents/
│   │   ├── page.tsx                # Agent monitor dashboard
│   │   └── [id]/
│   │       └── page.tsx            # Agent detail + tmux view
│   └── mail/
│       ├── page.tsx                # Human inbox
│       └── [id]/
│           └── page.tsx            # Mail thread view
├── components/
│   ├── epic-card.tsx
│   ├── task-list.tsx
│   ├── agent-status.tsx
│   ├── mail-inbox.tsx
│   ├── tmux-terminal.tsx           # Integration with tmux-js
│   └── ui/                         # Shared UI components
└── lib/
    └── trpc.ts                     # tRPC client setup
```

## Agent Workflows

### Orchestrator Agent
- **Creation**: Single instance, created on system startup
- **Responsibilities**:
  - Monitor for new epics via `epic.created` events
  - Create supervisor agents for each epic
  - Create epic worktrees from main branch
  - Monitor supervisor health (check heartbeat every 2 minutes)
  - Kill and recreate crashed supervisors (cascading worker recreation)
  - Notify humans when epics complete
  - Log all actions to DecisionLog
- **Inngest Functions**:
  - `orchestrator.check` (cron: every 2 minutes) - Monitor supervisor health, review epic progress

### Supervisor Agent
- **Creation**: Created per epic by orchestrator
- **Responsibilities**:
  - Break down epic into tasks (can create new tasks dynamically)
  - Assign tasks to worker agents
  - Maintain PR review queue (ordered by submission time)
  - Review PRs from workers sequentially (one at a time)
  - Merge approved PRs into epic worktree
  - Request rebases from other workers after each merge
  - Monitor worker health (check heartbeat every 2 minutes)
  - Kill and recreate crashed workers (increment task attempts, fail after 5 attempts)
  - Send health check mail if no message received in 2 minutes
  - Review worker code files directly
  - Create PR from epic worktree to main when all tasks complete
  - Notify orchestrator when epic is done
  - Log all actions to DecisionLog
- **Inngest Functions**:
  - `supervisor.check` (cron: every 2 minutes per supervisor) - Monitor worker health, process review queue

### Worker Agent
- **Creation**: Created per task by supervisor
- **Responsibilities**:
  - Execute assigned task in dedicated worktree (branched from epic worktree)
  - Write code using Claude SDK
  - Run tests and validation
  - Create PR to epic worktree when complete (via GitHub CLI)
  - Send completion mail to supervisor with PR link
  - Respond to rebase requests from supervisor
  - Handle rebase workflow: fetch, rebase, force-push, notify
  - Respond to health check requests (any mail updates heartbeat)
  - Respond to change requests with code updates
  - Log all actions to DecisionLog
- **Inngest Functions**:
  - `worker.start` (triggered by `task.created`) - Start working on task

## Key Workflows

### Epic Creation Flow
1. Human creates epic via UI
2. `epic.created` event fired
3. Orchestrator receives event via `orchestrator-check` or `epic-created` function
4. Orchestrator creates supervisor agent
5. Git client creates epic worktree from main
6. Supervisor starts breaking down epic into tasks

### Task Assignment Flow
1. Supervisor creates task via resource accessor
2. `task.created` event fired
3. `task-created` Inngest function creates worker agent
4. Git client creates task worktree from epic worktree
5. Tmux client creates session for worker
6. Worker agent starts executing task

### Task Completion & PR Review Flow
1. Worker finishes code changes
2. Worker creates PR to epic worktree via git client
3. Worker updates task state to `PENDING_REVIEW`
4. Worker sends mail to supervisor: "Task complete, PR: {url}"
5. Supervisor adds PR to review queue (ordered by submission time)

**Supervisor Review Process (Automated Review & Merge):**
6. Supervisor reviews first PR in queue (code review, tests, design alignment)
7. **If approved**:
   - Update task state to `APPROVED`
   - **Automatically merge PR into epic branch** (no human intervention)
   - Update task state to `COMPLETED`
   - Find all other tasks in `PENDING_REVIEW` state
   - Send mail to each worker: "Please rebase against epic branch and resubmit"
   - Update those tasks to `NEEDS_REBASE`
   - Continue to next PR in queue
8. **If needs changes**:
   - Send detailed feedback mail to worker
   - Worker makes changes and force-pushes
   - Task remains in `PENDING_REVIEW`, back to step 6

**Worker Rebase Process** (when receiving rebase request):
9. Worker updates task state to `NEEDS_REBASE`
10. Worker fetches latest epic branch
11. Worker rebases task branch onto epic branch
12. Worker force-pushes rebased branch
13. Worker updates PR description with rebase info
14. Worker updates task state to `PENDING_REVIEW`
15. Worker sends mail: "Rebased and ready for review"
16. Supervisor adds to end of review queue

### Epic Completion Flow
1. Supervisor detects all tasks complete
2. Supervisor creates PR from epic worktree to main (via GitHub CLI)
3. Supervisor sends mail to human mailbox: "Epic complete, PR: {url}"
4. Supervisor updates epic state to `AWAITING_HUMAN_REVIEW`
5. Human reviews PR via GitHub UI
6. Human merges PR to main (or requests changes via mail through UI)
7. Human marks epic as COMPLETED in UI
8. `epic.completed` event logged

## Agent Health Monitoring & Crash Recovery

### Design Philosophy
Agents are ephemeral and can crash due to LLM errors, rate limits, network issues, or bugs. We use heartbeat-based monitoring with automatic recovery to ensure forward progress.

### Heartbeat & Liveness Detection

**Heartbeat Mechanism:**
- Every time an agent sends mail, its `lastHeartbeat` timestamp is updated
- No separate heartbeat protocol needed - all mail activity counts as a heartbeat

**Liveness Check (every 2 minutes):**
- Supervisor checks all worker `lastHeartbeat` timestamps
- Orchestrator checks supervisor `lastHeartbeat` timestamp
- If `now() - lastHeartbeat > 2 minutes` → agent considered dead

**Health Check Mail (reactive, not proactive):**
- Only send health check mail if no message received in 2 minutes
- Subject: "Health Check"
- Body: "Please confirm you are active and provide status update"
- If agent responds, heartbeat updated and agent considered healthy

### Worker Crash Recovery

**Detection:**
1. Supervisor's `supervisor.check` cron (every 2 minutes) runs
2. Supervisor queries all workers for this epic
3. For each worker: check if `now() - lastHeartbeat > 2 minutes`
4. If dead, initiate recovery

**Recovery Process:**
1. Increment task `attempts` counter
2. **If attempts >= 5**:
   - Update task state to `FAILED`
   - Send mail to human: "Task failed after 5 attempts: {task title}"
   - Log decision: "Task marked as failed due to repeated crashes"
   - Stop recovery (human intervention required)
3. **If attempts < 5**:
   - Soft delete agent record (set state to `FAILED`)
   - Kill tmux session via tmux client
   - Create new agent record with fresh tmux session
   - Reset task state to `IN_PROGRESS`
   - New worker starts fresh with original task description
   - Git worktree preserved (contains partial work from previous attempt)
   - Log decision: "Worker crashed and recreated (attempt N/5)"

### Supervisor Crash Recovery (Cascading Failure)

**Detection:**
1. Orchestrator's `orchestrator.check` cron (every 2 minutes) runs
2. Orchestrator queries all supervisors
3. For each supervisor: check if `now() - lastHeartbeat > 2 minutes`
4. If dead, initiate cascading recovery

**Recovery Process:**
1. **Kill Phase**:
   - Query all workers associated with this epic
   - For each worker:
     - Soft delete agent record (set state to `FAILED`)
     - Kill tmux session via tmux client
   - Soft delete supervisor agent record (set state to `FAILED`)
   - Kill supervisor tmux session

2. **Recreate Phase**:
   - Create new supervisor agent for same epic
   - Create new tmux session for supervisor
   - Supervisor inherits epic and all existing tasks

3. **Task State Reset**:
   - `COMPLETED` tasks → stay `COMPLETED` (preserve finished work)
   - `PENDING_REVIEW` tasks → stay `PENDING_REVIEW` (new supervisor will re-review PRs)
   - `IN_PROGRESS` tasks → reset to `PENDING`
   - `NEEDS_REBASE` tasks → reset to `PENDING`
   - `APPROVED` tasks → reset to `PENDING` (not yet merged, must re-review)
   - `FAILED` tasks → stay `FAILED`
   - Reset `attempts` counter to 0 for all reset tasks

4. **Worker Recreation**:
   - New supervisor creates workers for all `PENDING` tasks
   - Workers start fresh with original task descriptions
   - Git worktrees preserved (contain partial work)

5. **Notification**:
   - Send mail to human: "Supervisor crashed and recovered for epic: {epic title}"
   - Log decision: "Supervisor crashed, recreated with cascading worker reset"

### Concurrent Epic Handling

**Multiple Epics Run Simultaneously:**
- Orchestrator manages multiple supervisors concurrently
- Each supervisor manages its own set of workers independently
- No global coordination needed between epics
- Resource limits (API rate limits, tmux sessions) managed at system level

**Implications:**
- Fast epic creation (no queuing)
- Better resource utilization
- Potential for rate limit exhaustion (mitigate with throttling)
- More tmux sessions to monitor

## Decision Logging

### Purpose
Comprehensive audit trail of all agent actions for debugging and analysis.

### What Gets Logged
Every tool call and significant action:
- **Mail operations**: Send mail, read mail
- **Git operations**: Clone, checkout, commit, push, rebase, merge
- **PR operations**: Create PR, update PR, merge PR (via GitHub CLI)
- **Task state changes**: Update task state, create task
- **Agent lifecycle**: Agent created, agent killed, health check sent
- **File operations**: Read file, write file, execute command

### Log Format
```typescript
{
  agentId: string,
  title: string,    // e.g., "send_mail", "git_rebase", "create_pr"
  body: string,     // JSON: { params: {...}, result: "success|failure", details: "..." }
  createdAt: Date
}
```

### Example Log Entries
```json
// Mail sent
{
  "title": "send_mail",
  "body": "{\"to\":\"worker-123\",\"subject\":\"Rebase Required\",\"result\":\"success\"}"
}

// Git rebase
{
  "title": "git_rebase",
  "body": "{\"branch\":\"epic/abc\",\"result\":\"success\",\"conflicts\":0}"
}

// PR created
{
  "title": "create_pr",
  "body": "{\"from\":\"task/123\",\"to\":\"epic/abc\",\"url\":\"https://github.com/.../pull/45\",\"result\":\"success\"}"
}

// Worker crash detected
{
  "title": "worker_crash_detected",
  "body": "{\"workerId\":\"worker-123\",\"taskId\":\"task-456\",\"attempts\":2,\"action\":\"recreate\"}"
}
```

### Retention
- Logs kept forever (no automatic cleanup)
- Future: Add manual cleanup tool or archival strategy

## Technology Stack

### Core
- **Next.js 14+**: App Router, React Server Components
- **TypeScript**: Full type safety
- **PostgreSQL**: Primary database
- **Prisma**: ORM and migrations

### Backend
- **tRPC**: Type-safe API layer
- **Inngest**: Async job processing and cron
- **MCP (Model Context Protocol)**: Agent-to-agent communication
- **Claude SDK**: LLM integration
- **node-pty**: Terminal emulation (from tmux-web)

### Frontend
- **tmux-js** (from ~/Programming/tmux-web): Terminal viewing
  - Uses xterm.js for terminal rendering
  - WebSocket connection to backend for real-time updates
- **TailwindCSS**: Styling
- **React Query**: Data fetching (via tRPC)

### External Tools
- **Git**: Worktree and branch management
- **GitHub CLI (gh)**: PR creation, updates, and management
- **Tmux**: Session isolation for agents

## Configuration

### Environment Variables

```bash
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/factoryfactory"

# Claude API
CLAUDE_API_KEY="sk-..."
CLAUDE_MODEL="claude-sonnet-4-5-20250929"  # Configurable per agent type

# Inngest
INNGEST_EVENT_KEY="..."
INNGEST_SIGNING_KEY="..."

# Git
GIT_BASE_REPO_PATH="/path/to/repo"
GIT_WORKTREE_BASE="/path/to/worktrees"

# Tmux
TMUX_SOCKET_PATH="/tmp/tmux-factoryfactory"

# Backend
PORT=3001
NODE_ENV=development

# Frontend
NEXT_PUBLIC_API_URL="http://localhost:3001"
```

## Inngest Event Schemas

```typescript
// epic.created
{
  name: "epic.created",
  data: {
    epicId: string,
    title: string,
    description: string,
    design: string
  }
}

// task.created
{
  name: "task.created",
  data: {
    taskId: string,
    epicId: string,
    title: string,
    description: string
  }
}

// agent.completed
{
  name: "agent.completed",
  data: {
    agentId: string,
    agentType: "ORCHESTRATOR" | "SUPERVISOR" | "WORKER",
    taskId?: string,
    epicId?: string,
    result: "success" | "failure",
    message?: string
  }
}

// mail.sent
{
  name: "mail.sent",
  data: {
    mailId: string,
    fromAgentId?: string,
    toAgentId?: string,
    toHuman: boolean,
    subject: string
  }
}

// supervisor.check (cron)
{
  name: "supervisor.check",
  data: {
    supervisorId: string,
    epicId: string
  }
}

// orchestrator.check (cron)
{
  name: "orchestrator.check",
  data: {
    orchestratorId: string
  }
}
```

## Git Worktree Strategy

### Structure
```
/git-base-repo/               # Main repository
/worktrees/
  ├── epic-{epicId}/          # Epic worktrees (branch from main)
  └── task-{taskId}/          # Task worktrees (branch from epic worktree)
```

### Workflow
1. **Epic creation**: Create worktree from `main` branch
2. **Task creation**: Create worktree from epic's branch
3. **Task completion**: PR from task worktree → epic worktree
4. **Epic completion**: PR from epic worktree → main

### Naming Convention
- Epic worktree: `epic/{epicId}/{sanitized-title}`
- Task worktree: `task/{taskId}/{sanitized-title}`

## MCP Interface

Agents access the system via MCP tools:

```typescript
// Read mail
mcp://mail/inbox
mcp://mail/read?id={mailId}

// Send mail
mcp://mail/send
{
  toAgentId?: string,
  toHuman?: boolean,
  subject: string,
  body: string
}

// Agent introspection
mcp://agent/status
mcp://agent/task-details
mcp://agent/epic-details
```

## Security Considerations

1. **Sandbox Execution**: All agent code runs in isolated worktrees
2. **Rate Limiting**: Claude API calls throttled per agent
3. **Git Safety**: No force pushes, all changes via PRs
4. **Tmux Isolation**: Each agent has dedicated session
5. **Mail Validation**: All mail content sanitized
6. **Human Approval**: Final epic PRs require human review

## Future Enhancements

- Agent performance metrics
- Cost tracking per agent/epic
- Multi-repository support
- Agent collaboration (pair programming)
- Web-based code review UI
- Agent memory/context persistence
- Integration with external issue trackers
- Custom agent personalities/specializations

## Merge Conflict Strategy

### Design Philosophy
We prioritize **correctness over speed** with a serialized PR review process. While this may be wasteful for independent changes, it guarantees clean merges and avoids complex conflict resolution by LLM agents.

### Review & Merge Authority
- **Supervisor → Worker PRs**: Supervisor has full authority to review and **automatically merge** worker PRs into epic branch
- **Human → Supervisor PRs**: Human has final authority to review and merge epic PRs into main branch
- This creates a two-tier approval system: automated for internal epic work, manual for production-bound changes

### Sequential Review & Rebase Protocol

**Core Principle**: Only one PR is reviewed and merged at a time. After each merge, all other pending PRs must rebase.

**Review Queue Management:**
- Supervisor maintains an ordered queue of PRs (by submission timestamp)
- Only the first PR in the queue is actively reviewed
- Workers can submit PRs at any time (added to end of queue)

**Merge-Triggered Rebase Cascade:**
1. Supervisor approves and merges PR #1
2. Supervisor identifies all tasks in `PENDING_REVIEW` state
3. Supervisor sends mail to each affected worker:
   ```
   Subject: Rebase Required
   Body: Task XYZ was merged into epic branch.
         Please rebase your branch and resubmit for review.
   ```
4. Workers update to `NEEDS_REBASE`, perform rebase, return to `PENDING_REVIEW`
5. Supervisor reviews next PR in queue (either existing or newly rebased)

**Benefits:**
- **Guaranteed Clean Merges**: Every PR merges without conflicts
- **Simple Agent Logic**: Workers only need basic git rebase skills
- **Deterministic Ordering**: Clear queue prevents race conditions
- **No Conflict Resolution**: Agents never need to resolve merge conflicts manually

**Trade-offs:**
- **Serialized Reviews**: Only one PR processed at a time (bottleneck)
- **Rebase Churn**: Workers may rebase multiple times if deep in queue
- **Wasted Work**: Independent file changes still trigger rebases

**Future Optimizations:**
- Smart rebase detection (only rebase if file paths overlap)
- Parallel review tracks for disjoint file sets
- Auto-merge for trivial rebases (no code changes post-rebase)

### Task State Machine with Rebase

```
PENDING → IN_PROGRESS → PENDING_REVIEW → APPROVED → COMPLETED
                              ↓                ↑
                         NEEDS_REBASE ────────┘
                              ↓
                           FAILED (if rebase fails)
```

**State Transitions:**
- `IN_PROGRESS → PENDING_REVIEW`: Worker submits PR
- `PENDING_REVIEW → NEEDS_REBASE`: Supervisor requests rebase (another PR merged)
- `NEEDS_REBASE → PENDING_REVIEW`: Worker completes rebase
- `PENDING_REVIEW → APPROVED`: Supervisor approves PR (automated decision)
- `APPROVED → COMPLETED`: Supervisor merges PR (automated action)
- `PENDING_REVIEW → IN_PROGRESS`: Supervisor requests changes
- `NEEDS_REBASE → FAILED`: Rebase fails (conflict too complex)

### Epic State Machine

```
IN_PROGRESS → AWAITING_HUMAN_REVIEW → COMPLETED
      ↓                                     ↑
   FAILED ──────────────────────────────────┘
```

**State Transitions:**
- `IN_PROGRESS → AWAITING_HUMAN_REVIEW`: Supervisor submits PR to main
- `AWAITING_HUMAN_REVIEW → COMPLETED`: Human merges PR
- `AWAITING_HUMAN_REVIEW → IN_PROGRESS`: Human requests changes via mail
- `IN_PROGRESS → FAILED`: Supervisor or human marks epic as failed

## Open Questions

1. ~~How should agents handle merge conflicts?~~ **RESOLVED**: Sequential review with forced rebases
2. ~~Should supervisors auto-merge worker PRs or always review first?~~ **RESOLVED**: Supervisor auto-merges after review; human manually merges epic PRs
3. ~~What happens if an agent crashes mid-task?~~ **RESOLVED**: Heartbeat monitoring with automatic recreation, fail after 5 attempts
4. ~~Can multiple epics run simultaneously?~~ **RESOLVED**: Yes, concurrent epic execution
5. ~~How to create PRs?~~ **RESOLVED**: GitHub CLI (`gh pr create`)
6. ~~How does human respond to supervisor?~~ **RESOLVED**: Via UI mail interface
7. Should we support agent rollback/undo?
8. How do we handle very long-running tasks (>1 hour)?
9. What happens if a rebase fails? Should we notify the human or supervisor?
10. Should we have rate limiting on Claude API calls to prevent exhaustion?
