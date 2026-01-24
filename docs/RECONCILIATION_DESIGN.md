# Reconciliation-Based Task Infrastructure

## Overview

This document describes a reconciliation pattern for managing task infrastructure (worktrees, PRs, branches) that is self-healing and declarative. Instead of relying on event-driven MCP tool calls to create infrastructure, the system continuously reconciles **desired state** with **actual state**.

### Core Principle

> If a worktree gets deleted, something should cause that worktree to get recreated, then for work to continue.

This applies to all infrastructure: worktrees, branches, draft PRs, agent sessions. The system should be **level-triggered** (continuously checking "is reality correct?") rather than **edge-triggered** (reacting to events that may fail or be missed).

## Current Problems

1. **Infrastructure created via MCP tools** - Workers call `mcp__task__create_pr`, which can fail or be skipped
2. **No self-healing** - If worktree is deleted, task is stuck
3. **State divergence** - DB says one thing, reality says another, no automatic fix
4. **Event dependencies** - If Inngest event fails, infrastructure isn't created
5. **Manual recovery** - Humans must intervene when things break
6. **Conflated state** - Task state and agent state are mixed together (e.g., `IN_PROGRESS` implies agent is running)

## Separating Task State from Agent State

A key insight is that **task state** and **agent state** are separate concerns that are currently conflated:

### Task State (About the Deliverable)

Task state answers: "What's the status of this work?"

- Is the work started?
- Is it ready for review?
- Is it blocked on something external?
- Is it done?

Task state should NOT imply anything about whether an agent is currently running.

### Agent State (About the Executor)

Agent state answers: "What's happening with the executor?"

- Is an agent assigned to this task?
- Is that agent currently running?
- Is the agent healthy or crashed?
- Should the agent be running right now? (deferred work, rate limiting)

### Why This Matters

The current model can't express important scenarios:

| Task State | Agent Assigned | Agent Running | Scenario |
|------------|----------------|---------------|----------|
| IN_PROGRESS | Yes | No | **Deferred work** - paused overnight, rate limited |
| IN_PROGRESS | Yes | Crashed | **Needs recovery** - agent died mid-work |
| IN_PROGRESS | No | - | **Awaiting assignment** - no agent available yet |
| REVIEW | Yes | Idle | **Awaiting decision** - work done, waiting for supervisor |
| BLOCKED | Yes | Paused | **Waiting on dependency** - no point running agent |

### Proposed Model

```
┌─────────────────────────────────────────────────────────────────────┐
│                           TASK                                       │
├─────────────────────────────────────────────────────────────────────┤
│  state: TaskState          // About the WORK                        │
│    - PENDING               // Not started                           │
│    - IN_PROGRESS           // Being worked on                       │
│    - REVIEW                // Submitted for review                  │
│    - COMPLETED             // Work accepted                         │
│    - FAILED                // Work abandoned                        │
│    - BLOCKED               // External blocker                      │
│                                                                      │
│  assignedAgentId: String?  // WHO is responsible (nullable)         │
│                                                                      │
│  // Infrastructure (managed by reconciler)                          │
│  worktreePath: String?                                              │
│  branchName: String?                                                │
│  draftPrUrl: String?                                                │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                           AGENT                                      │
├─────────────────────────────────────────────────────────────────────┤
│  currentTaskId: String?    // What task they're working on          │
│                                                                      │
│  executionState: ExecutionState  // ACTUAL state                    │
│    - IDLE                  // Not doing anything                    │
│    - ACTIVE                // Session running, working              │
│    - PAUSED                // Assigned but intentionally not running│
│    - CRASHED               // Was running, died unexpectedly        │
│                                                                      │
│  desiredExecutionState: ExecutionState  // WANTED state             │
│    - Allows "I want this agent paused" (deferred work)              │
│    - Reconciler compares desired vs actual                          │
│                                                                      │
│  lastHeartbeat: DateTime?  // For health detection                  │
│  sessionId: String?        // For session resumption                │
│  tmuxSessionName: String?  // Actual tmux session                   │
└─────────────────────────────────────────────────────────────────────┘
```

### Reconciler Logic with Separation

```typescript
// Task reconciliation - about infrastructure
function reconcileTaskInfrastructure(task: Task) {
  // Does this task need infrastructure? (based on task state)
  if (task.state === 'PENDING' || task.state === 'COMPLETED') {
    return; // No infrastructure needed
  }

  // Ensure worktree, branch, PR exist
  ensureWorktree(task);
  ensureBranch(task);
  ensureDraftPr(task);

  // If REVIEW, ensure PR is marked ready
  if (task.state === 'REVIEW') {
    ensurePrReady(task);
  }
}

// Agent reconciliation - about execution
function reconcileAgent(agent: Agent) {
  const task = agent.currentTask;

  // Should this agent be running?
  const shouldBeRunning =
    agent.desiredExecutionState === 'ACTIVE' &&
    task?.state === 'IN_PROGRESS';

  // Is it actually running?
  const isRunning = agent.executionState === 'ACTIVE' &&
    tmuxSessionExists(agent.tmuxSessionName);

  if (shouldBeRunning && !isRunning) {
    // Start or restart agent
    startAgentSession(agent);
  } else if (!shouldBeRunning && isRunning) {
    // Stop agent (gracefully)
    stopAgentSession(agent);
  }
}
```

### Deferred Work Example

To pause work overnight:

```typescript
// Pause all agents for a project
async function pauseProject(projectId: string) {
  const agents = await agentAccessor.findByProject(projectId);
  for (const agent of agents) {
    await agentAccessor.update(agent.id, {
      desiredExecutionState: 'PAUSED'
    });
  }
  // Reconciler will stop the sessions, but task state remains IN_PROGRESS
}

// Resume in the morning
async function resumeProject(projectId: string) {
  const agents = await agentAccessor.findByProject(projectId);
  for (const agent of agents) {
    await agentAccessor.update(agent.id, {
      desiredExecutionState: 'ACTIVE'
    });
  }
  // Reconciler will restart the sessions
}
```

The task stays `IN_PROGRESS` the whole time - only the agent execution state changes.

## Desired State Model

With task state and agent state separated, we have two independent reconciliation concerns:

### Task State → Required Infrastructure

Task state determines what **infrastructure** should exist (worktree, branch, PR).
This is independent of whether an agent is running.

```
┌─────────────────┬──────────────────────────────────────────────────────┐
│ Task State      │ Required Infrastructure                              │
├─────────────────┼──────────────────────────────────────────────────────┤
│ PENDING         │ None (task not ready for work yet)                   │
├─────────────────┼──────────────────────────────────────────────────────┤
│ IN_PROGRESS     │ • Worktree exists at task.worktreePath               │
│                 │ • Branch exists: task.branchName                     │
│                 │ • Draft PR exists: task.draftPrUrl                   │
│                 │ • Branch is based on parent (epic) branch            │
│                 │ (Agent may or may not be running - separate concern) │
├─────────────────┼──────────────────────────────────────────────────────┤
│ REVIEW          │ Same as IN_PROGRESS, plus:                           │
│                 │ • PR is marked ready (not draft)                     │
│                 │ • PR has latest commits pushed                       │
├─────────────────┼──────────────────────────────────────────────────────┤
│ COMPLETED       │ • PR is merged                                       │
│                 │ • Worktree can be cleaned up                         │
│                 │ • Branch can be deleted                              │
├─────────────────┼──────────────────────────────────────────────────────┤
│ FAILED          │ • Worktree preserved for debugging                   │
│                 │ • PR remains as draft                                │
├─────────────────┼──────────────────────────────────────────────────────┤
│ BLOCKED         │ • Worktree preserved                                 │
│                 │ • PR remains as draft                                │
│                 │ • Agent should be PAUSED (no point running)          │
└─────────────────┴──────────────────────────────────────────────────────┘
```

### Agent State → Required Execution

Agent state determines whether a **session should be running**.
This is independent of task infrastructure.

```
┌─────────────────────────────┬───────────────────────────────────────────┐
│ Agent Desired State         │ Required Execution                        │
├─────────────────────────────┼───────────────────────────────────────────┤
│ ACTIVE                      │ • Tmux session exists and running         │
│ (and task is IN_PROGRESS)   │ • Claude Code process is alive            │
│                             │ • Recent heartbeat (< 5 min)              │
├─────────────────────────────┼───────────────────────────────────────────┤
│ PAUSED                      │ • No tmux session should exist            │
│                             │ • Agent record preserved for resumption   │
│                             │ • Session ID preserved for context        │
├─────────────────────────────┼───────────────────────────────────────────┤
│ IDLE                        │ • No tmux session                         │
│                             │ • Agent available for new work            │
└─────────────────────────────┴───────────────────────────────────────────┘
```

### Combined Reconciliation Matrix

The reconciler checks both dimensions independently:

```
┌─────────────┬─────────────┬─────────────────────────────────────────────┐
│ Task State  │ Agent State │ Reconciler Actions                          │
├─────────────┼─────────────┼─────────────────────────────────────────────┤
│ IN_PROGRESS │ ACTIVE      │ Ensure infra + Ensure session running       │
│ IN_PROGRESS │ PAUSED      │ Ensure infra only (deferred work)           │
│ IN_PROGRESS │ CRASHED     │ Ensure infra + Restart session              │
│ IN_PROGRESS │ (none)      │ Ensure infra + Assign agent                 │
├─────────────┼─────────────┼─────────────────────────────────────────────┤
│ REVIEW      │ ACTIVE      │ Ensure infra + Mark PR ready + Stop agent   │
│ REVIEW      │ PAUSED      │ Ensure infra + Mark PR ready                │
│ REVIEW      │ IDLE        │ Ensure infra + Mark PR ready                │
├─────────────┼─────────────┼─────────────────────────────────────────────┤
│ BLOCKED     │ ACTIVE      │ Ensure infra + Pause agent (no point)       │
│ BLOCKED     │ PAUSED      │ Ensure infra only                           │
├─────────────┼─────────────┼─────────────────────────────────────────────┤
│ COMPLETED   │ *           │ Cleanup infra + Release agent               │
│ FAILED      │ *           │ Preserve infra + Release agent              │
└─────────────┴─────────────┴─────────────────────────────────────────────┘
```

### Top-Level Task (Epic) Infrastructure

```
┌─────────────────┬──────────────────────────────────────────────────────┐
│ Task State      │ Required Infrastructure                              │
├─────────────────┼──────────────────────────────────────────────────────┤
│ PLANNING        │ • Worktree exists for supervisor                     │
│                 │ • Epic branch exists                                 │
├─────────────────┼──────────────────────────────────────────────────────┤
│ IN_PROGRESS     │ Same as PLANNING                                     │
│                 │ (Supervisor agent state is separate)                 │
├─────────────────┼──────────────────────────────────────────────────────┤
│ COMPLETED       │ • Final PR exists (epic branch → main)               │
│                 │ • All subtask infrastructure cleaned up              │
└─────────────────┴──────────────────────────────────────────────────────┘
```

## Reconciliation Loop

### High-Level Flow

```
Every 30 seconds (Inngest cron):

┌─────────────────────────────────────────────────────────────────────────┐
│                         RECONCILIATION LOOP                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. FETCH all active tasks (not COMPLETED/CANCELLED)                    │
│                                                                         │
│  2. For each task, COMPARE desired vs actual:                           │
│     ┌─────────────────────────────────────────────────────────────┐     │
│     │  Desired State          │  Check                            │     │
│     ├─────────────────────────┼───────────────────────────────────┤     │
│     │  Worktree exists        │  fs.existsSync(task.worktreePath) │     │
│     │  Branch exists          │  git rev-parse --verify branch    │     │
│     │  Draft PR exists        │  gh pr view --json state          │     │
│     │  PR is ready (not draft)│  gh pr view --json isDraft        │     │
│     │  Agent session running  │  tmux has-session -t name         │     │
│     └─────────────────────────┴───────────────────────────────────┘     │
│                                                                         │
│  3. For each MISMATCH, REMEDIATE:                                       │
│     ┌─────────────────────────────────────────────────────────────┐     │
│     │  Mismatch               │  Remediation                      │     │
│     ├─────────────────────────┼───────────────────────────────────┤     │
│     │  Worktree missing       │  git worktree add ...             │     │
│     │  Branch missing         │  git branch ... (recreate)        │     │
│     │  Draft PR missing       │  gh pr create --draft             │     │
│     │  PR should be ready     │  gh pr ready                      │     │
│     │  Agent session dead     │  Restart agent session            │     │
│     └─────────────────────────┴───────────────────────────────────┘     │
│                                                                         │
│  4. LOG all actions taken for debugging                                 │
│                                                                         │
│  5. ALERT if remediation fails repeatedly                               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Pseudocode

With separated concerns, the reconciler has two independent loops:

```typescript
// Main reconciliation entry point
async function runReconciliation() {
  // 1. Reconcile all task infrastructure (independent of agents)
  const activeTasks = await taskAccessor.findActive();
  for (const task of activeTasks) {
    await reconcileTaskInfrastructure(task);
  }

  // 2. Reconcile all agent execution (independent of tasks)
  const agents = await agentAccessor.findAll();
  for (const agent of agents) {
    await reconcileAgentExecution(agent);
  }
}

// Task infrastructure reconciliation
async function reconcileTaskInfrastructure(task: Task): Promise<ReconcileResult> {
  const desiredInfra = getDesiredInfrastructure(task);
  const actualInfra = await getActualInfrastructure(task);
  const actions: RemediationAction[] = [];

  // Check infrastructure (independent of agent state)
  if (desiredInfra.worktree && !actualInfra.worktreeExists) {
    actions.push({ type: 'CREATE_WORKTREE', task });
  }

  if (desiredInfra.branch && !actualInfra.branchExists) {
    actions.push({ type: 'CREATE_BRANCH', task });
  }

  if (desiredInfra.draftPr && !actualInfra.draftPrExists) {
    actions.push({ type: 'CREATE_DRAFT_PR', task });
  }

  if (desiredInfra.prReady && actualInfra.prIsDraft) {
    actions.push({ type: 'MARK_PR_READY', task });
  }

  // Execute remediations
  for (const action of actions) {
    await executeWithRetry(action);
  }

  return { task, actions };
}

// Agent execution reconciliation
async function reconcileAgentExecution(agent: Agent): Promise<ReconcileResult> {
  const task = agent.currentTaskId
    ? await taskAccessor.findById(agent.currentTaskId)
    : null;

  const shouldBeRunning = getShouldAgentBeRunning(agent, task);
  const isRunning = await checkAgentSessionRunning(agent);

  if (shouldBeRunning && !isRunning) {
    // Need to start/restart agent
    if (agent.executionState === 'CRASHED') {
      await restartAgentWithResume(agent);
    } else {
      await startAgentSession(agent);
    }
    await agentAccessor.update(agent.id, { executionState: 'ACTIVE' });
  }

  if (!shouldBeRunning && isRunning) {
    // Need to stop agent
    await stopAgentSession(agent);
    await agentAccessor.update(agent.id, { executionState: 'PAUSED' });
  }

  // Update crashed detection
  if (shouldBeRunning && !isRunning && agent.executionState === 'ACTIVE') {
    await agentAccessor.update(agent.id, { executionState: 'CRASHED' });
  }

  return { agent, shouldBeRunning, isRunning };
}

// Determine desired infrastructure from task state alone
function getDesiredInfrastructure(task: Task): DesiredInfrastructure {
  switch (task.state) {
    case 'PENDING':
      return { worktree: false, branch: false, draftPr: false, prReady: false };

    case 'IN_PROGRESS':
    case 'BLOCKED':
    case 'FAILED':
      return { worktree: true, branch: true, draftPr: true, prReady: false };

    case 'REVIEW':
      return { worktree: true, branch: true, draftPr: true, prReady: true };

    case 'COMPLETED':
      return { worktree: false, branch: false, draftPr: false, prReady: false };

    default:
      return { worktree: true, branch: true, draftPr: true, prReady: false };
  }
}

// Determine if agent should be running (combines agent desired state + task state)
function getShouldAgentBeRunning(agent: Agent, task: Task | null): boolean {
  // Agent explicitly paused? Don't run.
  if (agent.desiredExecutionState === 'PAUSED') {
    return false;
  }

  // No task assigned? Don't run.
  if (!task) {
    return false;
  }

  // Task not in a "work needed" state? Don't run.
  if (task.state !== 'IN_PROGRESS') {
    return false;
  }

  // Task blocked? Don't run (no point).
  if (task.state === 'BLOCKED') {
    return false;
  }

  // All conditions met - should be running
  return agent.desiredExecutionState === 'ACTIVE';
}
```

## Remediation Strategies

### 1. Worktree Missing

**Detection:** `fs.existsSync(task.worktreePath)` returns false

**Remediation:**
```typescript
async function remediateWorktree(task: Task) {
  const epicTask = await getTopLevelTask(task);
  const epicBranch = epicTask.branchName;

  // Check if branch still exists
  const branchExists = await gitClient.branchExists(task.branchName);

  if (branchExists) {
    // Recreate worktree pointing to existing branch
    await gitClient.addWorktree(task.worktreePath, task.branchName);
  } else {
    // Branch also gone - recreate both from epic branch
    await gitClient.createWorktree(task.worktreePath, epicBranch);
    // Note: commits are lost, but work can continue
  }
}
```

**Edge Cases:**
- Branch exists but worktree doesn't → just recreate worktree
- Both missing → recreate from epic branch (work lost, but recoverable)
- Epic branch missing → critical error, alert human

### 2. Branch Missing

**Detection:** `git rev-parse --verify {branchName}` fails

**Remediation:**
```typescript
async function remediateBranch(task: Task) {
  const epicTask = await getTopLevelTask(task);

  // Check if worktree still has the commits
  if (fs.existsSync(task.worktreePath)) {
    // Worktree exists - branch reference may just be missing
    // Recreate branch pointing to worktree HEAD
    await gitClient.createBranchFromWorktree(task.branchName, task.worktreePath);
  } else {
    // Both missing - recreate from epic branch
    await gitClient.createBranch(task.branchName, epicTask.branchName);
  }
}
```

### 3. Draft PR Missing

**Detection:** `gh pr view {branchName} --json number` fails or returns nothing

**Remediation:**
```typescript
async function remediateDraftPr(task: Task) {
  const epicTask = await getTopLevelTask(task);

  // Create draft PR
  const prUrl = await githubClient.createPR({
    head: task.branchName,
    base: epicTask.branchName,
    title: `[Draft] ${task.title}`,
    body: `Automated draft PR for task: ${task.title}\n\n${task.description || ''}`,
    draft: true
  });

  // Update task with PR URL
  await taskAccessor.update(task.id, { draftPrUrl: prUrl });
}
```

### 4. PR Should Be Ready But Is Draft

**Detection:** Task in REVIEW state but `gh pr view --json isDraft` returns true

**Remediation:**
```typescript
async function remediatePrReady(task: Task) {
  await githubClient.markPrReady(task.draftPrUrl);
}
```

### 5. Agent Session Dead

**Detection:** `tmux has-session -t {sessionName}` fails

**Remediation:**
```typescript
async function remediateAgentSession(task: Task) {
  const agent = await agentAccessor.findByTaskId(task.id);

  if (!agent) {
    // No agent assigned - this is a different problem
    // Trigger worker assignment
    await startWorker(task.id);
    return;
  }

  // Agent exists but session dead - restart with session resumption
  await restartAgentSession(agent, {
    resumeSessionId: agent.sessionId,  // Preserve context
    worktreePath: task.worktreePath
  });
}
```

## Error Handling

### Failure Tracking

Track remediation failures per task per action type:

```typescript
interface RemediationFailure {
  taskId: string;
  actionType: RemediationActionType;
  failureCount: number;
  lastFailure: Date;
  lastError: string;
}
```

### Escalation Policy

```
Failure Count | Action
--------------+------------------------------------------
1             | Log warning, retry next reconcile cycle
2             | Log error, retry with backoff
3             | Alert human via notification service
5             | Mark task as BLOCKED, stop retrying
```

### Circuit Breaker

If too many remediations fail across the system, pause reconciliation and alert:

```typescript
const CIRCUIT_BREAKER_THRESHOLD = 10; // failures in 5 minutes
const CIRCUIT_BREAKER_WINDOW = 5 * 60 * 1000;

async function runReconciliation() {
  if (circuitBreakerOpen()) {
    notifyHuman('Reconciliation paused due to repeated failures');
    return;
  }

  // ... normal reconciliation
}
```

## State Transitions

### Current: Event-Driven (Fragile)

```
Task created → Inngest event → Worker created → MCP tool → PR created
                    ↓
              (event lost?)
                    ↓
              Task stuck with no PR
```

### Proposed: Level-Triggered (Self-Healing)

```
Task created → State: ASSIGNED → Reconciler sees "needs PR" → Creates PR
                                         ↓
                                 (PR deleted somehow?)
                                         ↓
                                 Reconciler sees "needs PR" → Creates PR again
```

## Simplifying MCP Tools

With reconciliation handling infrastructure, MCP tools become simpler:

### Before (Infrastructure via MCP)

```typescript
// Worker had to call these to create infrastructure
'mcp__task__create_pr'      // Create PR when done
'mcp__task__update_state'   // Manually transition state
'mcp__git__rebase'          // Manually rebase
```

### After (Signals Only)

```typescript
// Worker just signals intent, reconciler handles infrastructure
'mcp__task__signal_ready'   // "I'm done, ready for review"
'mcp__task__signal_blocked' // "I need help"
'mcp__task__signal_failed'  // "I can't complete this"

// These signals update task state, reconciler does the rest:
// - signal_ready → state: REVIEW → reconciler marks PR ready
// - signal_blocked → state: BLOCKED → reconciler alerts human
// - signal_failed → state: FAILED → reconciler cleans up
```

## Implementation Plan

### Phase 1: Infrastructure Reconciliation

1. Add `draftPrUrl` field to Task model
2. Create reconciliation service with checks for:
   - Worktree exists
   - Branch exists
   - Draft PR exists
3. Create Inngest cron job (every 30s)
4. Add remediation functions for each check
5. Add failure tracking and alerting

### Phase 2: Pre-Provisioning

1. When task transitions PENDING → ASSIGNED:
   - Create worktree
   - Create branch
   - Create draft PR
   - All done by reconciler, not MCP tools
2. Remove `mcp__task__create_pr` (replaced by `mcp__task__signal_ready`)
3. Worker just works in pre-provisioned environment

### Phase 3: State Reconciliation

1. Reconciler also manages state transitions based on reality:
   - Commits pushed + signal_ready received → REVIEW
   - PR merged → COMPLETED
   - Repeated failures → BLOCKED
2. Remove `mcp__task__update_state` (reconciler manages state)

### Phase 4: Rebase Handling

1. When a PR is merged to epic branch:
   - Reconciler detects other tasks need rebase
   - Reconciler executes rebase (not worker via MCP)
   - If conflicts, task → BLOCKED, alert worker
2. Remove `mcp__git__rebase` from worker tools

## Database Changes

### Task Model (About the Work)

```prisma
model Task {
  id          String    @id @default(cuid())
  projectId   String
  parentId    String?   // null = top-level task (epic)
  title       String
  description String?   @db.Text

  // Task state - about the WORK, not the agent
  state       TaskState @default(PENDING)

  // Agent assignment (relationship, not state)
  assignedAgentId String?

  // Infrastructure (managed by reconciler)
  worktreePath     String?
  branchName       String?
  draftPrUrl       String?    // Created early, before agent starts

  // Reconciliation tracking
  infraStatus       InfraStatus @default(PENDING)
  lastReconcileAt   DateTime?
  reconcileFailures Json?      // { worktree: 0, branch: 0, pr: 0 }

  // Timestamps
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  completedAt DateTime?
}

enum TaskState {
  PENDING       // Not started, no agent assigned yet
  IN_PROGRESS   // Being worked on (agent may or may not be running)
  REVIEW        // Work submitted for review
  COMPLETED     // Work accepted and merged
  FAILED        // Work abandoned
  BLOCKED       // External blocker (dependency, human input needed)
}

enum InfraStatus {
  PENDING      // Not yet provisioned
  PROVISIONING // Being created
  READY        // All infrastructure exists
  DEGRADED     // Some infrastructure missing, being repaired
  FAILED       // Repeated failures, needs human intervention
}
```

### Agent Model (About the Executor)

```prisma
model Agent {
  id        String    @id @default(cuid())
  projectId String
  type      AgentType // SUPERVISOR, WORKER, ORCHESTRATOR

  // Current work assignment
  currentTaskId String?

  // Execution state - about the AGENT, not the task
  executionState        ExecutionState @default(IDLE)
  desiredExecutionState ExecutionState @default(IDLE)

  // Session info (for resumption)
  sessionId       String?   // Claude Code session ID
  tmuxSessionName String?   // Actual tmux session name

  // Health tracking
  lastHeartbeat DateTime?
  crashCount    Int       @default(0)
  lastCrashAt   DateTime?

  // Timestamps
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

enum ExecutionState {
  IDLE     // Not doing anything, available for work
  ACTIVE   // Session running, actively working
  PAUSED   // Intentionally not running (deferred work)
  CRASHED  // Was running, died unexpectedly
}

enum AgentType {
  ORCHESTRATOR
  SUPERVISOR
  WORKER
}
```

### Key Differences from Current Model

| Aspect | Current | Proposed |
|--------|---------|----------|
| Task IN_PROGRESS | Implies agent running | Just means "work in progress" |
| Agent state | Single `state` field | Separate `executionState` + `desiredExecutionState` |
| Deferred work | Not possible | Set `desiredExecutionState: PAUSED` |
| Crash detection | Complex health checks | `executionState: CRASHED` when detected |
| Assignment | Mixed with state | Explicit `assignedAgentId` relationship |

## Benefits

| Aspect | Before | After |
|--------|--------|-------|
| Worktree deleted | Task stuck forever | Recreated in 30s |
| PR accidentally closed | Task stuck | Recreated in 30s |
| Event lost | Infrastructure never created | Reconciler creates it |
| Agent crashes | 7 min detection | 30s detection + restart |
| Worker complexity | Must manage infrastructure | Just write code + signal |
| Debugging | "Why is this stuck?" | Clear desired vs actual logs |
| Deferred work | Not possible | Set `desiredExecutionState: PAUSED` |
| Rate limiting | Not possible | Control via `desiredExecutionState` |
| State clarity | "IN_PROGRESS" = agent running? | Task state ≠ agent state |
| Pause overnight | Kill everything, hope it recovers | Pause agents, resume in morning |

## Open Questions

1. **How to handle work loss?** If worktree AND branch are deleted, commits are lost. Options:
   - Accept loss, restart from epic branch
   - Try to recover from GitHub PR commits
   - Alert human before recreating

2. **Reconciliation frequency?** 30s is a balance between responsiveness and load. Could be configurable per-project.

3. **Executor pool integration?** This design focuses on state separation and infrastructure. Issue #28's executor pool pattern could layer on top later for resource limiting.

4. **PR draft vs ready timing?** Should draft PR be created immediately, or only when task is IN_PROGRESS? (Proposed: when task enters IN_PROGRESS, as part of infrastructure provisioning)

5. **Agent lifecycle on task completion?** When a task completes:
   - Should agent go to IDLE and be available for new work?
   - Should agent be released entirely?
   - (Proposed: IDLE, can be reassigned by supervisor)

6. **Heartbeat mechanism?** How does an agent signal it's still alive?
   - Periodic MCP tool call?
   - Tmux output monitoring?
   - Explicit heartbeat endpoint?

7. **Session resumption depth?** When restarting a crashed agent:
   - Resume with full context (expensive)?
   - Resume with summary only?
   - Start fresh with task description?
