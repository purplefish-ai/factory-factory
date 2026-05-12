# Periodic Tasks — Design Document

## Problem Statement

Users want to schedule recurring AI agent tasks (e.g. "update all dependencies daily") without manual intervention. Each invocation should spin up a fresh workspace, run the agent with a configured prompt, and—ideally—ship a pull request. The task should keep firing on schedule until it successfully produces a PR, then reset for the next cycle.

---

## Current State

### What exists today
- **Workspace creation** (`src/backend/services/workspace/service/lifecycle/creation.service.ts`): supports MANUAL, RESUME_BRANCH, GITHUB_ISSUE, LINEAR_ISSUE sources.
- **Polling infrastructure** (`src/backend/orchestration/scheduler.service.ts`, `src/backend/services/ratchet/service/ratchet.service.ts`): continuous background loops with graceful shutdown, rate-limit backoff, and interruptible sleep.
- **Settings UI** (`src/client/routes/admin-page.tsx`): two tabs — "General" and "Project".
- **Launch button** (`src/components/workspace/run-script-button.tsx`): manages dev server start/stop; no workspace-creation dropdown today.

### Gaps
1. No persistent task definition model in Prisma.
2. No cron/schedule expression parsing.
3. No execution history / audit trail.
4. No UI for creating or administering scheduled tasks.
5. No per-project workspace-creation dropdown on the launch button area.

---

## Proposed Architecture

### 1. Data Model (Prisma)

```prisma
model PeriodicTask {
  id          String   @id @default(cuid())
  projectId   String
  project     Project  @relation(fields: [projectId], references: [id])

  name        String
  prompt      String
  cadence     Cadence                    // DAILY | WEEKLY | MONTHLY

  isEnabled   Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  nextRunAt   DateTime                   // computed on create / after each run
  lastRunAt   DateTime?

  executions  PeriodicTaskExecution[]
}

model PeriodicTaskExecution {
  id             String    @id @default(cuid())
  periodicTaskId String
  periodicTask   PeriodicTask @relation(fields: [periodicTaskId], references: [id], onDelete: Cascade)

  workspaceId    String?   @unique
  workspace      Workspace? @relation(fields: [workspaceId], references: [id])

  startedAt      DateTime  @default(now())
  completedAt    DateTime?
  status         PeriodicTaskExecutionStatus  // RUNNING | PR_CREATED | FAILED | SKIPPED

  prUrl          String?
  prNumber       Int?
  errorMessage   String?
}

enum Cadence {
  DAILY
  WEEKLY
  MONTHLY
}

enum PeriodicTaskExecutionStatus {
  RUNNING
  PR_CREATED
  FAILED
  SKIPPED
}
```

`nextRunAt` is calculated from `cadence` on creation and reset after each run. The scheduler compares `nextRunAt <= now()` to find due tasks.

### 2. Backend Service Capsule

**Location:** `src/backend/services/periodic-task/`

```
periodic-task/
  index.ts                     ← barrel
  resources/
    periodic-task.accessor.ts  ← Prisma CRUD
  service/
    periodic-task.service.ts   ← scheduling loop + execution logic
```

**Scheduling loop** (same pattern as `RatchetService`):
```
while running:
  find all enabled tasks where nextRunAt <= now()
  for each due task:
    if previous execution is still RUNNING → skip (or check age + timeout)
    create workspace with task.prompt as initialPrompt, source=PERIODIC_TASK
    create PeriodicTaskExecution(status=RUNNING, workspaceId)
    compute and save nextRunAt
  sleep SERVICE_INTERVAL_MS.periodicTaskPoll (e.g. 60s)
```

**PR detection** (background check, could piggyback the existing scheduler):
```
for each RUNNING execution:
  fetch linked workspace.prUrl
  if prUrl present → update execution status=PR_CREATED, set completedAt
  if workspace failed/timed out → status=FAILED, schedule retry immediately
```

**Retry logic** ("keep executing until they create a PR"):
- On failure, the task's `nextRunAt` is reset to `now + retryDelay` (e.g. 15 min).
- On PR creation, `nextRunAt` is reset to the normal cadence from now.
- This means: if today's "update dependencies" run failed, it retries soon; if it made a PR, the next run is tomorrow (or whenever the cadence says).

**New `creationSource` enum value:** `PERIODIC_TASK` added to `WorkspaceCreationSource`.

### 3. tRPC Router

`src/backend/trpc/periodic-task.trpc.ts` with procedures:

| Procedure | Description |
|-----------|-------------|
| `periodicTask.list` | List all tasks for a project |
| `periodicTask.create` | Create task + trigger first run immediately |
| `periodicTask.update` | Edit prompt, cadence, name |
| `periodicTask.delete` | Delete task + its executions |
| `periodicTask.toggleEnabled` | Enable/disable without deleting |
| `periodicTask.listExecutions` | Execution history for a task |
| `periodicTask.runNow` | Trigger an immediate out-of-cycle run |

### 4. UI Changes

#### A. Launch Dropdown (Kanban / workspace list)

Add a split-button or dropdown next to the existing "Launch" / new-workspace button. A new option:

```
[ Launch ▾ ]
  ├─ New Workspace
  └─ New Periodic Task  ←  new
```

Clicking "New Periodic Task" opens a modal/drawer:
- **Name** (text)
- **Prompt** (textarea — same as initial prompt for workspace creation)
- **Cadence** (radio: Daily / Weekly / Monthly)
- Submit → calls `periodicTask.create`, immediately fires first run, shows confirmation.

**Component location:** `src/client/` alongside the existing workspace creation flow. The dropdown wrapper would live near wherever the primary "New Workspace" button is rendered.

#### B. Settings → "Periodic Tasks" Tab

New tab added to `src/client/routes/admin-page.tsx`:

```
[ General ]  [ Project ]  [ Periodic Tasks ]
                                ↑ new tab
```

Tab contents:
- Table of all periodic tasks for the selected project:
  - Name, Prompt (truncated), Cadence, Status (enabled/disabled), Last run, Next run
  - Actions: Edit (inline or modal), Enable/Disable toggle, Delete
  - Row expansion: last N executions with status, PR link, timestamps
- Empty state with CTA to create first task.

---

## Scheduling Backend Options

### Option A: Internal polling loop (recommended)
Extend the existing `SchedulerService` or create a new `PeriodicTaskService` that polls `periodicTask.nextRunAt <= now()` every 60 seconds. Consistent with the ratchet/scheduler pattern already in the codebase. No new dependencies.

**Pros:** Already proven pattern, graceful shutdown built-in, easy to test.  
**Cons:** Minute-granularity only (fine for daily/weekly/monthly); not suitable for sub-minute precision.

### Option B: `node-cron`
Store a cron expression per task. Use `node-cron` to schedule in-process jobs. More precise, supports arbitrary schedules.

**Pros:** Flexible cadence including "every weekday at 9am".  
**Cons:** New dependency; in-memory state lost on restart (need to re-register from DB on boot); harder to test; more complex than needed for daily/weekly/monthly.

### Option C: Inngest (already in codebase?)
If Inngest is available, use durable scheduled functions.

**Pros:** Durable, crash-safe, observable.  
**Cons:** Requires Inngest infrastructure; may not be appropriate for self-hosted use.

**Recommendation: Option A** — the polling pattern is already battle-tested in this codebase, daily/weekly/monthly granularity does not require precision beyond minutes, and it keeps the architecture simple and self-contained.

---

## Execution Lifecycle

```
User creates task
       │
       ▼
[PeriodicTask created, nextRunAt = now]
       │
       ▼
PeriodicTaskService polling loop fires
       │
       ├─ Creates Workspace (source=PERIODIC_TASK, initialPrompt=task.prompt)
       ├─ Creates PeriodicTaskExecution(status=RUNNING)
       └─ Sets nextRunAt = now + cadence
       
Agent runs in workspace...
       │
       ├─ PR created → execution.status=PR_CREATED, completedAt=now
       │               nextRunAt stays as cadence-based value (no retry)
       │
       └─ Workspace failed → execution.status=FAILED
                             nextRunAt = now + retryDelay (15 min)
                             → retry loop fires again
```

---

## Open Questions for Clarification

See bottom of this document.

---

## Out of Scope (for now)
- Sub-daily granularity (hourly, every N minutes)
- Task dependencies / chaining
- Notifications when a periodic task fails repeatedly
- Per-workspace periodic tasks (these are project-scoped)
- Timezone-aware scheduling

---

## Files to Create / Modify

### New
- `prisma/migrations/XXXX_add_periodic_tasks/migration.sql`
- `src/backend/services/periodic-task/index.ts`
- `src/backend/services/periodic-task/resources/periodic-task.accessor.ts`
- `src/backend/services/periodic-task/service/periodic-task.service.ts`
- `src/backend/trpc/periodic-task.trpc.ts`
- `src/client/components/periodic-task/` (modal, table, row)

### Modified
- `prisma/schema.prisma` — add `PeriodicTask`, `PeriodicTaskExecution`, enums
- `src/shared/core.ts` — add `PERIODIC_TASK` to `WorkspaceCreationSource`
- `src/backend/services/registry.ts` — register new capsule + model ownership
- `src/backend/trpc/index.ts` — mount new router
- `src/backend/server.ts` — start/stop `PeriodicTaskService`
- `src/backend/services/constants.ts` — add `periodicTaskPoll` interval
- `src/client/routes/admin-page.tsx` — add "Periodic Tasks" tab
- Launch button area — add dropdown with "New Periodic Task" option
