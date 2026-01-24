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

# Override model for specific agent type
ORCHESTRATOR_MODEL="opus"
SUPERVISOR_MODEL="sonnet"
WORKER_MODEL="sonnet"

# Override permission mode
ORCHESTRATOR_PERMISSIONS="strict"
SUPERVISOR_PERMISSIONS="relaxed"
WORKER_PERMISSIONS="yolo"

# Notification settings
NOTIFICATION_SOUND_ENABLED=true
NOTIFICATION_PUSH_ENABLED=true
NOTIFICATION_SOUND_FILE="/path/to/sound.wav"
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

## Agent System

### Agent Execution Profiles

#### Design Philosophy
Different agent types have different responsibilities and require different levels of oversight. We use execution profiles to configure Claude model selection and permission modes per agent type, optimizing for both cost and safety.

#### Profile Configuration

```typescript
interface AgentExecutionProfile {
  model: 'sonnet' | 'opus' | 'haiku';
  permissions: 'strict' | 'relaxed' | 'yolo';
  planMode?: boolean;
  approvals?: boolean;
}

const AGENT_PROFILES: Record<AgentType, AgentExecutionProfile> = {
  ORCHESTRATOR: {
    model: 'sonnet',
    permissions: 'strict',
    // Orchestrator manages high-level epic coordination
    // Strict permissions ensure deliberate decision-making
  },
  SUPERVISOR: {
    model: 'sonnet',
    permissions: 'relaxed',
    // Supervisor handles PR reviews and worker coordination
    // Relaxed permissions allow autonomy with logging
  },
  WORKER: {
    model: 'sonnet',
    permissions: 'yolo',
    // Worker executes code tasks rapidly
    // YOLO mode minimizes approval overhead for fast iteration
  },
};
```

#### Permission Modes

**Strict Mode:**
- Logs all tool calls
- May request human approval for sensitive operations (future)
- Appropriate for high-level coordination agents

**Relaxed Mode:**
- Logs all tool calls
- Autonomous execution with audit trail
- Appropriate for supervised agents with review responsibilities

**YOLO Mode:**
- Minimal overhead, maximum speed
- All tools auto-approved (except explicitly disallowed)
- Appropriate for sandboxed worker agents

#### Model Selection Rationale

**Sonnet (Default):**
- Best balance of performance and cost
- Used for all agents initially
- Suitable for complex reasoning and code generation

**Opus (Future):**
- Premium model for critical decisions
- Could be used for orchestrator or complex supervisor reviews
- Configurable via environment variable override

**Haiku (Future):**
- Fast, low-cost model for simple tasks
- Could be used for routine worker tasks
- Experimental use case for cost optimization

### Disallowed Tools

Certain Claude tools are explicitly disallowed for all agents to prevent blocking behavior and infinite loops:

**`AskUserQuestion`:**
- This tool blocks execution waiting for synchronous user input
- Incompatible with autonomous multi-agent architecture
- Would create deadlocks where agents wait indefinitely
- All human communication must use the async mail system instead

**Configuration:**
```typescript
// In Claude SDK initialization
const claudeClient = new ClaudeSDK({
  apiKey: process.env.CLAUDE_API_KEY,
  disallowedTools: ['AskUserQuestion'],
  // ... other config
});
```

**Rationale:**
In a multi-agent system with concurrent orchestrator, supervisor, and worker agents, any blocking operation breaks the async coordination model. Agents must communicate through non-blocking channels (mail system) to maintain forward progress.

### Tool Access Control by Agent Type

Each agent type has restricted access to MCP tools based on their role. This prevents privilege escalation and clarifies agent boundaries.

```typescript
const AGENT_TOOL_PERMISSIONS: Record<AgentType, {
  allowedTools: string[];
  disallowedTools: string[];
}> = {
  ORCHESTRATOR: {
    allowedTools: [
      'mcp__mail__*',              // Can send/receive mail
      'mcp__agent__get_status',    // Can check own status
      'mcp__orchestrator__*',      // Orchestrator-specific operations
      'mcp__system__log_decision', // Can log decisions
    ],
    disallowedTools: [
      'mcp__task__*',      // Cannot manipulate tasks directly
      'mcp__epic__*',      // Cannot manipulate epic internals
      'mcp__git__*',       // Doesn't touch git directly
      'mcp__agent__get_task',  // No task context
      'mcp__agent__get_epic',  // No epic context
    ],
  },
  SUPERVISOR: {
    allowedTools: [
      'mcp__mail__*',              // Can send/receive mail
      'mcp__agent__*',             // Can check status and get epic context
      'mcp__epic__*',              // Full epic management
      'mcp__git__get_diff',        // Can read diffs for code review
      'mcp__system__log_decision', // Can log decisions
    ],
    disallowedTools: [
      'mcp__task__*',              // Cannot manipulate worker tasks directly
      'mcp__git__rebase',          // Workers handle their own rebases
      'mcp__orchestrator__*',      // No orchestrator operations
    ],
  },
  WORKER: {
    allowedTools: [
      'mcp__mail__*',              // Can send/receive mail
      'mcp__agent__*',             // Can check status, get task/epic context
      'mcp__task__*',              // Full task management
      'mcp__git__*',               // Full git operations
      'mcp__system__log_decision', // Can log decisions
      'Read', 'Write', 'Edit',     // File operations (Claude built-in tools)
      'Bash',                      // Command execution
      'Grep', 'Glob',              // Code search
    ],
    disallowedTools: [
      'mcp__orchestrator__*',      // No orchestrator operations
      'mcp__epic__create_task',    // Cannot create tasks for other workers
      'mcp__epic__approve_pr',     // Cannot approve own PRs
      'mcp__epic__create_epic_pr', // Cannot create epic PRs
    ],
  },
};
```

**Enforcement:**
Tool access is enforced at the MCP server level. When an agent calls a tool, the MCP server checks permissions:

```typescript
async function executeMcpTool(
  agentId: string,
  toolName: string,
  toolInput: any
) {
  const agent = await agentAccessor.findById(agentId);

  // Check permissions
  const permissions = AGENT_TOOL_PERMISSIONS[agent.type];

  // Check disallowed list first
  if (permissions.disallowedTools.some(pattern =>
    matchPattern(toolName, pattern)
  )) {
    return {
      success: false,
      error: `Tool ${toolName} is not allowed for ${agent.type} agents`,
    };
  }

  // Check allowed list
  if (!permissions.allowedTools.some(pattern =>
    matchPattern(toolName, pattern)
  )) {
    return {
      success: false,
      error: `Tool ${toolName} is not in allowed list for ${agent.type} agents`,
    };
  }

  // Execute tool
  // ... (logging and execution logic)
}

function matchPattern(toolName: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return toolName === pattern;
}
```

**Benefits:**
- **Security**: Prevents agents from escalating privileges
- **Clarity**: Agents understand their operational boundaries
- **Debugging**: Tool access errors indicate design problems
- **Principle of Least Privilege**: Each agent has only the tools it needs

## MCP Tool Interface

### Design Philosophy

MCP tools are **action-oriented operations** that encapsulate complete business logic. Each tool hides internal complexity (database operations, git commands, mail notifications, decision logging) and provides a clean interface for agents.

Tools follow these principles:
1. **Atomic operations**: Either everything succeeds or nothing changes
2. **Hide complexity**: Agents don't need to know DB schema or git internals
3. **Automatic audit trail**: All tool calls logged to DecisionLog
4. **Rich responses**: Structured, typed return values
5. **Clear descriptions**: Self-documenting for Claude

### Tool Naming Convention

Tools use double-underscore namespacing: `mcp__{domain}__{action}`

Examples:
- `mcp__mail__send` - Send mail (mail domain, send action)
- `mcp__task__create_pr` - Create PR (task domain, create_pr action)
- `mcp__epic__approve_pr` - Approve PR (epic domain, approve_pr action)

### Mail Tools (All Agents)

**`mcp__mail__list_inbox`**
```typescript
// List unread mail for current agent
Response: {
  mail: Array<{
    id: string,
    fromAgentId?: string,
    subject: string,
    body: string,
    createdAt: string,
  }>,
  count: number,
}
```

**`mcp__mail__read`**
```typescript
// Read specific mail and mark as read
Input: { mailId: string }
Response: {
  id: string,
  fromAgentId?: string,
  subject: string,
  body: string,
  createdAt: string,
}
```

**`mcp__mail__send`**
```typescript
// Send mail to agent or human
Input: {
  toAgentId?: string,
  toHuman?: boolean,
  subject: string,
  body: string,
}
Response: {
  mailId: string,
  sentAt: string,
}
// Side effects: Updates sender heartbeat, logs decision
```

**`mcp__mail__reply`**
```typescript
// Reply to existing mail thread
Input: {
  inReplyToMailId: string,
  body: string,
}
Response: { mailId: string }
```

### Agent Introspection Tools (All Agents)

**`mcp__agent__get_status`**
```typescript
// Get current agent's status
Response: {
  agentId: string,
  type: 'ORCHESTRATOR' | 'SUPERVISOR' | 'WORKER',
  state: 'IN_PROGRESS' | 'DONE' | 'FAILED',
  lastHeartbeat: string,
  tmuxSession: string,
}
```

**`mcp__agent__get_task`**
```typescript
// Get current task details (Workers only)
Response: {
  taskId: string,
  title: string,
  description: string,
  state: TaskState,
  epicId: string,
  worktreeName: string,
  prUrl?: string,
  attempts: number,
}
```

**`mcp__agent__get_epic`**
```typescript
// Get current epic details (Supervisors and Workers)
Response: {
  epicId: string,
  title: string,
  description: string,
  design: string,
  state: EpicState,
  worktreeName: string,
  supervisorId: string,
}
```

### Worker Tools

**`mcp__task__update_state`**
```typescript
// Update task state with automatic logging
Input: {
  state: 'IN_PROGRESS' | 'PENDING_REVIEW' | 'NEEDS_REBASE',
}
Response: {
  taskId: string,
  newState: TaskState,
  updatedAt: string,
}
// Side effects: Updates task in DB, logs decision
```

**`mcp__task__create_pr`**
```typescript
// Create PR from task branch to epic branch
Input: {
  title: string,
  description: string,
}
Response: {
  prUrl: string,
  taskId: string,
}
// Side effects:
// - Creates PR via GitHub CLI
// - Updates task state to PENDING_REVIEW
// - Updates task.prUrl
// - Sends mail to supervisor
// - Logs decision
```

**`mcp__task__get_pr_status`**
```typescript
// Check PR review status
Response: {
  prUrl: string,
  state: 'open' | 'merged' | 'closed',
  reviewStatus: 'pending' | 'approved' | 'changes_requested',
}
```

**`mcp__git__rebase`**
```typescript
// Rebase current task branch onto epic branch
Response: {
  success: boolean,
  conflicts: number,
  conflictFiles?: string[],
}
// Side effects:
// - Executes git rebase
// - Updates task state to PENDING_REVIEW on success
// - Updates task state to FAILED on conflict
// - Logs decision
```

**`mcp__git__get_diff`**
```typescript
// Get diff between task branch and epic branch
Response: {
  diff: string,
  filesChanged: number,
  insertions: number,
  deletions: number,
}
```

### Supervisor Tools

**`mcp__epic__create_task`**
```typescript
// Create new task for current epic
Input: {
  title: string,
  description: string,
}
Response: {
  taskId: string,
  worktreeName: string,
}
// Side effects:
// - Creates task in DB
// - Fires task.created event (triggers worker creation)
// - Logs decision
```

**`mcp__epic__list_tasks`**
```typescript
// List all tasks for current epic
Input: {
  state?: TaskState,  // Optional filter
}
Response: {
  tasks: Array<{
    taskId: string,
    title: string,
    state: TaskState,
    agentId?: string,
    prUrl?: string,
    attempts: number,
  }>,
  count: number,
}
```

**`mcp__epic__get_review_queue`**
```typescript
// Get ordered PR review queue
Response: {
  queue: Array<{
    taskId: string,
    title: string,
    prUrl: string,
    submittedAt: string,
  }>,
  currentReview?: {
    taskId: string,
    prUrl: string,
  },
}
```

**`mcp__epic__approve_pr`**
```typescript
// Approve and merge PR into epic branch
Input: {
  taskId: string,
  prUrl: string,
}
Response: {
  merged: boolean,
  mergeCommitSha: string,
}
// Side effects:
// - Merges PR via GitHub CLI
// - Updates task state to COMPLETED
// - Finds all tasks in PENDING_REVIEW
// - Sends rebase request mail to each worker
// - Updates those tasks to NEEDS_REBASE
// - Logs decision
```

**`mcp__epic__request_changes`**
```typescript
// Request changes on PR
Input: {
  taskId: string,
  feedback: string,
}
Response: {
  mailSent: boolean,
}
// Side effects:
// - Sends detailed feedback mail to worker
// - Logs decision
```

**`mcp__epic__create_epic_pr`**
```typescript
// Create PR from epic branch to main
Input: {
  title: string,
  description: string,
}
Response: {
  prUrl: string,
}
// Side effects:
// - Creates PR via GitHub CLI
// - Updates epic state to AWAITING_HUMAN_REVIEW
// - Sends mail to human inbox
// - Logs decision
```

**`mcp__epic__read_file`**
```typescript
// Read file from worker's worktree for code review
Input: {
  taskId: string,
  filePath: string,
}
Response: {
  content: string,
  path: string,
}
```

### Orchestrator Tools

**`mcp__orchestrator__list_supervisors`**
```typescript
// List all supervisors
Response: {
  supervisors: Array<{
    agentId: string,
    epicId: string,
    epicTitle: string,
    state: AgentState,
    lastHeartbeat: string,
  }>,
  count: number,
}
```

**`mcp__orchestrator__check_supervisor_health`**
```typescript
// Check if supervisor is healthy (called during periodic checks)
Input: {
  supervisorId: string,
}
Response: {
  healthy: boolean,
  lastHeartbeat: string,
  minutesSinceHeartbeat: number,
}
```

**`mcp__orchestrator__create_supervisor`**
```typescript
// Create supervisor for epic (typically called automatically)
Input: {
  epicId: string,
}
Response: {
  agentId: string,
  tmuxSession: string,
}
// Side effects:
// - Creates agent record
// - Creates tmux session
// - Creates epic worktree
// - Logs decision
```

### System Tools (All Agents)

**`mcp__system__log_decision`**
```typescript
// Explicitly log important decisions
Input: {
  title: string,
  body: string,
}
Response: {
  logId: string,
}
// Use this for logging high-level reasoning or important milestones
```

### Tool Implementation Pattern

All MCP tools follow this implementation pattern:

```typescript
// Example: mcp__task__create_pr
export async function mcp__task__create_pr(
  input: { title: string; description: string },
  context: { agentId: string }
) {
  // 1. Fetch context
  const agent = await agentAccessor.findById(context.agentId);
  const task = await taskAccessor.findById(agent.taskId);
  const epic = await epicAccessor.findById(task.epicId);

  // 2. Execute business logic
  const prUrl = await githubClient.createPr({
    from: task.worktreeName,
    to: epic.worktreeName,
    title: input.title,
    description: input.description,
  });

  // 3. Update database
  await taskAccessor.update(task.id, {
    state: 'PENDING_REVIEW',
    prUrl,
  });

  // 4. Log decision
  await decisionLogAccessor.create({
    agentId: context.agentId,
    title: 'create_pr',
    body: JSON.stringify({ prUrl, taskId: task.id, title: input.title }),
  });

  // 5. Send notifications
  await mailAccessor.create({
    fromAgentId: context.agentId,
    toAgentId: epic.supervisorId,
    subject: 'PR Ready for Review',
    body: `Task complete: ${task.title}\nPR: ${prUrl}`,
  });

  // 6. Return response
  return { prUrl, taskId: task.id };
}
```

### Error Handling

All tools return consistent error format:

```typescript
{
  success: false,
  error: "Error message",
  details?: "Additional context",
}
```

Tools never throw exceptions - all errors are returned as structured responses for Claude to handle.

### Error Recovery Protocol

When MCP tools fail, the system follows a structured error recovery protocol to handle failures gracefully and escalate critical issues.

**Error Handling in Tool Execution:**

```typescript
async function executeMcpTool(
  agentId: string,
  toolName: string,
  toolInput: any
) {
  const agent = await agentAccessor.findById(agentId);

  // Check permissions first
  const permissionCheck = checkToolPermissions(agent.type, toolName);
  if (!permissionCheck.allowed) {
    return {
      success: false,
      error: permissionCheck.error,
    };
  }

  try {
    // Log tool invocation
    await decisionLogAccessor.create({
      agentId,
      title: toolName,
      body: JSON.stringify({
        type: 'tool_use',
        input: toolInput,
        timestamp: new Date(),
      }),
    });

    // Execute tool
    const result = await mcpToolRegistry[toolName](toolInput, { agentId });

    // Check for tool-reported errors
    if (result.success === false) {
      // Log tool error
      await decisionLogAccessor.create({
        agentId,
        title: `${toolName}_error`,
        body: JSON.stringify({
          type: 'tool_error',
          error: result.error,
          details: result.details,
          timestamp: new Date(),
        }),
      });

      // Escalate critical tool failures
      if (CRITICAL_TOOLS.includes(toolName)) {
        await escalateToolFailure(agent, toolName, result.error);
      }
    } else {
      // Log successful result
      await decisionLogAccessor.create({
        agentId,
        title: `${toolName}_result`,
        body: JSON.stringify({
          type: 'tool_result',
          success: true,
          output: result,
          timestamp: new Date(),
        }),
      });
    }

    return result;
  } catch (error) {
    // Unexpected exception - log critical error
    await decisionLogAccessor.create({
      agentId,
      title: `${toolName}_critical_error`,
      body: JSON.stringify({
        type: 'critical_error',
        error: error.message,
        stack: error.stack,
        timestamp: new Date(),
      }),
    });

    // Escalate unexpected errors
    await escalateCriticalError(agent, toolName, error);

    // Return error response to agent
    return {
      success: false,
      error: 'Internal tool error',
      details: error.message,
    };
  }
}
```

**Critical Tool Definition:**

Tools that are critical to agent operation and require escalation on failure:

```typescript
const CRITICAL_TOOLS = [
  'mcp__task__create_pr',      // Worker can't complete without this
  'mcp__epic__approve_pr',     // Supervisor can't merge without this
  'mcp__git__rebase',          // Rebase failures block progress
  'mcp__epic__create_task',    // Supervisor can't delegate work
  'mcp__epic__create_epic_pr', // Epic completion blocked
];
```

**Escalation Strategy:**

```typescript
async function escalateToolFailure(
  agent: Agent,
  toolName: string,
  error: string
) {
  // Determine escalation target based on agent type
  let escalationTarget: string | null = null;

  switch (agent.type) {
    case 'WORKER':
      // Workers escalate to their supervisor
      const task = await taskAccessor.findById(agent.taskId);
      const epic = await epicAccessor.findById(task.epicId);
      escalationTarget = epic.supervisorId;
      break;

    case 'SUPERVISOR':
      // Supervisors escalate to human
      escalationTarget = null; // Will send to human inbox
      break;

    case 'ORCHESTRATOR':
      // Orchestrator escalates to human
      escalationTarget = null;
      break;
  }

  // Send escalation mail
  await mailAccessor.create({
    fromAgentId: agent.id,
    toAgentId: escalationTarget,
    toHuman: escalationTarget === null,
    subject: `Critical Tool Failure: ${toolName}`,
    body: `Agent ${agent.type} encountered a critical failure while executing ${toolName}.

Error: ${error}

This may require manual intervention. Check the agent's decision logs for details.`,
  });
}

async function escalateCriticalError(
  agent: Agent,
  toolName: string,
  error: Error
) {
  // Unexpected exceptions always go to human
  await mailAccessor.create({
    fromAgentId: agent.id,
    toHuman: true,
    subject: `CRITICAL: Unexpected Error in ${toolName}`,
    body: `Agent ${agent.type} (${agent.id}) encountered an unexpected exception.

Tool: ${toolName}
Error: ${error.message}
Stack: ${error.stack}

This indicates a bug in the tool implementation. Immediate attention required.`,
  });
}
```

**Retry Logic for Transient Errors:**

Some tools may implement retry logic for transient failures (network issues, rate limits):

```typescript
async function executeToolWithRetry(
  toolFn: () => Promise<any>,
  maxRetries: number = 3
) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await toolFn();
    } catch (error) {
      lastError = error;

      // Only retry on transient errors
      if (isTransientError(error)) {
        // Exponential backoff: 1s, 2s, 4s
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }

      // Non-transient errors fail immediately
      throw error;
    }
  }

  // All retries exhausted
  throw lastError;
}

function isTransientError(error: any): boolean {
  // Network errors, rate limits, timeouts
  return (
    error.code === 'ECONNRESET' ||
    error.code === 'ETIMEDOUT' ||
    error.status === 429 || // Rate limit
    error.status === 503    // Service unavailable
  );
}
```

**Error Recovery Outcomes:**

1. **Tool Error Returned to Agent**: Agent receives error response and can handle it (e.g., try alternative approach)
2. **Escalation to Supervisor**: Critical worker failures notify supervisor via mail
3. **Escalation to Human**: Critical supervisor/orchestrator failures notify human
4. **Automatic Retry**: Transient errors retried with exponential backoff
5. **Logged for Debugging**: All errors logged to DecisionLog for post-mortem analysis

**Agent Crash vs Tool Error:**

- **Tool Error**: Tool returns error response, agent continues execution, can retry or adapt
- **Agent Crash**: Agent process dies, triggers heartbeat timeout, crash recovery protocol activates

This separation allows agents to handle recoverable errors while the system handles fatal crashes.

## Decision Logging

### Purpose
Comprehensive audit trail of all agent actions for debugging and analysis.

### Two-Layer Logging Architecture

**Layer 1: Automatic MCP Tool Call Logging**

All MCP tool calls are automatically intercepted and logged before and after execution. This happens transparently without any manual effort.

```typescript
// Automatic logging wrapper for all MCP tools
async function executeMcpTool(
  agentId: string,
  toolName: string,
  toolInput: any
) {
  // Log tool invocation
  await decisionLogAccessor.create({
    agentId,
    title: toolName,
    body: JSON.stringify({
      type: 'tool_use',
      input: toolInput,
      timestamp: new Date(),
    }),
  });

  // Execute tool
  const result = await mcpToolRegistry[toolName](toolInput, { agentId });

  // Log tool result
  await decisionLogAccessor.create({
    agentId,
    title: `${toolName}_result`,
    body: JSON.stringify({
      type: 'tool_result',
      success: result.success !== false,
      output: result,
      timestamp: new Date(),
    }),
  });

  return result;
}
```

**Layer 2: Manual Business Logic Logging**

Important decisions and system events that aren't tied to specific MCP tools are logged manually:

```typescript
// Manual logging for system events
await decisionLogAccessor.create({
  agentId: orchestrator.id,
  title: 'supervisor_crash_detected',
  body: JSON.stringify({
    supervisorId: crashedSupervisor.id,
    epicId: epic.id,
    reason: 'heartbeat_timeout',
    action: 'cascading_worker_reset',
    minutesSinceHeartbeat: 5,
  }),
});
```

### What Gets Logged

**Automatically Logged (Layer 1):**
- All `mcp__mail__*` tool calls (send, read, reply)
- All `mcp__task__*` tool calls (update_state, create_pr, get_pr_status)
- All `mcp__epic__*` tool calls (create_task, approve_pr, request_changes)
- All `mcp__git__*` tool calls (rebase, get_diff)
- All `mcp__agent__*` tool calls (get_status, get_task, get_epic)
- All `mcp__orchestrator__*` tool calls
- All `mcp__system__*` tool calls

**Manually Logged (Layer 2):**
- Agent lifecycle events (created, killed, crashed)
- Health check decisions
- Crash recovery actions
- Epic/task state transitions initiated by system (not agents)
- Inngest function executions
- Error conditions and recovery actions

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

## Human Notification System

### Design Philosophy

Humans need to be notified when important milestones are reached or when human intervention is required. FactoryFactory uses a **cross-platform desktop notification system** to alert users in real-time, even when they're not actively viewing the UI.

### When Notifications Are Sent

**Worker Completions:**
- Worker submits PR for task (task state → PENDING_REVIEW)
- Worker completes rebase (task state → PENDING_REVIEW after rebase)
- Worker fails after 5 attempts (task state → FAILED)

**Supervisor Completions:**
- Supervisor completes epic (epic state → AWAITING_HUMAN_REVIEW)
- Supervisor requests human intervention for critical failures

**Critical Errors:**
- Agent crashes and fails after retry limit
- Critical tool failures that require human attention
- Unexpected exceptions in system code

### Notification Service

```typescript
// Backend notification service
class NotificationService {
  async notify(title: string, message: string) {
    const config = await this.getConfig();

    if (config.soundEnabled) {
      await this.playSound(config.soundFile);
    }

    if (config.pushEnabled) {
      await this.sendPushNotification(title, message);
    }
  }

  private async sendPushNotification(title: string, message: string) {
    if (process.platform === 'darwin') {
      await this.sendMacOSNotification(title, message);
    } else if (process.platform === 'linux') {
      await this.sendLinuxNotification(title, message);
    } else if (process.platform === 'win32') {
      await this.sendWindowsNotification(title, message);
    }
  }

  private async sendMacOSNotification(title: string, message: string) {
    // Use osascript for native macOS notifications
    const script = `display notification "${message}" with title "${title}" sound name "Glass"`;
    await exec(`osascript -e '${script}'`);
  }

  private async sendLinuxNotification(title: string, message: string) {
    // Use notify-send or similar for Linux
    await exec(`notify-send "${title}" "${message}"`);
  }

  private async sendWindowsNotification(title: string, message: string) {
    // Use PowerShell toast notifications for Windows
    const script = `
      [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
      $Template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
      $RawXml = [xml] $Template.GetXml()
      $RawXml.toast.visual.binding.text[0].AppendChild($RawXml.CreateTextNode("${title}")) | Out-Null
      $RawXml.toast.visual.binding.text[1].AppendChild($RawXml.CreateTextNode("${message}")) | Out-Null
      $SerializedXml = New-Object Windows.Data.Xml.Dom.XmlDocument
      $SerializedXml.LoadXml($RawXml.OuterXml)
      $Toast = [Windows.UI.Notifications.ToastNotification]::new($SerializedXml)
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("FactoryFactory").Show($Toast)
    `;
    await exec(`powershell -Command "${script}"`);
  }

  private async playSound(soundFile: string) {
    if (process.platform === 'darwin') {
      await exec(`afplay ${soundFile}`);
    } else if (process.platform === 'linux') {
      await exec(`paplay ${soundFile}`).catch(() =>
        exec(`aplay ${soundFile}`)
      );
    } else if (process.platform === 'win32') {
      await exec(`powershell -c "(New-Object Media.SoundPlayer '${soundFile}').PlaySync()"`);
    }
  }
}
```

### Notification Examples

**Task Complete (Success):**
```
Title: Task Complete: Add user authentication
Message: ✅ 'Add user authentication' completed successfully
         Branch: task/123/add-user-auth
         PR: https://github.com/user/repo/pull/45
```

**Task Failed:**
```
Title: Task Failed: Add user authentication
Message: ❌ 'Add user authentication' failed after 5 attempts
         Last error: Rebase conflict in auth.ts
         Requires manual intervention
```

**Epic Complete:**
```
Title: Epic Complete: User Management System
Message: ✅ All tasks completed for 'User Management System'
         Epic PR: https://github.com/user/repo/pull/50
         Ready for human review
```

**Critical Error:**
```
Title: CRITICAL: Agent Error
Message: ❌ Supervisor agent crashed unexpectedly
         Epic: User Management System
         Check decision logs for details
```

### Integration Points

Notifications are triggered from key MCP tools and system events:

**In `mcp__task__create_pr`:**
```typescript
export async function mcp__task__create_pr(input, context) {
  // ... create PR logic ...

  // Send notification
  await notificationService.notify(
    `Task PR Created: ${task.title}`,
    `✅ PR ready for review\nBranch: ${task.worktreeName}\nPR: ${prUrl}`
  );

  return { prUrl, taskId };
}
```

**In `mcp__epic__create_epic_pr`:**
```typescript
export async function mcp__epic__create_epic_pr(input, context) {
  // ... create epic PR logic ...

  // Send notification
  await notificationService.notify(
    `Epic Complete: ${epic.title}`,
    `✅ All tasks finished\nEpic PR: ${prUrl}\nReady for your review`
  );

  return { prUrl };
}
```

**In crash recovery (Inngest functions):**
```typescript
// worker-crash-recovery.ts
export const workerCrashRecovery = inngest.createFunction(
  { id: 'worker-crash-recovery' },
  { event: 'worker.crashed' },
  async ({ event }) => {
    const { taskId, attempts } = event.data;

    if (attempts >= 5) {
      // Notify human of permanent failure
      await notificationService.notify(
        `Task Failed: ${task.title}`,
        `❌ Failed after ${attempts} attempts\nRequires manual intervention`
      );
    }
  }
);
```

### Configuration

Users can configure notification preferences:

```typescript
// In user settings
interface NotificationConfig {
  soundEnabled: boolean;
  pushEnabled: boolean;
  soundFile: string;  // Path to custom sound file
  notifyOnTaskComplete: boolean;
  notifyOnEpicComplete: boolean;
  notifyOnErrors: boolean;
  quietHoursStart?: string;  // e.g., "22:00"
  quietHoursEnd?: string;    // e.g., "08:00"
}
```

### Benefits

- **Immediate awareness**: Know when work is complete without checking UI
- **Proactive intervention**: Get notified of failures before they cascade
- **Multi-tasking**: Work on other things while agents work
- **Cross-platform**: Works on macOS, Linux, and Windows
- **Customizable**: Users can enable/disable sounds and push notifications

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
