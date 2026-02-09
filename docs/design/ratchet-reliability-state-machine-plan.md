# Ratchet Reliability Design: Global Heartbeat Dispatcher Model

## Status

Draft for implementation planning. Phase 0 (session exit hook) shipped in #760.

## Core Model

The ratchet uses one global GitHub heartbeat loop that discovers workspace deltas, then dispatches per-workspace handling. `ratchetWorkspace(workspaceId, githubDelta)` is a single-pass function that performs at most one action.

```
while (true) {
  await sleep(heartbeatInterval);
  const changed = await collectWorkspaceGithubDeltas(); // head/CI/review/mergeability/toggle deltas

  // Sequential dispatch: processes one workspace at a time. Since ratchetWorkspace
  // awaits fixer completion, this means workspace B waits while A's fixer runs.
  // Acceptable for initial implementation; parallel dispatch is a planned fast-follow.
  for (const workspaceDelta of changed) {
    await ratchetWorkspace(workspaceDelta.workspaceId, workspaceDelta);
  }
}
```

```
async function ratchetWorkspace(workspaceId, githubDelta) {
  // Cleanup: idempotent teardown of any leftover ratchet fixer sessions.
  // Safe to call when no fixer exists (no-op). Runs under single-flight lock,
  // so it cannot interfere with a waitForCompletion() from the current iteration.
  await clearRatchetSessions(workspaceId);

  // Eligibility guards — these are owned by ratchetWorkspace, NOT by
  // determineFixupAction. They decide whether we should evaluate this
  // workspace at all this tick.
  if (hasAnyWorkingSession(workspaceId)) {
    // IMPORTANT: only update UI status fields here. Do NOT update last-known
    // GitHub markers (head SHA, CI run ID, review state, etc.) so the delta
    // is preserved and re-detected on the next tick after the session ends.
    await setUiPauseStatus('PAUSED_USER_WORKING');
    return;
  }
  if (notHasPr(workspaceId)) {
    // Defensive: in practice, workspaces without PRs produce no GitHub deltas
    // and would not appear in the changed set. Kept as a safety check.
    await setPauseState('PAUSED_NO_PR');
    return;
  }
  if (!prIsOpen(workspaceId)) {
    await setPauseState('PAUSED_PR_NOT_OPEN');
    return;
  }
  if (!ratchetEnabled(workspaceId)) {
    await setPauseState('PAUSED_DISABLED');
    return;
  }
  if (tooManyFixupAttempts(workspaceId)) {
    await setPauseState('PAUSED_ATTENTION_TERMINAL_FAILED');
    return;
  }

  // Optimization: do not dispatch fixups while CI is in progress.
  if (githubDelta.ci.isInProgress) {
    await setPauseState('WAITING_FOR_CI');
    return;
  }

  // Action determination — determineFixupAction is a pure function that
  // decides what to do given the workspace has passed eligibility.
  const action = determineFixupAction(githubDelta, workspaceSnapshot);
  await executeRatchetAction(workspaceId, action, githubDelta);
}
```

`setPauseState(...)` is used for side effects (persisting/UI status + logging metadata). Its return value is not used; `return` only exits `ratchetWorkspace` early after writing state.

```
async function executeRatchetAction(workspaceId, action, githubDelta) {
  if (action.action === 'WAIT') {
    await setPauseState(workspaceId, 'WAITING_FOR_CI', action.reason);
    await appendTransitionLog(workspaceId, { action: 'WAIT', reason: action.reason, snapshot: githubDelta });
    return;
  }

  if (action.action === 'PAUSE') {
    await setPauseState(workspaceId, action.pauseState, action.reason);
    await appendTransitionLog(workspaceId, { action: 'PAUSE', reason: action.reason, snapshot: githubDelta });
    return;
  }

  if (action.action === 'NOOP') {
    await appendTransitionLog(workspaceId, { action: 'NOOP', reason: action.reason, snapshot: githubDelta });
    return;
  }

  // FIX_CI / FIX_REVIEW: dispatch one fixer run and await completion.
  const preFixerHeadSha = await getWorkspaceHeadSha(workspaceId);
  const preCiRunId = githubDelta.ci.runId ?? null;
  await setLastCiRunId(workspaceId, preCiRunId);
  await setStaleCiSince(workspaceId, now());
  await appendTransitionLog(workspaceId, {
    action: action.action,
    reason: action.reason,
    snapshot: githubDelta,
  });

  const sessionId = await acquireAndDispatchFixer(workspaceId, action);
  await waitForCompletion(sessionId);

  const didPush = await detectDidPush(workspaceId, preFixerHeadSha); // YES | NO | UNKNOWN
  if (didPush === 'UNKNOWN') {
    await scheduleRetryWithBackoff(workspaceId, 'PUSH_STATUS_UNKNOWN');
    await appendTransitionLog(workspaceId, { action: 'WAIT', reason: 'PUSH_STATUS_UNKNOWN' });
    return;
  }

  if (didPush === 'NO') {
    await setPauseState(workspaceId, 'PAUSED_ATTENTION_NO_PUSH', 'Fixer exited without push');
    await appendTransitionLog(workspaceId, { action: 'PAUSE', reason: 'PAUSED_ATTENTION_NO_PUSH' });
    return;
  }

  await incrementFixupAttempts(workspaceId);
  await clearRetrySchedule(workspaceId);
}
```

Key properties:
- **Global coordinator:** A single heartbeat decides which workspaces need processing.
- **Delta-triggered processing:** `ratchetWorkspace` is called only for workspaces with relevant state changes (or scheduled retries).
- **One thing at a time per workspace:** `ratchetWorkspace` is single-flight keyed by `workspaceId`.
- **Synchronous fixup execution:** dispatch waits for fixer completion; no concurrent fixer orchestration per workspace.
- **CI-in-progress optimization:** heartbeat can ignore CI-in-progress workspaces for fixup dispatch decisions, while still updating UI status.
- **Broad triggers, not only CI:** CI terminal-state change is primary, but push/comment/review/mergeability/toggle deltas also trigger processing.
- **Agent-owned branch sync:** ratchet agents are instructed to sync with `main` as needed while handling `FIX_CI`/`FIX_REVIEW`; orchestrator does not implement merge-main special cases.

## Why This Exists

The current ratchet loop has two reliability issues:

1. Active fixer linkage (`ratchetActiveSessionId`) was not cleaned up on session exit; stale references persisted until the next poll detected them. (**Fixed in Phase 0, #760.**)
2. After a fixup pushes a fix, the next poll can see stale CI state (old failure, new run hasn't registered yet) and incorrectly launch another fixup for the same issue.

This document defines a plan to fix issue 2 and simplify ratchet around a global heartbeat + per-workspace dispatcher.

## Design Goals

1. Simple global heartbeat + single-pass per-workspace actioning.
2. At most one action per workspace at a time.
3. No duplicate fixup launches for the same issue.
4. Stop retrying after repeated attempts (`PAUSED_ATTENTION_TERMINAL_FAILED`).
5. Observable — a transition log explains every ratchet decision.
6. PR-local trigger discipline: changes external to a workspace PR do not, by themselves, trigger ratchet fixer work.

## Trigger Principle

Ratchet dispatch is driven by changes intrinsic to the workspace PR. External repository changes (including unrelated merges to `main`) must not, by themselves, trigger fixer work for that workspace.

Implications:

1. Conflict-only mergeability changes caused by external `main` movement set status (`PAUSED_WAIT_CONFLICT_ONLY`) but do not dispatch fixers.
2. `main` is merged into a workspace branch only when ratchet is already handling a PR-local actionable issue (`FIX_CI` or `FIX_REVIEW`).
3. Dispatch triggers remain PR-local: head SHA changes on the workspace branch, CI terminal changes for that PR branch, review/comment changes on that PR, mergeability policy changes on that PR, and ratchet toggle changes.

## Non-Goals

1. Replacing polling with webhooks.
2. Implementing auto-merge behavior.
3. Reworking workspace lifecycle state machine (`NEW/PROVISIONING/READY/...`).
4. Multi-instance backend support (leases, CAS versioning, distributed heartbeats). The current runtime is single-process SQLite.

## State Determination

Once a workspace passes the eligibility guards in `ratchetWorkspace` (working session, PR existence/open state, ratchet toggle, attempt budget, CI-in-progress), action determination derives the next action from fresh GitHub state + local workspace metadata. This is a pure function — no side effects, no network calls, no database writes:

```
determineFixupAction(githubDelta, workspaceSnapshot) ->
  | { action: 'WAIT', reason: string }
  | { action: 'PAUSE', pauseState: string, reason: string }
  | { action: 'FIX_CI', reason: string }
  | { action: 'FIX_REVIEW', reason: string }
  | { action: 'NOOP', reason: string }
```

Guard evaluation order (assumes eligibility guards in `ratchetWorkspace` already passed):

1. **Stale CI run** (run ID unchanged since last dispatch and stale timeout not reached) → `WAIT`
2. **Stale CI timeout reached** (run ID unchanged since last dispatch and timeout exceeded) → `PAUSE(PAUSED_ATTENTION_STALE_CI_TIMEOUT)` (manual attention required; audit as `STALE_CI_TIMEOUT`)
3. **Merge conflict only** (no CI failure, no actionable review comments) → `PAUSE(PAUSED_WAIT_CONFLICT_ONLY)`
4. **CI failed** → `FIX_CI`
5. **Review comments** → `FIX_REVIEW`
6. **Merge blocked on human review** → `PAUSE(PAUSED_WAIT_HUMAN_REVIEW)`
7. **All green** → `PAUSE(PAUSED_DONE)`
8. **No actionable change** (delta arrived but re-evaluation found nothing changed) → `NOOP`

Note: eligibility guards (no PR, PR not open, ratchet disabled, attempt budget exceeded, CI in progress, working user session) are handled by `ratchetWorkspace` before `determineFixupAction` is called. They are not duplicated here. See the `ratchetWorkspace` pseudocode for the full guard order.

### Heartbeat Delta Detection

The heartbeat dispatches `ratchetWorkspace` only when relevant PR-local deltas are observed:

1. Branch head SHA changed.
2. CI status changed to a terminal state (failed/cancelled/success), or stale CI timeout criteria changed.
3. Review/comment state changed (new comments, changes requested, review resolved).
4. Mergeability changed for the PR itself (including blocked/unblocked due to required human review).
5. Ratchet toggle changed.

CI-in-progress updates can be skipped for dispatch as an optimization, but should still refresh UI status.

Conflict-only mergeability deltas should not trigger fixer dispatch by themselves. They update UI status (`PAUSED_WAIT_CONFLICT_ONLY`) and wait for another PR-local actionable trigger.

When conflict-only deltas are filtered from dispatch, the heartbeat must still write the pause status (`PAUSED_WAIT_CONFLICT_ONLY`) and transition log directly.

Important: delta detection must include updates to existing PR artifacts (for example edited review comments), not just newly created comments/reviews/check runs.

**Paused workspaces remain candidates:** Workspaces in any pause state (including `PAUSED_DONE`) stay in the heartbeat's candidate set and are re-dispatched when new deltas appear (new comments, CI re-runs, head SHA changes, etc.). Pause states are notification/auditing markers, not exclusion criteria for delta detection. A workspace only leaves the candidate set when it is archived or its PR is closed/merged.

### No-Push Detection

After each fixup session completes, the ratchet checks whether the fixer agent pushed. Implementation: capture `preFixerHeadSha` immediately before fixer dispatch, then compare to branch HEAD after session completion.

- **Agent didn't push:** Ratchet moves to attention pause (`PAUSED_ATTENTION_NO_PUSH`). No state changed on the remote, so repeating the same fixup immediately is not useful. The workspace surfaces as needing manual attention.
- **Agent pushed:** Increment attempt counter and rely on heartbeat CI/review deltas for follow-up processing.

### Dispatch Safety

`ratchetWorkspace` must run under single-flight per workspace (`workspaceId` lock). If a new delta arrives while a run is in progress, enqueue/coalesce and run one more pass after completion.

### Terminal Attempt Pause (`PAUSED_ATTENTION_TERMINAL_FAILED`)

**Entry:** `consecutiveAttempts >= 3` when a fixup action would otherwise be taken. The no-push case enters attention pause immediately without incrementing the counter.

**Counter increment:** Increment after each ratchet fixup session that pushed, regardless of issue category. This is a global "the agent is struggling with this PR" budget, not a per-category counter. For example: attempt 1 = FIX_CI, attempt 2 = FIX_REVIEW, attempt 3 = FIX_CI again → terminal. This is intentional — if three pushes haven't resolved the PR, the workspace needs human attention regardless of which issues were addressed.

**Counter reset:** Resets to 0 when:
- A new push is detected from outside the ratchet (`ratchetLastPushAt` changes without a ratchet fixup preceding it), indicating manual intervention.
- The ratchet toggle is disabled and re-enabled.
- The workspace reaches `PAUSED_DONE` (green CI, no merge conflict, no review comments).

**Behavior:** `ratchetWorkspace` sets `PAUSED_ATTENTION_TERMINAL_FAILED`; future heartbeat ticks skip fixup dispatch until external intervention changes inputs.

### Blocked Merge Handling

If CI is green and there are no actionable review comments, but merge is blocked by human-review policy (for example required approval missing), ratchet does not launch fixers and stays in a waiting state (`PAUSED_WAIT_HUMAN_REVIEW`) until mergeability changes.

### Conflict-Only Strategy

To avoid thundering-herd conflict churn:

1. Ratchet does not run standalone "resolve merge conflict" fixer sessions for conflict-only workspaces.
2. Conflict-only workspaces remain in `PAUSED_WAIT_CONFLICT_ONLY`.
3. Conflict resolution is handled opportunistically by ratchet agents during other actionable runs (`FIX_CI` / `FIX_REVIEW`) based on agent instructions.
4. This avoids fan-out updates triggered only by external `main` movement.

### Stale CI Detection

After a fixup pushes, the push should trigger a new CI run. But there's a delay before GitHub registers the new run. During this window, the poller would see the old failed CI run and incorrectly launch another fixup.

**Fix:** Before launching a fixup, record the current CI run ID (`ratchetLastCiRunId`) and stale wait start time (`ratchetStaleCiSince`). On subsequent heartbeat ticks, `hasStaleCiRun()` compares the current CI run ID to the recorded one. If they match, CI hasn't restarted yet — wait until timeout. Once a new run starts, the ID changes and the stale check passes.

**Timeout:** If run ID remains unchanged for longer than the stale timeout window (for example 5 minutes), pause with `PAUSED_ATTENTION_STALE_CI_TIMEOUT` and audit log `STALE_CI_TIMEOUT` so manual action can unblock CI.

This uses the existing `ratchetLastCiRunId` field, which the current code already tracks.

**Reset:** `ratchetStaleCiSince` is cleared when a new CI run ID is detected (i.e., `currentRunId !== ratchetLastCiRunId`). At that point the stale window is no longer relevant — CI has restarted and the heartbeat evaluates fresh CI state normally. It is also cleared when the workspace enters any non-stale pause state (e.g., `PAUSED_DONE`, `PAUSED_DISABLED`) to avoid spurious timeouts on subsequent re-entry.

## Persistence Changes

### Workspace Model Additions

Add to `Workspace`:

1. `ratchetConsecutiveFixupAttempts Int @default(0)` — counter for terminal attempt pause entry
2. `ratchetStaleCiSince DateTime?` — when stale CI waiting started for timeout enforcement
3. `ratchetStateReason String?` — short reason code for current UI-visible ratchet status
4. `ratchetStateUpdatedAt DateTime?` — last time UI-visible ratchet status changed
5. `ratchetCurrentActivity String?` — user-facing current action summary (`FIXING_BUILD`, `FIXING_REVIEW_COMMENTS`, `WAITING_FOR_CI`, etc.)

Existing fields used as-is:
- `ratchetState` — updated each poll to reflect current PR state
- `ratchetActiveSessionId` — set when fixup launches, cleared by `clearRatchetSessions()` at the start of each action phase and on session exit (Phase 0)
- `ratchetLastCiRunId` — recorded before fixup launch for stale CI detection
- `ratchetLastCheckedAt` — updated each poll cycle
- `ratchetLastPushAt` — used for manual intervention detection

Fields no longer needed (candidates for removal in cleanup):
- `ratchetLastNotifiedState` — was used to avoid duplicate notifications to active fixers. With synchronous fixups, there is no mid-flight notification; each iteration either waits or launches a fresh session.

No new enums. `RatchetTransitionLog` is required.

### RatchetTransitionLog Table

For observability, add a mandatory append-only log:

1. `id String @id @default(cuid())`
2. `workspaceId String`
3. `action String` — the action taken (`WAIT`, `FIX_CI`, `FIX_REVIEW`, `PAUSE`, `NOOP`)
4. `reason String` — human-readable explanation
5. `uiMessage String?` — concise user-facing text (`Fixing build failures`, `Addressing PR review comments`, `Waiting for CI to restart`)
6. `snapshot Json?` — decision-relevant fields (CI status, merge state, review state)
7. `createdAt DateTime @default(now())`

Index: `(workspaceId, createdAt)`.

**Retention:** Prune entries older than 7 days on server startup and via a daily timer.

## Service Architecture Changes

### Action Determination Service (New)

Create `src/backend/services/ratchet-action.service.ts`:

1. Pure function `determineFixupAction(...)` as described above.
2. Exhaustive unit tests for every guard combination.
3. No network calls, no side effects, no database access.

### Ratchet Service Refactor

Refactor `ratchet.service.ts` into heartbeat + dispatcher:

1. **Global heartbeat tick:** Enumerate candidate workspaces and fetch GitHub snapshots.
2. **Compute deltas:** Compare snapshot with last-known workspace markers (head SHA, CI state/run ID, review state, mergeability, ratchet toggle).
3. **Filter for work:** Dispatch only changed workspaces (plus retry-scheduled workspaces), excluding merge-conflict-only deltas from fixer dispatch.
4. **Per-workspace single-flight:** `ratchetWorkspace(workspaceId, githubDelta)` runs under lock.
5. **Action determination:** Call `determineFixupAction(githubDelta, workspaceSnapshot)`.
6. **Execute one action:** launch fixer and await completion for `FIX_CI`/`FIX_REVIEW`; handle `didPush` tri-state; update counters/states.
7. **Audit log:** Write structured transition log entry for every wait, dispatch, pause transition, and terminal attention state.
8. **Conflict-only status path:** when a workspace is filtered due to conflict-only delta, write `PAUSED_WAIT_CONFLICT_ONLY` status + transition log without dispatching a fixer.

### Heartbeat Implementation Shape (Explicit)

Implement one global long-lived task and one per-workspace single-pass handler.

1. `runGithubHeartbeat(signal): Promise<void>` contains `while (!signal.aborted)` and runs on fixed cadence.
2. `collectWorkspaceGithubDeltas()` gathers current GitHub snapshots and computes workspace deltas.
3. `ratchetWorkspace(workspaceId, githubDelta)` is idempotent and performs at most one action.
4. Maintain `Map<workspaceId, Promise<void>>` (or equivalent) single-flight guard.
5. If a delta arrives while a workspace is in-flight, coalesce and run one follow-up pass.

### Working Session Definition (Explicit)

`hasAnyWorkingSession()` must use the same semantics as `fixerSessionService.isSessionWorking()` to avoid drift.

Definition for this design:

1. A session is **working** when `isSessionWorking(session)` is true (active execution state).
2. A session that is `RUNNING` but waiting for user input/idle is **not** working and must not block ratchet.
3. Ratchet must call one canonical helper for this decision (do not duplicate ad-hoc status checks in ratchet service).
4. Add tests that pin this behavior so future session-state refactors do not accidentally change ratchet blocking behavior.

### User Session Delta Preservation

The `PAUSED_USER_WORKING` guard must not consume GitHub deltas. If a user is chatting while CI reaches a terminal failure, and the guard updates last-known GitHub markers alongside the UI status, the CI-failed delta is consumed. When the user session ends, the next heartbeat sees no new delta and the workspace silently stops ratcheting.

**Rule:** The `PAUSED_USER_WORKING` early exit writes only UI status fields (`ratchetState`, `ratchetStateReason`, `ratchetCurrentActivity`, `ratchetStateUpdatedAt`). It does **not** update last-known GitHub markers (head SHA, CI run ID, review state, mergeability). This preserves the unconsumed delta for the next tick.

**Belt-and-suspenders:** When any user session exits on a workspace with `ratchetEnabled = true`, add that workspace to a "force re-evaluate" set in the heartbeat. The next heartbeat tick dispatches `ratchetWorkspace` for force-re-evaluate workspaces regardless of whether `collectWorkspaceGithubDeltas()` detected a delta. This ensures no state is dropped even if markers are accidentally stale.

Implementation: the session `onExit` hook (already used for `ratchetActiveSessionId` cleanup) checks `workspace.ratchetEnabled` and, if true, calls `heartbeat.scheduleReEvaluation(workspaceId)`. The heartbeat merges this set into its dispatch list on the next tick.

### `didPush` Recovery Semantics

`didPush()` should return a tri-state result:

1. `YES` — push confirmed.
2. `NO` — no push confirmed.
3. `UNKNOWN` — transient verification failure (for example GitHub API unavailable or timeout).

On `UNKNOWN`, ratchet should not mark no-push or terminal; it should schedule retry with backoff.

### Awaiting Session Completion

The key change: instead of fire-and-forget, the ratchet awaits the fixup session. Implementation options:

1. **Poll session status** — after launching, poll `session.status` every few seconds until it's `COMPLETED`. Simple but adds polling overhead.
2. **Session exit callback** — register a callback on session exit that resolves a promise. The ratchet `await`s this promise. Cleaner, leverages the existing `onExit` hook.

Option 2 is preferred. The `onExit` hook (from Phase 0) already fires on session exit — we just need it to resolve a promise that the ratchet is awaiting.

### Changes to Existing Services

1. **`session.service.ts`** — No additional changes beyond Phase 0. The `onExit` hook already clears `ratchetActiveSessionId`.
2. **`fixer-session.service.ts`** — Existing `acquireAndDispatch()` returns the session ID. Add a `waitForCompletion(sessionId)` method that returns a promise resolved by the session exit hook. Add `clearWorkspaceRatchetSessions(workspaceId)` to terminate and clean up leftover ratchet fixer sessions.
3. **`workspace.accessor.ts`** — Add method to increment/reset `ratchetConsecutiveFixupAttempts` and manage stale CI timeout fields.
4. **Status writer:** central helper to update `ratchetState`, `ratchetStateReason`, `ratchetStateUpdatedAt`, and `ratchetCurrentActivity` together to keep UI status coherent.

### UI Observability Contract

Expose ratchet progress without using ratchet state as orchestration truth.

1. Keep `ratchetState` as a display status only.
2. Use `ratchetStateReason` for stable reason codes suitable for UI badges/tooltips.
3. Use `ratchetCurrentActivity` for explicit current-action messaging:
   - `Updating branch from main`
   - `Fixing build failures`
   - `Addressing PR review comments`
   - `Waiting for CI to restart`
   - `Waiting for active workspace session to finish`
   - `Waiting for human review approval`
   - `Waiting for non-conflict trigger to update branch`
4. Update these fields at every major transition (wait, dispatch, completion, pause, terminal attention).
5. Keep `RatchetTransitionLog` as the detailed timeline.
6. Add/extend API endpoints for UI:
   - `currentRatchetStatus(workspaceId)` → current status snapshot (`state`, `reason`, `currentActivity`, `updatedAt`, counters)
   - `ratchetTransitions(workspaceId, limit)` → recent timeline entries (`action`, `reason`, `uiMessage`, `createdAt`)
7. Add an outcome/attention indicator in status payload (for example `outcomeKind: SUCCESS | ATTENTION`) so UI can visually separate clean exits from error/manual-attention exits.
8. While a ratchet run is in-flight for a workspace, workspace should present in Kanban `WORKING` column.
9. Ratchet eligibility scanning should include all non-archived workspaces with open PRs regardless of current Kanban column, so `WAITING` work can move back to `WORKING` when new comments/pushes arrive.

## Migration and Rollout Plan

### Phase 0: Immediate Fix — SHIPPED (#760)

~~Add session exit hook to clear `ratchetActiveSessionId` on fixer session exit.~~

### Phase 1: Heartbeat Dispatcher with Synchronous Fixup

Deliver the heartbeat dispatcher model in one phase.

1. Add `ratchetConsecutiveFixupAttempts` and `ratchetStaleCiSince` fields (schema migration).
   - Add `ratchetStateReason`, `ratchetStateUpdatedAt`, `ratchetCurrentActivity` fields for UI status.
2. Build `determineFixupAction()` pure function with exhaustive tests.
3. Add `waitForCompletion(sessionId)` to fixer session service (promise resolved by `onExit` hook, with timeout).
4. Add `clearWorkspaceRatchetSessions(workspaceId)` to fixer session service.
5. Add global GitHub heartbeat dispatcher:
   - Collect deltas across candidate workspaces.
   - Dispatch only changed workspaces (CI-terminal/review/mergeability/push/toggle deltas + retries).
   - Ignore CI-in-progress for fixup dispatch as an optimization.
   - Do not dispatch conflict-only mergeability changes for fixer work.
   - Still write `PAUSED_WAIT_CONFLICT_ONLY` status/log for conflict-only filtered workspaces.
6. Implement `ratchetWorkspace(workspaceId, githubDelta)` single-pass actioning:
   - `clearRatchetSessions()` before action phase.
   - Guard checks (session working, PR state, toggle, attempt budget).
   - For `FIX_CI`/`FIX_REVIEW`: launch fixup session; agent instructions handle sync-with-main behavior.
   - No-push detection: compare branch HEAD before/after session, pause attention if no push.
   - `didPush` tri-state handling with retry/backoff for transient verification errors.
   - Post-green grace window before declaring `PAUSED_DONE`.
   - Blocked-merge wait state (`PAUSED_WAIT_HUMAN_REVIEW`) when only human review is pending.
7. Enforce per-workspace single-flight + coalesced follow-up pass when new deltas arrive mid-run.
8. Wire consecutive attempt counter: increment after each pushed fixup, reset on `PAUSED_DONE`, external push, or ratchet re-enable.
9. Skip fixup launch when `consecutiveAttempts >= 3` (`PAUSED_ATTENTION_TERMINAL_FAILED`).
10. Make `RatchetTransitionLog` mandatory and log all dispatch/wait/pause/terminal-attention transitions.
11. Write UI status fields (`ratchetStateReason`, `ratchetStateUpdatedAt`, `ratchetCurrentActivity`) at each transition.

### Phase 2: Cleanup

1. Remove `handleExistingFixerSession` and all async fixup code paths — replaced by `clearRatchetSessions()` + synchronous await.
2. Remove `ratchetLastNotifiedState` field (no mid-flight notification in sync model).
3. Remove `shouldNotifyActiveFixer` logic.

## Detailed File-Level Plan

1. `prisma/schema.prisma`
   - Add `ratchetConsecutiveFixupAttempts`, `ratchetStaleCiSince`, `ratchetStateReason`, `ratchetStateUpdatedAt`, `ratchetCurrentActivity` fields to Workspace.
   - Add `RatchetTransitionLog` table (mandatory).

2. `src/backend/services/ratchet-action.service.ts` (new)
   - Pure `determineFixupAction()` function.

3. `src/backend/services/ratchet-action.service.test.ts` (new)
   - Exhaustive guard tests.

4. `src/backend/services/ratchet.service.ts`
   - Implement heartbeat tick + workspace dispatch.
   - Implement `ratchetWorkspace(workspaceId, githubDelta)` single-pass handler.
   - Wire attempt counter (increment, reset, terminal check).
   - Wire stale CI timeout attention pause path.
   - Emit user-facing current-activity messages for each step (`fixing build`, `fixing review comments`, etc.).
   - Implement `didPush` tri-state verification + transient recovery/backoff.
   - Implement post-green grace window and blocked-merge wait state.
   - Implement heartbeat-side conflict-only status/log update path (`PAUSED_WAIT_CONFLICT_ONLY`) without fixer dispatch.
   - Use canonical `isSessionWorking()` semantics for `hasAnyWorkingSession()`.

5. `src/backend/services/fixer-session.service.ts`
   - Add `waitForCompletion(sessionId)` (with timeout).
   - Add `clearWorkspaceRatchetSessions(workspaceId)`.

6. `src/backend/resource_accessors/workspace.accessor.ts`
   - Add `incrementFixupAttempts()` / `resetFixupAttempts()`.
   - Add `setStaleCiSince()` / `clearStaleCiSince()`.
   - Add `updateRatchetUiStatus()` helper for status/reason/activity/timestamp.
   - Add `appendTransitionLog()` / `pruneTransitionLog()`.

7. `src/backend/trpc/workspace.trpc.ts`
   - Reset `ratchetConsecutiveFixupAttempts` on ratchet re-enable.
   - Expose `currentRatchetStatus` and transition timeline fields used by workspace UI (including `outcomeKind`/attention signal).

## Testing Plan

### Unit Tests

1. `src/backend/services/ratchet-action.service.test.ts` (new)
   - Every guard combination for `determineFixupAction`: ratchet disabled, merge conflict-only, CI failed, review comments, merge blocked, all green.
   - `PAUSED_ATTENTION_TERMINAL_FAILED` entry at 3 attempts.
   - Terminal threshold uses consecutive attempts at 3.
   - Counter reset on `PAUSED_DONE`, external push, ratchet re-enable.
   - Ratchet disabled → `PAUSE(PAUSED_DISABLED)`.

2. `src/backend/services/ratchet.service.test.ts`
   - `hasAnyWorkingSession()` uses `isSessionWorking()` semantics; `RUNNING`-but-idle sessions do not block ratchet.
   - `PAUSED_USER_WORKING` does not update last-known GitHub markers (delta preserved for next tick).
   - User session exit triggers force re-evaluation on next heartbeat tick.
   - CI reaches terminal state while user session active → user session ends → workspace dispatched and CI failure acted on.
   - `clearRatchetSessions()` tears down previous fixup before action phase.
   - `clearRatchetSessions()` runs even when ratchet is disabled (cleanup path).
   - Heartbeat delta filter dispatches only changed workspaces.
   - CI-in-progress workspaces are skipped for fixup dispatch.
   - Conflict-only mergeability deltas do not dispatch fixer work.
   - Conflict-only filtered workspaces still get `PAUSED_WAIT_CONFLICT_ONLY` status/log updates.
   - `FIX_CI`/`FIX_REVIEW` prompts include sync-with-main instructions for ratchet agents.
   - Stale CI guard prevents duplicate fixup after push.
   - Stale CI timeout triggers attention pause with audit reason `STALE_CI_TIMEOUT`.
   - UI status is updated with expected activity text when fixing CI, review comments, and merge conflicts.
   - UI status is updated with waiting text during CI wait and active-session wait.
   - UI status is updated with waiting text when merge is blocked on human review.
   - Post-green grace window delays `PAUSED_DONE` briefly to allow late review comments.
   - Attempt counter increments when agent pushes.
   - Attempt counter resets on `PAUSED_DONE` and external push.
   - `PAUSED_ATTENTION_TERMINAL_FAILED` skips fixup launch.
   - Awaiting fixup completion works end-to-end.
   - Workspace single-flight prevents concurrent `ratchetWorkspace` runs.
   - Mid-run delta coalescing schedules one follow-up pass.
   - No-push detection: agent exits without pushing → enters `PAUSED_ATTENTION_NO_PUSH`.
   - No-push does not increment attempt counter.
   - `didPush() === UNKNOWN` (transient verification failure) does not pause attention; ratchet retries with backoff.

3. `src/backend/services/fixer-session.service.test.ts`
   - `waitForCompletion()` resolves when session exits.
   - `waitForCompletion()` resolves with timeout if session hangs.
   - `clearWorkspaceRatchetSessions()` terminates leftover sessions.

### Integration Tests

1. Full flow: CI fails → fixup pushes → stale CI detected → CI restarts → CI passes → `PAUSED_DONE`.
2. Repeated attempts: 3 fixup attempts push but PR still not green/no-review-clean → `PAUSED_ATTENTION_TERMINAL_FAILED` → manual push → counter resets → retry.
3. No-push path: CI fails → agent can't fix → no push → `PAUSED_ATTENTION_NO_PUSH` (no stale CI wait).
4. Review no-push: review comments → agent declines → no push → enters `PAUSED_ATTENTION_NO_PUSH`.
5. User session active: ratchet defers but preserves delta → user session exits → force re-evaluate fires → ratchet picks up the CI failure.
6. Ratchet disabled mid-flight: current fixup completes, `clearRatchetSessions()` cleans up, then workspace transitions to `PAUSED_DISABLED`.
7. Previous ratchet session cleaned up before new fixup launches.
8. Stale CI timeout: run ID never changes after push for > timeout window → attention pause + audit log.
9. Late review comment arrives after `PAUSED_DONE` → wake trigger dispatches `ratchetWorkspace` and workspace returns to active ratcheting.
10. Waiting workspace receives new push/comment and is picked back up by ratchet candidate scan (all states).
11. Heartbeat sees CI in progress for unchanged workspace and skips dispatch without losing later terminal-state trigger.
12. Merge one workspace to `main`; other conflict-only workspaces do not all dispatch fixers (no thundering herd).
13. Conflict + CI failure in a workspace triggers single run where agent handles sync-with-main as part of fix workflow.
14. Edited PR comment (no new comment created) is detected as a delta and re-dispatches `ratchetWorkspace`.

## Observability

Structured logs at each decision point:

1. Action determined: `action`, `reason`, `consecutiveAttempts`.
2. Fixup launched: `sessionId`, `workspaceId`, `issue`.
3. Fixup completed: `sessionId`, `duration`, `pushed` (yes/no), `exitReason` (if no push).
4. Stale CI detected: `currentRunId`, `recordedRunId`.
5. Stale CI timeout attention pause: `workspaceId`, `staleSince`, `timeoutMs`.
6. Terminal attempt pause: `workspaceId`, `consecutiveAttempts`.
7. Transition log: mandatory and queryable via admin endpoint for recent history per workspace.
8. Every log entry should include `uiMessage` when applicable so the UI can render a human-readable timeline without extra mapping.
9. Pause/terminal-attention events should include an attention classification so UI can distinguish clean completion from error/manual-attention outcomes.

## Risks and Mitigations

1. **Risk:** Synchronous fixup blocks the workspace's ratchet slot for the duration of the agent session (could be minutes).
   - **Mitigation:** This is intentional — one thing at a time per workspace. Global heartbeat continues dispatching other workspaces.

2. **Risk:** Stale CI run ID check depends on GitHub API returning updated run IDs.
   - **Mitigation:** Add a stale CI timeout window (for example 5 minutes). If run ID never changes, move to `PAUSED_ATTENTION_STALE_CI_TIMEOUT` and surface manual attention required.

3. **Risk:** session activity guard blocks ratchet while user is interactively working.
   - **Mitigation:** `hasAnyWorkingSession()` delegates to canonical `isSessionWorking()` semantics. `RUNNING`-but-idle sessions do not block.

4. **Risk:** Fixup session hangs and `waitForCompletion` never resolves.
   - **Mitigation:** `waitForCompletion` has a timeout (e.g., 30 minutes). On timeout, the session is terminated, `clearRatchetSessions()` cleans up, and the attempt counter increments. The next iteration re-evaluates fresh state.

5. **Risk:** Ratchet disabled while blocked in `await waitForCompletion()`.
   - **Mitigation:** The current fixup finishes (or times out). On the next heartbeat dispatch for that workspace, `clearRatchetSessions()` runs and state transitions to `PAUSED_DISABLED`. Disabling ratchet lets the in-flight fixup complete but prevents new launches.

6. **Risk:** `didPush` verification fails transiently (for example GitHub API outage), causing false no-push attention pause.
   - **Mitigation:** Use tri-state `didPush` and retry/backoff on `UNKNOWN`; do not treat `UNKNOWN` as no-push.

7. **Risk:** Ratchet marks `PAUSED_DONE` too quickly after green CI and misses late AI review comments.
   - **Mitigation:** Add short post-green grace window before `PAUSED_DONE`.

8. **Risk:** Ratchet ignores merge-blocked states that require human approval.
   - **Mitigation:** Add explicit `PAUSED_WAIT_HUMAN_REVIEW` wait state and continue monitoring.

9. **Risk:** Merging `main` into all conflict-only workspaces causes a thundering herd of unnecessary fixer sessions.
   - **Mitigation:** Conflict-only deltas are non-dispatching; branch sync is handled inside agent workflows during already-actionable runs.

10. **Risk:** Sequential workspace dispatch means workspace B waits while workspace A's fixer runs (potentially 10-30 minutes per workspace).
    - **Mitigation:** Acceptable for initial implementation. Parallel dispatch (concurrent `ratchetWorkspace` calls across workspaces, each under its own single-flight lock) is a planned fast-follow. The per-workspace single-flight guard is already designed to support this — the heartbeat loop is the only thing that needs to change.

## Success Criteria

1. No duplicate fixup launches for the same CI failure or review comment.
2. After a fixup pushes, the ratchet waits for CI to restart before re-evaluating.
3. If the agent exits without pushing, ratchet moves to attention pause immediately — no infinite stale CI wait, no pointless retries.
4. Repeated fixup attempts (3x pushes) trigger `PAUSED_ATTENTION_TERMINAL_FAILED` and stop retrying.
5. Manual push, ratchet re-enable, or reaching `PAUSED_DONE` resets the attempt counter and resumes.
6. Structured logs explain every ratchet decision for debugging.
7. Workspace UI always shows current ratchet activity (for example, `Fixing build failures` or `Addressing PR review comments`) when ratchet is active.
8. Workspace UI visually distinguishes clean completion from attention/manual-action-required exits.
9. Late pushes/comments after `PAUSED_DONE` wake ratchet automatically.

## Implementation Checklist

1. ~~Ship Phase 0: session exit hook clears `ratchetActiveSessionId`.~~ Done (#760).
2. Add `ratchetConsecutiveFixupAttempts` and `ratchetStaleCiSince` schema fields.
3. Build `determineFixupAction()` pure function + exhaustive tests.
4. Add `waitForCompletion(sessionId)` to fixer session service (with timeout).
5. Add `clearWorkspaceRatchetSessions(workspaceId)` to fixer session service.
6. Implement global heartbeat + `ratchetWorkspace(workspaceId, githubDelta)` single-pass dispatch.
7. Wire no-push detection: compare branch HEAD before/after fixup session, transition to attention pause if unchanged.
8. Wire consecutive attempt counter (increment on each pushed fixup, reset on `PAUSED_DONE`/external push/re-enable, terminal at 3).
9. Remove `handleExistingFixerSession`, `shouldNotifyActiveFixer`, and `ratchetLastNotifiedState`.
10. Add mandatory transition/audit logging for every wait, dispatch, pause, and terminal-attention state.
11. Add heartbeat scheduler + per-workspace single-flight/coalescing registry.
12. Add UI status fields + API wiring so workspace view can show current ratchet activity and recent transitions.
13. Add canonical working-session predicate usage (`isSessionWorking`) and tests for `RUNNING`-but-idle behavior.
14. Ensure `PAUSED_USER_WORKING` does not update last-known GitHub markers (delta preservation).
15. Add session-exit force re-evaluation hook: `onExit` → `heartbeat.scheduleReEvaluation(workspaceId)` when `ratchetEnabled`.
16. Add `didPush` tri-state verification with retry/backoff on transient failures.
17. Add post-green grace window before `PAUSED_DONE`.
18. Add blocked-merge wait state (`PAUSED_WAIT_HUMAN_REVIEW`).
19. Ensure heartbeat delta detection covers late push/comment/mergeability updates while paused.
20. Ensure Kanban reflects in-flight ratchet work as `WORKING`, and candidate scanning includes all non-archived open-PR workspaces regardless of current column.
21. Ensure conflict-only mergeability changes set `PAUSED_WAIT_CONFLICT_ONLY` and do not trigger fixer dispatch.
22. Ensure ratchet agent instructions for `FIX_CI`/`FIX_REVIEW` include sync-with-main guidance.
