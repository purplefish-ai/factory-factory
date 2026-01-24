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

## Desired State Model

Each task has a **desired state** based on its lifecycle stage. The reconciler ensures reality matches.

### Task Lifecycle → Required Infrastructure

```
┌─────────────────┬──────────────────────────────────────────────────────┐
│ Task State      │ Required Infrastructure (Desired State)              │
├─────────────────┼──────────────────────────────────────────────────────┤
│ PENDING         │ None (task just created, not ready for work)         │
├─────────────────┼──────────────────────────────────────────────────────┤
│ ASSIGNED        │ • Worktree exists at task.worktreePath               │
│                 │ • Branch exists: task.branchName                     │
│                 │ • Draft PR exists: task.draftPrUrl                   │
│                 │ • Branch is based on parent (epic) branch            │
├─────────────────┼──────────────────────────────────────────────────────┤
│ IN_PROGRESS     │ Same as ASSIGNED, plus:                              │
│                 │ • Agent session is running                           │
│                 │ • Agent is actively working (recent heartbeat)       │
├─────────────────┼──────────────────────────────────────────────────────┤
│ REVIEW          │ Same as ASSIGNED, plus:                              │
│                 │ • PR is marked ready (not draft)                     │
│                 │ • PR has latest commits pushed                       │
├─────────────────┼──────────────────────────────────────────────────────┤
│ COMPLETED       │ • PR is merged                                       │
│                 │ • Worktree can be cleaned up                         │
│                 │ • Branch can be deleted                              │
├─────────────────┼──────────────────────────────────────────────────────┤
│ FAILED/BLOCKED  │ • Worktree preserved for debugging                   │
│                 │ • PR remains as draft                                │
└─────────────────┴──────────────────────────────────────────────────────┘
```

### Top-Level Task (Epic) Infrastructure

```
┌─────────────────┬──────────────────────────────────────────────────────┐
│ Task State      │ Required Infrastructure                              │
├─────────────────┼──────────────────────────────────────────────────────┤
│ PLANNING        │ • Worktree exists for supervisor                     │
│                 │ • Epic branch exists                                 │
├─────────────────┼──────────────────────────────────────────────────────┤
│ IN_PROGRESS     │ Same as PLANNING, plus:                              │
│                 │ • Supervisor session is running                      │
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

```typescript
async function reconcileTask(task: Task): Promise<ReconcileResult> {
  const desired = getDesiredState(task);
  const actual = await getActualState(task);
  const actions: RemediationAction[] = [];

  // Check each infrastructure component
  if (desired.worktree && !actual.worktreeExists) {
    actions.push({ type: 'CREATE_WORKTREE', task });
  }

  if (desired.branch && !actual.branchExists) {
    actions.push({ type: 'CREATE_BRANCH', task });
  }

  if (desired.draftPr && !actual.draftPrExists) {
    actions.push({ type: 'CREATE_DRAFT_PR', task });
  }

  if (desired.prReady && actual.prIsDraft) {
    actions.push({ type: 'MARK_PR_READY', task });
  }

  if (desired.agentRunning && !actual.agentSessionExists) {
    actions.push({ type: 'RESTART_AGENT', task });
  }

  // Execute remediations
  for (const action of actions) {
    try {
      await executeRemediation(action);
      logDecision(task.id, `Remediated: ${action.type}`);
    } catch (error) {
      logDecision(task.id, `Remediation failed: ${action.type}`, error);
      incrementFailureCount(task, action.type);
    }
  }

  return { task, actions, success: actions.every(a => a.succeeded) };
}

function getDesiredState(task: Task): DesiredState {
  switch (task.state) {
    case 'PENDING':
      return { worktree: false, branch: false, draftPr: false, prReady: false, agentRunning: false };

    case 'ASSIGNED':
      return { worktree: true, branch: true, draftPr: true, prReady: false, agentRunning: false };

    case 'IN_PROGRESS':
      return { worktree: true, branch: true, draftPr: true, prReady: false, agentRunning: true };

    case 'REVIEW':
      return { worktree: true, branch: true, draftPr: true, prReady: true, agentRunning: false };

    case 'COMPLETED':
      return { worktree: false, branch: false, draftPr: false, prReady: false, agentRunning: false };

    default:
      return { worktree: true, branch: true, draftPr: true, prReady: false, agentRunning: false };
  }
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

```prisma
model Task {
  // ... existing fields ...

  // New fields for reconciliation
  draftPrUrl           String?    // Draft PR URL (created early)
  infrastructureStatus InfraStatus @default(PENDING)
  lastReconcileAt      DateTime?
  reconcileFailures    Json?      // { worktree: 0, branch: 0, pr: 0 }
}

enum InfraStatus {
  PENDING      // Not yet provisioned
  PROVISIONING // Being created
  READY        // All infrastructure exists
  DEGRADED     // Some infrastructure missing, being repaired
  FAILED       // Repeated failures, needs human intervention
}
```

## Benefits

| Aspect | Before | After |
|--------|--------|-------|
| Worktree deleted | Task stuck forever | Recreated in 30s |
| PR accidentally closed | Task stuck | Recreated in 30s |
| Event lost | Infrastructure never created | Reconciler creates it |
| Agent crashes | 7 min detection | 30s detection + restart |
| Worker complexity | Must manage infrastructure | Just write code + signal |
| Debugging | "Why is this stuck?" | Clear desired vs actual logs |

## Open Questions

1. **How to handle work loss?** If worktree AND branch are deleted, commits are lost. Options:
   - Accept loss, restart from epic branch
   - Try to recover from GitHub PR commits
   - Alert human before recreating

2. **Reconciliation frequency?** 30s is a balance between responsiveness and load. Could be configurable per-project.

3. **Executor model integration?** This design focuses on infrastructure. Issue #28's executor pool could layer on top later.

4. **PR draft vs ready timing?** Should draft PR be created immediately, or only when worker starts? (Proposed: immediately, to catch deleted PRs early)
