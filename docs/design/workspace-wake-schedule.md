# Workspace Wake Schedule — Design Document

Status: implemented

## The Issue

Users want recurring agent check-ins — "check the error logs every hour and
propose a fix" — set up from inside the chat, by the agent itself, with each run
resuming the **same workspace and session** so context carries over between
runs.

Nothing in the codebase provided this:

- **Periodic Tasks** (`src/backend/services/periodic-task/`) runs on a cadence
  but spawns a **fresh workspace per run** (no continuity) and is configurable
  only from the Admin UI / Kanban dropdown (not agent-callable).
- The **MCP tools** exposed to agents (`spawn_child_workspace` etc.) include
  nothing for scheduling.
- The only code that delivers a message to another workspace's session
  (`deliverWorkspaceNotification`) targets `RUNNING`/`IDLE` sessions only and
  gives up otherwise — correct for a live ping, useless for a wake-up, whose
  whole premise is that the session is dormant.

## The Fix

A new **wake schedule**: one per workspace, set by the agent on itself via MCP
tools, executed by a poll loop that resumes the workspace's own session with a
stored prompt. Periodic Tasks is untouched except for sharing cadence math.

- `WorkspaceWakeSchedule` — new 1:1 workspace side table.
- `workspace-wake` — new service capsule with a `jobRunner` poll loop
  (`workspace-wake-poll`, 60s).
- `deliverWorkspaceWake` — new orchestrator that resumes a dormant session.
- `set_wake_schedule` / `get_wake_schedule` / `clear_wake_schedule` — new MCP
  tools in every session, scoped to the current workspace only.

---

## Architecture

### Data model

```prisma
model WorkspaceWakeSchedule {
  workspaceId String    @id
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  enabled             Boolean             @default(true)
  cadence             PeriodicTaskCadence // reused enum; EVERY_HOUR added for this feature
  prompt              String              // sent as a new turn on wake
  scheduledTime       String?             // HH:MM, for DAILY/WEEKLY/MONTHLY
  timezone            String?             // IANA timezone
  scheduledDayOfMonth Int?

  nextWakeAt  DateTime?
  lastWakeAt  DateTime?
  lastOutcome String? // 'DELIVERED' | 'FAILED' | 'SKIPPED_NO_SESSION'
  lastError   String?

  @@index([nextWakeAt])
}
```

Owned by the `workspace` capsule like the other side tables, but — unlike
`WorkspaceRatchet`/`WorkspaceAutoIteration` — created lazily: most workspaces
never set a schedule, so "no row" reads as "no schedule". Three display fields
(`wakeScheduleEnabled`/`Cadence`/`NextWakeAt`) are flattened onto workspace
reads for the kanban badge and right-panel tab.

The cadence math (timezone-aware next-run computation) was extracted from
`periodic-task.accessor.ts` into `src/backend/lib/cadence-schedule.ts`, shared
by both features.

### Poll loop

`WorkspaceWakeService` follows the `auto-iteration` capsule shape: owns no
models, `dependsOn: []`, and reaches the schedule row and the session layer
through two bridges wired in `domain-bridges.orchestrator.ts`.

```
runCycle():                       // every 60s, jobRunner-paced
  for schedule in findDue():      // enabled, nextWakeAt<=now, workspace not ARCHIVED/ARCHIVING
    markDispatched(schedule)      // atomic claim; also advances nextWakeAt
    void deliver(workspaceId, prompt)   // detached — see decisions
      → recordOutcome(DELIVERED | SKIPPED_NO_SESSION | FAILED)
```

### Wake delivery

`deliverWorkspaceWake(workspaceId, prompt)` picks the workspace's most recently
updated session — **any status** — then uses the normal chat path:
`sessionDomainService.enqueue` +
`chatMessageHandlerService.tryDispatchNextMessage`. That dispatch call's
existing auto-start path (`autoStartClientForQueue` →
`getOrCreateSessionClient`) is what resumes a `STOPPED` session's ACP client; a
busy session just keeps the message queued until idle. No new session-starting
code was needed — this orchestrator is the only genuinely new wiring in the
feature.

### Tool surface

MCP server `workspace-wake-mcp-server.ts` (a second entry in every session's
`mcpServers` list, beside the child-workspace server), calling the new
`workspaceWake.get/set/clear` tRPC router over HTTP. `set_wake_schedule`
replaces any existing schedule — one per workspace — and its description carries
the permission caveat below. The HTTP helpers were extracted from the
child-workspace server into a shared `mcp-trpc-client.ts`.

---

## Key Decisions

1. **Separate feature, not a Periodic Tasks mode.** Different ownership model
   (one schedule per workspace vs. one task spawning many workspaces) and no
   PR-tracking state machine needed; only the cadence math is genuinely shared,
   so only that was shared.
2. **Target any session status.** Filtering to `RUNNING`/`IDLE` (as notification
   delivery does) would make the feature work only on workspaces that didn't
   need waking.
3. **Fire-and-forget delivery.** A resumed turn can run for hours; awaiting it
   inside the poll cycle would starve every other due workspace, since
   `jobRunner` never overlaps a job's runs.
4. **Advance `nextWakeAt` at dispatch, atomically.** Same drift-prevention and
   double-dispatch guard as Periodic Tasks (`updateMany` conditioned on the old
   `nextWakeAt`).
5. **No automatic permission change.** The woken turn runs under the session's
   existing permission preset. If that isn't auto-approving (YOLO), tool
   approvals stall with nobody present. Forcing a trust change silently is the
   user's call, not the feature's — the caveat is surfaced in the tool
   description instead.

---

## Lifecycle

```
set_wake_schedule(EVERY_HOUR, "Check the logs")
  → row upserted, nextWakeAt = now + 1h
  → (poll fires ≤60s after nextWakeAt)
      claim + advance nextWakeAt
      resume most recent session, enqueue prompt
        STOPPED      → auto-start, then deliver
        RUNNING idle → deliver now
        RUNNING busy → queued for next idle
  → recordOutcome
```

Key files: `src/backend/services/workspace-wake/`,
`src/backend/services/workspace/resources/workspace-wake-schedule.accessor.ts`,
`src/backend/orchestration/workspace-wake-delivery.orchestrator.ts`,
`src/backend/services/session/service/acp/workspace-wake-mcp-server.ts`,
`src/backend/trpc/workspace-wake.trpc.ts`, migration
`20261001131912_add_workspace_wake_schedule`.

---

## Resolved since first draft

- **Visibility**: the schedule's display fields
  (`wakeScheduleEnabled`/`Cadence`/`NextWakeAt`) are now flattened onto
  workspace reads, feeding a kanban-card badge ("Wakes every hour") and a
  read-only "Wake Schedule" right-panel tab with a cancel action.
- **Permission warning**: `workspaceWake.set` now returns a `permissionWarning`
  when the default workspace preset isn't YOLO, and the MCP tool surfaces it so
  the agent relays it at scheduling time.

## Open Questions

1. **No execution history** — only `lastOutcome`/`lastError`. Enough for
   debugging missed wakes?
2. **Archived workspaces keep their row** — excluded from polling (archiving
   stops wakes), but the schedule lingers until the workspace is deleted. Worth
   cleaning up on archive?
3. **Fixed cadence enum only** — no custom intervals (e.g. every 20 min).

Out of scope for now: schedule editing from the UI (view/cancel only), execution
history, cross-workspace scheduling, automatic permission adjustment, custom
intervals.
