# Periodic Tasks — Design Document

## Problem Statement

Users want to schedule recurring AI agent tasks (e.g. "update all dependencies daily", "generate a weekly report") without manual intervention. Each invocation should spin up a fresh workspace, run the agent with a configured prompt, and—ideally—ship a pull request. The task should keep firing on schedule until it successfully produces a PR, then reset for the next cycle.

---

## Current State (Before This PR)

### What existed
- **Workspace creation** (`src/backend/services/workspace/service/lifecycle/creation.service.ts`): supported MANUAL, RESUME_BRANCH, GITHUB_ISSUE, LINEAR_ISSUE sources.
- **Polling infrastructure** (`src/backend/orchestration/scheduler.service.ts`, `src/backend/services/ratchet/service/ratchet.service.ts`): continuous background loops with graceful shutdown, rate-limit backoff, and interruptible sleep.
- **Settings UI** (`src/client/routes/admin-page.tsx`): two tabs — "General" and "Project".
- **Workspace creation form** (`src/client/components/kanban/inline-workspace-form.tsx`): only supported creating a single workspace.

### Gaps
1. No persistent task definition model in Prisma.
2. No cron/schedule expression parsing.
3. No execution history / audit trail.
4. No UI for creating or administering scheduled tasks.
5. No workspace-creation mode selector in the Kanban launch form.

---

## Solution Overview

This PR adds a **Periodic Tasks** feature end-to-end:

1. **Prisma models**: `PeriodicTask` and `PeriodicTaskExecution` with a new `PERIODIC_TASK` workspace creation source.
2. **Backend service capsule** (`src/backend/services/periodic-task/`): a polling loop that dispatches due tasks and monitors their workspaces for PR creation or failure.
3. **tRPC router**: CRUD operations, toggle enable/disable, execution history.
4. **Domain bridges**: workspace creation and status checking are wired through the orchestration layer, keeping the service capsule decoupled from other services.
5. **UI**: a cadence selector in the Kanban creation form, a "Periodic Tasks" admin tab, and a "Periodic Task" panel in the workspace right sidebar.

---

## Architecture

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

`nextRunAt` is set to `now()` on creation (triggering an immediate first run) and advanced by cadence after each dispatch. On re-enable, `nextRunAt` is reset to `now + cadence`.

### 2. Backend Service Capsule

**Location:** `src/backend/services/periodic-task/`

```
periodic-task/
  index.ts                     ← barrel (sole public API)
  resources/
    periodic-task.accessor.ts  ← Prisma CRUD + computeNextRunAt
  service/
    periodic-task.service.ts   ← PeriodicTaskService class (polling loop)
```

**Polling loop** (60-second interval, same interruptible-sleep pattern as `RatchetService`):

```
while running:
  pollDueTasks()
    → find enabled tasks where nextRunAt <= now
    → for each: skip if RUNNING execution exists, else dispatchTask()
  checkRunningExecutions()
    → for each RUNNING execution: fetch workspace status via bridge
    → if prUrl present → mark PR_CREATED
    → if workspace FAILED or ARCHIVED → mark FAILED
  sleep(60s)  ← interruptible for fast shutdown
```

**Bridge interfaces** (defined in the service, wired by orchestration):

```typescript
interface PeriodicTaskWorkspaceBridge {
  createWorkspaceForTask(params: {
    projectId: string;
    name: string;
    prompt: string;
    periodicTaskId: string;
  }): Promise<{ workspaceId: string }>;
}

interface PeriodicTaskWorkspaceStatusBridge {
  getWorkspaceStatus(workspaceId: string): Promise<{
    status: string;
    prUrl: string | null;
    prNumber: number | null;
  } | null>;
}
```

**Dispatch flow:**
1. Create workspace via `workspaceBridge.createWorkspaceForTask` (name auto-formatted as `"<task name> — <date>"`)
2. Create `PeriodicTaskExecution` record with `status=RUNNING`
3. Advance `nextRunAt` to `now + cadence` via `markDispatched`

**Failure handling:**
- If the workspace ends in `FAILED` or `ARCHIVED` state without producing a PR, the execution is marked `FAILED`.
- `nextRunAt` is already advanced at dispatch time, so retries happen on the next cadence cycle — *not* immediately on failure. (See open questions.)

### 3. Domain Bridge Wiring

All cross-service calls flow through `src/backend/orchestration/domain-bridges.orchestrator.ts`. The `PeriodicTaskService` holds bridge interfaces; the orchestrator configures them at startup with concrete implementations. This follows the same pattern as ratchet and auto-iteration bridges, and prevents service capsules from importing each other.

### 4. Server Lifecycle

`src/backend/server.ts` starts `periodicTaskService` as part of the server launch sequence (after bridges are wired) and stops it on shutdown.

### 5. tRPC Router

`src/backend/trpc/periodic-task.trpc.ts` mounted at `periodicTask.*`:

| Procedure | Description |
|-----------|-------------|
| `list` | List all tasks for a project (includes last 5 executions each) |
| `get` | Get single task with last 20 executions |
| `create` | Create task (`nextRunAt = now` → immediate first run) |
| `update` | Edit name, prompt, cadence |
| `delete` | Delete task + cascade executions |
| `toggleEnabled` | Enable/disable (re-enable resets `nextRunAt = now + cadence`) |
| `listExecutions` | Execution history for a task (up to 100, default 20) |
| `listExecutionsByPeriodicTaskId` | Full history up to 50, used by workspace right panel |

### 6. UI Changes

#### A. Kanban Inline Workspace Form

`src/client/components/kanban/inline-workspace-form.tsx` gains a mode selector:

```
[ New Workspace | Create Periodic Task ]
```

In "Create Periodic Task" mode, a cadence picker (`Daily / Weekly / Monthly`) appears below the prompt textarea. Submitting calls `periodicTask.create` and invalidates the `periodicTask.list` query.

#### B. Settings → "Periodic Tasks" Tab

`src/client/routes/admin-page.tsx` adds a third tab. Contents:
- Per-project table of all periodic tasks
- Columns: Name, Prompt (truncated), Cadence, Enabled toggle, Last Run, Next Run, Actions (Edit / Delete)
- Row expansion: last 5 executions with status badge, PR link, timestamps
- Inline edit via the same form fields

#### C. Workspace Right Panel — "Periodic Task" Tab

`src/components/workspace/periodic-task-panel.tsx` added as a new tab in `src/components/workspace/right-panel.tsx`. Visible only when the workspace was created by a periodic task (`creationSource === PERIODIC_TASK`). Shows full execution history for that task (up to 50 entries).

---

## Key Decisions

### D1: Internal polling loop over node-cron or Inngest

**Decision:** Use the same interruptible-sleep polling loop pattern already established by `RatchetService` and `SchedulerService`.

**Rationale:**
- Daily/weekly/monthly granularity does not require sub-minute precision.
- The pattern is already tested and carries graceful shutdown behaviour.
- No new runtime dependency; works in self-hosted environments without external services.
- `node-cron` would require re-registering in-memory jobs from DB on every restart. Inngest would require Inngest infrastructure.

### D2: `nextRunAt` advanced at dispatch time, not on completion

**Decision:** `nextRunAt` is written to `now + cadence` the moment a workspace is dispatched, not when it finishes.

**Rationale:** Prevents schedule drift if the agent run takes longer than the cadence (e.g. a slow weekly run that takes 2 hours). The next cadence window starts from dispatch, not completion.

**Trade-off:** If a task fails it does not retry until the next cadence window. No immediate retry on failure (see Open Questions).

### D3: Concurrent execution guard via `hasRunningExecution`

**Decision:** Before dispatching a due task, check if a `RUNNING` execution already exists. If so, skip this dispatch cycle.

**Rationale:** Prevents task pile-up if a run takes longer than the poll interval. Simple and deterministic — no complex locking needed since the polling loop is single-threaded.

### D4: Bridge pattern for cross-service calls

**Decision:** `PeriodicTaskService` does not import workspace or session services. It declares bridge interfaces and receives concrete implementations from the orchestration layer at startup.

**Rationale:** Consistent with the established capsule/bridge architecture. Capsules declare what they need; the orchestrator wires dependencies. This avoids circular imports and makes the service independently testable.

### D5: Workspace name auto-formatted with date

**Decision:** Created workspaces are named `"<task name> — <toLocaleDateString()>"`.

**Rationale:** Makes it easy to identify periodic runs in the Kanban board and workspace list without extra UI surface.

### D6: First run fires immediately on creation

**Decision:** `nextRunAt` is set to `now()` on `PeriodicTask` creation, so the first execution happens within the next 60-second poll cycle.

**Rationale:** User feedback — a task that runs for the first time tomorrow feels broken. Running immediately validates the prompt and provides immediate feedback.

---

## Execution Lifecycle

```
User creates task (cadence = DAILY)
       │
       ▼
PeriodicTask created, nextRunAt = now()
       │
       ▼ (within 60s)
pollDueTasks() fires
       │
       ├─ hasRunningExecution? → No
       ├─ workspaceBridge.createWorkspaceForTask(...)  → workspaceId
       ├─ createExecution(status=RUNNING, workspaceId)
       └─ markDispatched → nextRunAt = now + 1 day

Agent runs in workspace...
       │
checkRunningExecutions() fires every 60s:
       │
       ├─ ws.prUrl present
       │    → updateExecution(status=PR_CREATED, prUrl, prNumber, completedAt)
       │
       └─ ws.status === FAILED | ARCHIVED
            → updateExecution(status=FAILED, errorMessage, completedAt)
            → nextRunAt already set; task retries tomorrow
```

---

## Files Changed

### New
| File | Purpose |
|------|---------|
| `prisma/migrations/20260512204732_add_periodic_tasks/migration.sql` | DB migration |
| `src/backend/services/periodic-task/index.ts` | Barrel — sole public API |
| `src/backend/services/periodic-task/resources/periodic-task.accessor.ts` | Prisma CRUD + `computeNextRunAt` |
| `src/backend/services/periodic-task/service/periodic-task.service.ts` | Polling loop + bridge interfaces |
| `src/backend/trpc/periodic-task.trpc.ts` | tRPC router |
| `src/components/workspace/periodic-task-panel.tsx` | Workspace right panel tab |

### Modified
| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `PeriodicTask`, `PeriodicTaskExecution`, `Cadence`, `PeriodicTaskExecutionStatus` enums |
| `src/shared/core/enums.ts` | Add `PERIODIC_TASK` to `WorkspaceCreationSource`; add `PeriodicTaskCadence`, `PeriodicTaskExecutionStatus` |
| `src/backend/services/registry.ts` | Register capsule + model ownership |
| `src/backend/trpc/index.ts` | Mount `periodicTaskRouter` |
| `src/backend/server.ts` | Start/stop `periodicTaskService` in lifecycle |
| `src/backend/services/constants.ts` | Add `periodicTaskPoll` interval (60s) |
| `src/backend/orchestration/domain-bridges.orchestrator.ts` | Wire workspace and status bridges |
| `src/client/routes/admin-page.tsx` | Add "Periodic Tasks" tab |
| `src/client/components/kanban/inline-workspace-form.tsx` | Add mode selector + cadence picker |
| `src/components/workspace/right-panel.tsx` | Add "Periodic Task" tab |

---

## Open Questions

1. **Immediate retry on failure?** Currently a failed run waits for the next cadence window. Should there be a short-circuit retry (e.g. 15 min) when a workspace fails without producing a PR? The current design makes failure visible in execution history but does not attempt recovery until the next scheduled window.

2. **Execution timeout / stale RUNNING detection?** A `RUNNING` execution can block a task indefinitely if the workspace is abandoned without transitioning to `FAILED` or `ARCHIVED`. Should there be a max age (e.g. 24h) after which a `RUNNING` execution is automatically marked `FAILED`?

3. **`toLocaleDateString()` in workspace names is locale-dependent.** Different server locales will produce different workspace name formats. Should this be normalized to ISO date (`YYYY-MM-DD`) for consistency?

4. **Re-enable resets `nextRunAt` to `now + cadence` (not `now`).** This means a just-re-enabled task won't run until the next cadence window. Is the expected UX that re-enabling fires a run immediately (like creation does)?

5. **No per-task timezone support.** All scheduling is based on UTC server time. A task set to "daily" will run at whatever UTC time the server processes it, which may not align with the user's business day.

6. **No notifications on repeated failures.** If a periodic task fails every run for a week, nothing alerts the user besides the execution history table. Should there be a failure threshold after which the task auto-disables or sends a notification?

7. **`SKIPPED` status is defined in the enum but never written.** The design doc mentions it as an option, but the current implementation skips silently (logs a debug message, moves on). Should `SKIPPED` executions be recorded so the history reflects every cycle?

8. **Kanban column visibility.** Workspaces created by periodic tasks appear in the WORKING column. When many periodic tasks run simultaneously, the Kanban board could become crowded. Should periodic task workspaces be surfaced differently (e.g. grouped, or hidden by default)?

---

## Out of Scope (for now)
- Sub-daily granularity (hourly, every N minutes)
- Task dependencies / chaining
- Per-workspace periodic tasks (these are project-scoped)
- Timezone-aware scheduling
- Email/Slack notifications on failure
