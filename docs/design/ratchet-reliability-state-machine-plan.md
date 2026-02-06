# Ratchet Reliability Design: Sequential Loop Model

## Status

Draft for implementation planning. Phase 0 (session exit hook) shipped in #760.

## Core Model

The ratchet is a simple sequential loop per workspace. Each iteration checks the PR state and takes at most one action. The fixup is synchronous — the loop blocks while the agent works, eliminating all concurrent fixup state management. The loop itself is long-lived and does not terminate under normal operation; it transitions between active and paused modes.

```
while (true) {
  await sleep(60);
  if (hasAnyWorkingSession()) { setPauseState('PAUSED_USER_WORKING'); continue; }
  if (notHasPr()) { setPauseState('PAUSED_NO_PR'); continue; }
  if (!prIsOpen()) { setPauseState('PAUSED_PR_NOT_OPEN'); continue; }
  if (ciRunning()) continue;              // CI in progress — wait for result
  if (ciJustTurnedGreenWithin(120)) continue; // short post-green grace window for late AI review comments
  if (hasStaleCiRun() && !staleCiTimedOut()) continue; // unchanged CI run ID since last push — wait for restart
  if (staleCiTimedOut()) { setPauseState('PAUSED_ATTENTION_STALE_CI_TIMEOUT'); continue; }
  await clearRatchetSessions();           // close the ratchet session from the previous run, if any (note we do this before checking if ratchet is disabled, since it might have just been disabled after the previous run)
  if (!ratchetEnabled()) { setPauseState('PAUSED_DISABLED'); continue; }
  if (tooManyFixupAttempts()) { setPauseState('PAUSED_ATTENTION_TERMINAL_FAILED'); continue; }
  if (hasMergeConflict()) {               // can't merge regardless of CI — resolve first
    recordCiRunId();
    await sendAgentToResolveConflictAndPush();
    if (didPush() === 'NO') { setPauseState('PAUSED_ATTENTION_NO_PUSH'); continue; }
    if (didPush() === 'UNKNOWN') continue; // transient push verification failure — retry on next poll
    incrementFixupAttempt();
    setPauseState('ACTIVE');
    continue;
  }
  if (!ciGreen()) {                       // CI failed — fix the failure
    recordCiRunId();
    await sendAgentToFixCiAndPush();
    if (didPush() === 'NO') { setPauseState('PAUSED_ATTENTION_NO_PUSH'); continue; }
    if (didPush() === 'UNKNOWN') continue; // transient push verification failure — retry on next poll
    incrementFixupAttempt();
    setPauseState('ACTIVE');
    continue;
  }
  if (hasReviewComments()) {              // CI green but reviewer requested changes
    recordCiRunId();
    await sendAgentToAddressReviewAndPush();
    if (didPush() === 'NO') { setPauseState('PAUSED_ATTENTION_NO_PUSH'); continue; }
    if (didPush() === 'UNKNOWN') continue; // transient push verification failure — retry on next poll
    incrementFixupAttempt();
    setPauseState('ACTIVE');
    continue;
  }
  if (isMergeBlockedOnHumanReview()) { setPauseState('PAUSED_WAIT_HUMAN_REVIEW'); continue; } // no fixer action possible; keep monitoring
  setPauseState('PAUSED_DONE');           // green CI, no conflicts, no comments
  continue;
}
```

Key properties:
- **One thing at a time:** `hasAnyWorkingSession()` checks only sessions considered "working" by `isSessionWorking()` semantics. Idle sessions do not block ratchet.
- **Synchronous fixup:** `await sendAgentToFixAndPush()` blocks the loop. No concurrent "fixup running while poller checks" state to manage.
- **Stale CI detection:** After a fixup pushes, `hasStaleCiRun()` compares the current CI run ID to the one recorded before the fixup. If unchanged, CI hasn't restarted yet — just wait.
- **Post-green grace:** After CI first turns green, ratchet waits a short grace window before `PAUSED_DONE` to catch late AI review comments.
- **Bounded stale CI wait:** If CI run ID remains unchanged beyond a timeout window (for example 5 minutes), ratchet enters attention pause (`PAUSED_ATTENTION_STALE_CI_TIMEOUT`) and logs `STALE_CI_TIMEOUT` for manual follow-up.
- **Session cleanup before action:** `clearRatchetSessions()` tears down the previous fixup session *before* deciding whether to launch a new one. This runs even when ratchet is disabled, so disabling mid-flight still cleans up.
- **Late ratchet-enabled check:** `!ratchetEnabled()` is evaluated after monitoring guards (PR state, CI state) and after session cleanup, but before any fixup action. The loop continues to observe PR/CI state regardless of the toggle — disabling ratchet only prevents new fixup launches.
- **No-push pauses actioning:** After each fixup, `didPush()` checks whether the agent actually pushed. If no push, ratchet moves to attention pause (`PAUSED_ATTENTION_NO_PUSH`); if push verification is transiently unknown (for example GitHub API outage), ratchet retries verification next iteration.
- **Terminal attempt budget:** If attempt count reaches threshold, ratchet moves to attention pause (`PAUSED_ATTENTION_TERMINAL_FAILED`) rather than looping indefinitely.
- **External-event wake safety:** Push/comment/review-change events wake paused ratchets so late changes are picked up quickly.
- **Re-derive action each iteration:** No cached state. Each iteration fetches fresh PR/CI/review status and decides what to do.

## Why This Exists

The current ratchet loop has two reliability issues:

1. Active fixer linkage (`ratchetActiveSessionId`) was not cleaned up on session exit; stale references persisted until the next poll detected them. (**Fixed in Phase 0, #760.**)
2. After a fixup pushes a fix, the next poll can see stale CI state (old failure, new run hasn't registered yet) and incorrectly launch another fixup for the same issue.

This document defines a plan to fix issue 2 and simplify the ratchet into the sequential model above.

## Design Goals

1. Simple sequential loop per workspace — easy to reason about.
2. At most one action per workspace at a time.
3. No duplicate fixup launches for the same issue.
4. Stop retrying after repeated attempts (`PAUSED_ATTENTION_TERMINAL_FAILED`).
5. Observable — a transition log explains every ratchet decision.

## Non-Goals

1. Replacing polling with webhooks.
2. Implementing auto-merge behavior.
3. Reworking workspace lifecycle state machine (`NEW/PROVISIONING/READY/...`).
4. Multi-instance backend support (leases, CAS versioning, heartbeats). The current runtime is single-process SQLite. The sequential loop model is inherently single-writer per workspace; multi-instance would require additional concurrency controls that can be layered on later.

## State Determination

Each poll iteration derives the workspace action from fresh GitHub state. This is a pure function — no side effects, no database access:

```
determineFixupAction(prState, ciStatus, mergeState, reviewState, ratchetEnabled, consecutiveAttempts) ->
  | { action: 'WAIT', reason: string }
  | { action: 'PAUSE', pauseState: string, reason: string }
  | { action: 'FIX_MERGE_CONFLICT', reason: string }
  | { action: 'FIX_CI', reason: string }
  | { action: 'FIX_REVIEW', reason: string }
  | { action: 'NOOP', reason: string }
```

Guard evaluation order (matches the loop):

1. **No PR** → `PAUSE(PAUSED_NO_PR)`
2. **PR not open** (closed or merged) → `PAUSE(PAUSED_PR_NOT_OPEN)`
3. **CI running** → `WAIT`
4. **Stale CI run** (run ID unchanged since last push and stale timeout not reached) → `WAIT`
5. **Stale CI timeout reached** → `PAUSE(PAUSED_ATTENTION_STALE_CI_TIMEOUT)` (manual attention required; audit as `STALE_CI_TIMEOUT`)
6. *(Orchestration: `clearRatchetSessions()` runs here — not part of the pure function)*
7. **Ratchet disabled** → `PAUSE(PAUSED_DISABLED)` (previous session cleaned up, no new fixup launched)
8. **Merge conflict** and `consecutiveAttempts < 3` → `FIX_MERGE_CONFLICT`
9. **Merge conflict** and `consecutiveAttempts >= 3` → `PAUSE(PAUSED_ATTENTION_TERMINAL_FAILED)`
10. **CI failed** and `consecutiveAttempts < 3` → `FIX_CI`
11. **CI failed** and `consecutiveAttempts >= 3` → `PAUSE(PAUSED_ATTENTION_TERMINAL_FAILED)`
12. **Review comments** and `consecutiveAttempts < 3` → `FIX_REVIEW`
13. **Review comments** and `consecutiveAttempts >= 3` → `PAUSE(PAUSED_ATTENTION_TERMINAL_FAILED)`
14. **Merge blocked on human review** → `PAUSE(PAUSED_WAIT_HUMAN_REVIEW)`
15. **All green** → `PAUSE(PAUSED_DONE)`

### No-Push Detection

After each fixup session completes, the ratchet checks whether the agent pushed. Implementation: compare the branch HEAD sha (or `ratchetLastPushAt`) before and after the session.

- **Agent didn't push:** Ratchet moves to attention pause (`PAUSED_ATTENTION_NO_PUSH`). No state changed on the remote, so repeating the same fixup immediately is not useful. The workspace surfaces as needing manual attention.
- **Agent pushed:** The loop continues — `incrementFixupAttempt()` runs, then the next iteration waits for CI to restart via `hasStaleCiRun()` before re-evaluating.

### Wake Safety

To avoid missing updates while paused, wake ratchet from external change triggers:

1. New push to the workspace branch.
2. New PR review comment / review submitted with changes requested.
3. Mergeability status changes (for example blocked review requirement resolved).

`wakeRatchetLoop(workspaceId)` must be idempotent, so these triggers can fire aggressively without duplicate loops.

### Terminal Attempt Pause (`PAUSED_ATTENTION_TERMINAL_FAILED`)

**Entry:** `consecutiveAttempts >= 3` when a fixup action would otherwise be taken. The no-push case exits the loop immediately without incrementing the counter.

**Counter increment:** Increment after each ratchet fixup session that pushed, regardless of issue category. This is an attempt budget, not a failed-push-only budget.

**Counter reset:** Resets to 0 when:
- A new push is detected from outside the ratchet (`ratchetLastPushAt` changes without a ratchet fixup preceding it), indicating manual intervention.
- The ratchet toggle is disabled and re-enabled.
- The workspace reaches `PAUSED_DONE` (green CI, no merge conflict, no review comments).

**Behavior:** The loop continues running, but stays in `PAUSED_ATTENTION_TERMINAL_FAILED` and skips fixup launches until external intervention changes inputs.

### Blocked Merge Handling

If CI is green and there are no actionable review comments, but merge is blocked by human-review policy (for example required approval missing), ratchet does not launch fixers and stays in a waiting state (`WAIT_HUMAN_REVIEW`) until mergeability changes.

### Stale CI Detection

After a fixup pushes, the push should trigger a new CI run. But there's a delay before GitHub registers the new run. During this window, the poller would see the old failed CI run and incorrectly launch another fixup.

**Fix:** Before launching a fixup, record the current CI run ID (`ratchetLastCiRunId`) and stale wait start time (`ratchetStaleCiSince`). On the next iteration, `hasStaleCiRun()` compares the current CI run ID to the recorded one. If they match, CI hasn't restarted yet — wait until timeout. Once a new run starts, the ID changes and the stale check passes.

**Timeout:** If run ID remains unchanged for longer than the stale timeout window (for example 5 minutes), pause with `PAUSED_ATTENTION_STALE_CI_TIMEOUT` and audit log `STALE_CI_TIMEOUT` so manual action can unblock CI.

This uses the existing `ratchetLastCiRunId` field, which the current code already tracks.

## Persistence Changes

### Workspace Model Additions

Add to `Workspace`:

1. `ratchetConsecutiveFixupAttempts Int @default(0)` — counter for terminal attempt pause entry
2. `ratchetStaleCiSince DateTime?` — when stale CI waiting started for timeout enforcement
3. `ratchetStateReason String?` — short reason code for current UI-visible ratchet status
4. `ratchetStateUpdatedAt DateTime?` — last time UI-visible ratchet status changed
5. `ratchetCurrentActivity String?` — user-facing current action summary (`FIXING_BUILD`, `FIXING_REVIEW_COMMENTS`, `RESOLVING_MERGE_CONFLICT`, `WAITING_FOR_CI`, etc.)

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

Simplify `ratchet.service.ts` to match the sequential loop:

1. **Check monitoring guards:** `hasAnyWorkingSession()`, `notHasPr()`, `!prIsOpen()`, `ciRunning()`, `hasStaleCiRun()`, `staleCiTimedOut()`. These are passive — they only observe state and decide to wait or set pause state.
2. **Clean up previous session:** `clearRatchetSessions()` tears down any leftover ratchet fixer session from the previous iteration. This runs before the ratchet-enabled check so that disabling ratchet mid-flight still cleans up.
3. **Check ratchet toggle:** `!ratchetEnabled()` — if disabled, set pause state (`PAUSED_DISABLED`) and skip fixup actions.
4. **Fetch state:** Get PR/CI/review status from GitHub.
5. **Determine action:** Call `determineFixupAction()`.
6. **Execute:** If `FIX_*`, record CI run ID + stale wait start, launch fixup session, await completion. After completion, check `didPush()`: if no push, set attention pause; if pushed, increment attempt counter and continue to next iteration. If `PAUSE`, set the requested pause state. If `WAIT`/`NOOP`, do nothing.
7. **Audit log:** Write structured transition log entry for every wait, dispatch, pause transition, and terminal attention state.

The fixup launch uses the existing `fixerSessionService.acquireAndDispatch()` but the orchestrator awaits session completion before returning.

### Loop Implementation Shape (Explicit)

Implement ratchet almost exactly like the pseudocode as a long-lived async task per workspace.

1. `runRatchetLoop(workspaceId, signal): Promise<void>` contains the `while (!signal.aborted)` loop and mirrors the guard order in this doc.
2. Each guard/action remains a small named helper so the loop body reads top-to-bottom like the design (`hasAnyWorkingSession`, `hasStaleCiRun`, `staleCiTimedOut`, `determineFixupAction`, `didPush`).
3. Keep one loop owner per workspace via an in-memory registry, for example `Map<workspaceId, { controller, promise }>`; do not allow concurrent loops for the same workspace.
4. Add explicit lifecycle methods:
   - `startRatchetLoop(workspaceId)` (no-op if already running)
   - `stopRatchetLoop(workspaceId, reason)` (abort controller + cleanup)
   - `wakeRatchetLoop(workspaceId, reason)` (poke loop to skip sleep/backoff and re-evaluate immediately)
5. Re-entry triggers should call `wakeRatchetLoop(...)` on meaningful external state changes such as new push, ratchet re-enable, or workspace returning to ratchet-eligible state.
6. Sleep and blocking waits must be cancellable via `AbortSignal` so disable/shutdown does not strand the loop in `sleep(...)` or long waits.
7. Push/review-comment/mergeability change triggers should call `wakeRatchetLoop(...)` so paused loops re-evaluate immediately.

### Working Session Definition (Explicit)

`hasAnyWorkingSession()` must use the same semantics as `fixerSessionService.isSessionWorking()` to avoid drift.

Definition for this design:

1. A session is **working** when `isSessionWorking(session)` is true (active execution state).
2. A session that is `RUNNING` but waiting for user input/idle is **not** working and must not block ratchet.
3. Ratchet must call one canonical helper for this decision (do not duplicate ad-hoc status checks in ratchet service).
4. Add tests that pin this behavior so future session-state refactors do not accidentally change ratchet blocking behavior.

### `didPush` Recovery Semantics

`didPush()` should return a tri-state result:

1. `YES` — push confirmed.
2. `NO` — no push confirmed.
3. `UNKNOWN` — transient verification failure (for example GitHub API unavailable or timeout).

On `UNKNOWN`, ratchet should not mark no-push or terminal; it should record an attention/wait reason and retry verification on subsequent iterations with backoff.

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
   - `Fixing build failures`
   - `Addressing PR review comments`
   - `Resolving merge conflicts`
   - `Waiting for CI to restart`
   - `Waiting for active workspace session to finish`
   - `Waiting for human review approval`
4. Update these fields at every major transition (wait, dispatch, completion, pause, terminal attention).
5. Keep `RatchetTransitionLog` as the detailed timeline.
6. Add/extend API endpoints for UI:
   - `currentRatchetStatus(workspaceId)` → current status snapshot (`state`, `reason`, `currentActivity`, `updatedAt`, counters)
   - `ratchetTransitions(workspaceId, limit)` → recent timeline entries (`action`, `reason`, `uiMessage`, `createdAt`)
7. Add an outcome/attention indicator in status payload (for example `outcomeKind: SUCCESS | ATTENTION`) so UI can visually separate clean exits from error/manual-attention exits.
8. While ratchet loop is active for a workspace, workspace should present in Kanban `WORKING` column.
9. Ratchet eligibility scanning should include all non-archived workspaces with open PRs regardless of current Kanban column, so `WAITING` work can move back to `WORKING` when new comments/pushes arrive.

## Migration and Rollout Plan

### Phase 0: Immediate Fix — SHIPPED (#760)

~~Add session exit hook to clear `ratchetActiveSessionId` on fixer session exit.~~

### Phase 1: Sequential Loop with Synchronous Fixup

Deliver the full sequential loop model in one phase, since stale CI detection and synchronous fixup are interdependent and the intermediate async state isn't worth supporting.

1. Add `ratchetConsecutiveFixupAttempts` and `ratchetStaleCiSince` fields (schema migration).
   - Add `ratchetStateReason`, `ratchetStateUpdatedAt`, `ratchetCurrentActivity` fields for UI status.
2. Build `determineFixupAction()` pure function with exhaustive tests.
3. Add `waitForCompletion(sessionId)` to fixer session service (promise resolved by `onExit` hook, with timeout).
4. Add `clearWorkspaceRatchetSessions(workspaceId)` to fixer session service.
5. Rewrite ratchet orchestrator as the sequential loop:
   - Monitoring guards (session running, PR state, CI state, stale CI).
   - `clearRatchetSessions()` before action phase.
   - `ratchetEnabled` check after cleanup.
   - Synchronous fixup: record CI run ID, launch session, await completion.
   - No-push detection: compare branch HEAD before/after session, pause attention if no push.
   - `didPush` tri-state handling with retry/backoff for transient verification errors.
   - Post-green grace window before declaring `PAUSED_DONE`.
   - Blocked-merge wait state (`WAIT_HUMAN_REVIEW`) when only human review is pending.
   - Use per-workspace loop registry + `AbortController` to enforce one loop owner and support cancellation.
6. Wire consecutive attempt counter: increment after each pushed fixup, reset on `PAUSED_DONE`, external push, or ratchet re-enable.
7. Skip fixup launch when `consecutiveAttempts >= 3` (`PAUSED_ATTENTION_TERMINAL_FAILED`).
8. Make `RatchetTransitionLog` mandatory and log all dispatch/wait/pause/terminal-attention transitions.
9. Write UI status fields (`ratchetStateReason`, `ratchetStateUpdatedAt`, `ratchetCurrentActivity`) at each transition.

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
   - Rewrite as sequential loop: monitoring guards → `clearRatchetSessions()` → `ratchetEnabled` check → `determineFixupAction()` → synchronous fixup.
   - Wire attempt counter (increment, reset, terminal check).
   - Wire stale CI timeout attention pause path.
   - Emit user-facing current-activity messages for each step (`fixing build`, `fixing review comments`, etc.).
   - Implement `didPush` tri-state verification + transient recovery/backoff.
   - Implement post-green grace window and blocked-merge wait state.
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
   - Every guard combination for `determineFixupAction`: ratchet disabled, merge conflict, CI failed, review comments, all green.
   - `PAUSED_ATTENTION_TERMINAL_FAILED` entry at 3 attempts.
   - Terminal threshold uses consecutive attempts at 3.
   - Counter reset on `PAUSED_DONE`, external push, ratchet re-enable.
   - Ratchet disabled → `PAUSE(PAUSED_DISABLED)`.

2. `src/backend/services/ratchet.service.test.ts`
   - `hasAnyWorkingSession()` uses `isSessionWorking()` semantics; `RUNNING`-but-idle sessions do not block ratchet.
   - `clearRatchetSessions()` tears down previous fixup before action phase.
   - `clearRatchetSessions()` runs even when ratchet is disabled (cleanup path).
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
   - No-push detection: agent exits without pushing → enters `PAUSED_ATTENTION_NO_PUSH`.
   - No-push does not increment attempt counter.
   - `didPush() === UNKNOWN` (transient verification failure) does not pause attention; ratchet retries with backoff.

3. `src/backend/services/fixer-session.service.test.ts`
   - `waitForCompletion()` resolves when session exits.
   - `waitForCompletion()` resolves with timeout if session hangs.
   - `clearWorkspaceRatchetSessions()` terminates leftover sessions.

### Integration Tests

1. Full loop: CI fails → fixup pushes → stale CI detected → CI restarts → CI passes → `PAUSED_DONE`.
2. Repeated attempts: 3 fixup attempts push but PR still not green/no-review-clean → `PAUSED_ATTENTION_TERMINAL_FAILED` → manual push → counter resets → retry.
3. No-push path: CI fails → agent can't fix → no push → `PAUSED_ATTENTION_NO_PUSH` (no stale CI wait).
4. Review no-push: review comments → agent declines → no push → loop breaks.
5. User session active: ratchet waits until user session exits.
6. Ratchet disabled mid-flight: current fixup completes, `clearRatchetSessions()` cleans up, loop transitions to `PAUSED_DISABLED`.
7. Previous ratchet session cleaned up before new fixup launches.
8. Stale CI timeout: run ID never changes after push for > timeout window → attention pause + audit log.
9. Late review comment arrives after `PAUSED_DONE` → wake trigger wakes loop and workspace returns to active ratcheting.
10. Waiting workspace receives new push/comment and is picked back up by ratchet candidate scan (all states).

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
   - **Mitigation:** This is intentional — one thing at a time. Other workspaces continue processing independently via `p-limit`. The slot is freed immediately on session exit.

2. **Risk:** Stale CI run ID check depends on GitHub API returning updated run IDs.
   - **Mitigation:** Add a stale CI timeout window (for example 5 minutes). If run ID never changes, move to `PAUSED_ATTENTION_STALE_CI_TIMEOUT` and surface manual attention required.

3. **Risk:** session activity guard blocks ratchet while user is interactively working.
   - **Mitigation:** `hasAnyWorkingSession()` delegates to canonical `isSessionWorking()` semantics. `RUNNING`-but-idle sessions do not block.

4. **Risk:** Fixup session hangs and `waitForCompletion` never resolves.
   - **Mitigation:** `waitForCompletion` has a timeout (e.g., 30 minutes). On timeout, the session is terminated, `clearRatchetSessions()` cleans up, and the attempt counter increments. The next iteration re-evaluates fresh state.

5. **Risk:** Ratchet disabled while blocked in `await waitForCompletion()`.
   - **Mitigation:** The current fixup finishes (or times out). On the next iteration, `clearRatchetSessions()` cleans up, then loop state transitions to `PAUSED_DISABLED`. Disabling ratchet lets the in-flight fixup complete but prevents new launches.

6. **Risk:** `didPush` verification fails transiently (for example GitHub API outage), causing false no-push attention pause.
   - **Mitigation:** Use tri-state `didPush` and retry/backoff on `UNKNOWN`; do not treat `UNKNOWN` as no-push.

7. **Risk:** Ratchet marks `PAUSED_DONE` too quickly after green CI and misses late AI review comments.
   - **Mitigation:** Add short post-green grace window before `PAUSED_DONE`.

8. **Risk:** Ratchet ignores merge-blocked states that require human approval.
   - **Mitigation:** Add explicit `WAIT_HUMAN_REVIEW` wait state and continue monitoring.

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
6. Rewrite ratchet orchestrator as sequential loop (monitoring guards → cleanup → enabled check → action → synchronous fixup → no-push check).
7. Wire no-push detection: compare branch HEAD before/after fixup session, transition to attention pause if unchanged.
8. Wire consecutive attempt counter (increment on each pushed fixup, reset on `PAUSED_DONE`/external push/re-enable, terminal at 3).
9. Remove `handleExistingFixerSession`, `shouldNotifyActiveFixer`, and `ratchetLastNotifiedState`.
10. Add mandatory transition/audit logging for every wait, dispatch, pause, and terminal-attention state.
11. Add per-workspace loop registry (`start/stop/wake`) with `AbortController` cancellation.
12. Add UI status fields + API wiring so workspace view can show current ratchet activity and recent transitions.
13. Add canonical working-session predicate usage (`isSessionWorking`) and tests for `RUNNING`-but-idle behavior.
14. Add `didPush` tri-state verification with retry/backoff on transient failures.
15. Add post-green grace window before `PAUSED_DONE`.
16. Add blocked-merge wait state (`WAIT_HUMAN_REVIEW`).
17. Add wake triggers for late push/comment/mergeability updates while paused.
18. Ensure Kanban reflects active ratchet loop as `WORKING`, and candidate scanning includes all non-archived open-PR workspaces regardless of current column.
