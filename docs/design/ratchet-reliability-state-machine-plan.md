# Ratchet Reliability Design: Sequential Loop Model

## Status

Draft for implementation planning. Phase 0 (session exit hook) shipped in #760.

## Core Model

The ratchet is a simple sequential loop per workspace. Each iteration checks the PR state and takes at most one action. The fixup is synchronous — the loop blocks while the agent works, eliminating all concurrent fixup state management.

```
while (true) {
  await sleep(60);
  if (hasAnySessionRunning()) continue;   // any workspace session active — wait
  if (notHasPr()) break;                  // no PR — ratchet has nothing to do
  if (!prIsOpen()) break;                 // PR closed or merged — ratchet is done
  if (ciRunning()) continue;              // CI in progress — wait for result
  if (hasStaleCiRun()) continue;          // CI run ID unchanged since last push — wait for restart
  await clearRatchetSessions();           // close the ratchet session from the previous run, if any (note we do this before checking if ratchet is disabled, since it might have just been disabled after the previous run)
  if (!ratchetEnabled()) break;           // ratchet disabled at the point where ratcheting would start.
  if (hasMergeConflict()) {               // can't merge regardless of CI — resolve first
    recordCiRunId();
    await sendAgentToResolveConflictAndPush();
    if (!didPush()) break;                // agent couldn't fix it — stop ratcheting
    incrementFixupAttempt();
    continue;
  }
  if (!ciGreen()) {                       // CI failed — fix the failure
    recordCiRunId();
    await sendAgentToFixCiAndPush();
    if (!didPush()) break;                // agent couldn't fix it — stop ratcheting
    incrementFixupAttempt();
    continue;
  }
  if (hasReviewComments()) {              // CI green but reviewer requested changes
    recordCiRunId();
    await sendAgentToAddressReviewAndPush();
    if (!didPush()) break;                // agent declined or couldn't address — stop ratcheting
    incrementFixupAttempt();
    continue;
  }
  break;                                  // green CI, no conflicts, no comments — done
}
```

Key properties:
- **One thing at a time:** `hasAnySessionRunning()` checks all workspace sessions, not just ratchet fixers. If the user is working, ratchet waits.
- **Synchronous fixup:** `await sendAgentToFixAndPush()` blocks the loop. No concurrent "fixup running while poller checks" state to manage.
- **Stale CI detection:** After a fixup pushes, `hasStaleCiRun()` compares the current CI run ID to the one recorded before the fixup. If unchanged, CI hasn't restarted yet — just wait.
- **Session cleanup before action:** `clearRatchetSessions()` tears down the previous fixup session *before* deciding whether to launch a new one. This runs even when ratchet is disabled, so disabling mid-flight still cleans up.
- **Late ratchet-enabled check:** `!ratchetEnabled()` is evaluated after monitoring guards (PR state, CI state) and after session cleanup, but before any fixup action. The loop continues to observe PR/CI state regardless of the toggle — disabling ratchet only prevents new fixup launches.
- **No-push exits the loop:** After each fixup, `didPush()` checks whether the agent actually pushed. If the agent didn't push — couldn't fix it, got stuck, or (for reviews) decided the comments aren't actionable — the loop breaks immediately. Retrying would produce the same result since no state changed. This also prevents the stale CI infinite-wait: no push means no new CI run, so `hasStaleCiRun()` would block forever.
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
4. Stop retrying after repeated failures (`TERMINAL_FAILED`).
5. Observable — a transition log explains every ratchet decision.

## Non-Goals

1. Replacing polling with webhooks.
2. Implementing auto-merge behavior.
3. Reworking workspace lifecycle state machine (`NEW/PROVISIONING/READY/...`).
4. Multi-instance backend support (leases, CAS versioning, heartbeats). The current runtime is single-process SQLite. The sequential loop model is inherently single-writer per workspace; multi-instance would require additional concurrency controls that can be layered on later.

## State Determination

Each poll iteration derives the workspace action from fresh GitHub state. This is a pure function — no side effects, no database access:

```
determineAction(prState, ciStatus, ciRunId, lastCiRunId, mergeState, reviewState, ratchetEnabled, consecutiveFailures) ->
  | { action: 'WAIT', reason: string }
  | { action: 'CLEANUP_ONLY', reason: string }
  | { action: 'FIX_MERGE_CONFLICT', reason: string }
  | { action: 'FIX_CI', reason: string }
  | { action: 'FIX_REVIEW', reason: string }
  | { action: 'DONE', reason: string }
  | { action: 'TERMINAL_FAILED', reason: string }
```

Guard evaluation order (matches the loop):

1. **No PR** → `DONE`
2. **PR not open** (closed or merged) → `DONE`
3. **CI running** → `WAIT`
4. **Stale CI run** (run ID unchanged since last push) → `WAIT`
5. *(Orchestration: `clearRatchetSessions()` runs here — not part of the pure function)*
6. **Ratchet disabled** → `CLEANUP_ONLY` (previous session cleaned up, no new fixup launched)
7. **Merge conflict** and `consecutiveFailures < 3` → `FIX_MERGE_CONFLICT`
8. **Merge conflict** and `consecutiveFailures >= 3` → `TERMINAL_FAILED`
9. **CI failed** and `consecutiveFailures < 3` → `FIX_CI`
10. **CI failed** and `consecutiveFailures >= 3` → `TERMINAL_FAILED`
11. **Review comments** and `consecutiveFailures < 3` → `FIX_REVIEW`
12. **Review comments** and `consecutiveFailures >= 3` → `TERMINAL_FAILED`
13. **All green** → `DONE`

### No-Push Detection

After each fixup session completes, the ratchet checks whether the agent pushed. Implementation: compare the branch HEAD sha (or `ratchetLastPushAt`) before and after the session.

- **Agent didn't push:** The loop breaks immediately. No state changed on the remote, so retrying would produce the same result. The workspace surfaces as needing manual attention. This covers: agent stuck/errored, agent couldn't resolve the conflict, agent decided review comments aren't actionable.
- **Agent pushed:** The loop continues — `incrementFixupAttempt()` runs, then the next iteration waits for CI to restart via `hasStaleCiRun()` before re-evaluating.

### `TERMINAL_FAILED`

**Entry:** `consecutiveFailures >= 3` when a fixup action would otherwise be taken. This only applies when the agent *does* push but the fix doesn't resolve the issue (e.g., pushes a CI fix that still fails). The no-push case exits the loop immediately without incrementing the counter.

**Counter increment:** After each fixup that pushed, the next iteration re-evaluates. If the same issue category persists (still CI_FAILED, still has review comments), the counter was already incremented. The counter tracks consecutive failed *pushes* — the agent tried and the fix didn't work.

**Counter reset:** Resets to 0 when:
- A new push is detected from outside the ratchet (`ratchetLastPushAt` changes without a ratchet fixup preceding it), indicating manual intervention.
- The ratchet toggle is disabled and re-enabled.

**Behavior:** The poller continues running (detecting external merges, CI passes) but skips fixup launches. The workspace surfaces as needing manual attention in the UI.

### Stale CI Detection

After a fixup pushes, the push should trigger a new CI run. But there's a delay before GitHub registers the new run. During this window, the poller would see the old failed CI run and incorrectly launch another fixup.

**Fix:** Before launching a fixup, record the current CI run ID (`ratchetLastCiRunId`). On the next iteration, `hasStaleCiRun()` compares the current CI run ID to the recorded one. If they match, CI hasn't restarted yet — wait. Once a new run starts, the ID changes and the stale check passes.

This uses the existing `ratchetLastCiRunId` field, which the current code already tracks.

## Persistence Changes

### Workspace Model Additions

Add to `Workspace`:

1. `ratchetConsecutiveFixupFailures Int @default(0)` — counter for `TERMINAL_FAILED` entry

Existing fields used as-is:
- `ratchetState` — updated each poll to reflect current PR state
- `ratchetActiveSessionId` — set when fixup launches, cleared by `clearRatchetSessions()` at the start of each action phase and on session exit (Phase 0)
- `ratchetLastCiRunId` — recorded before fixup launch for stale CI detection
- `ratchetLastCheckedAt` — updated each poll cycle
- `ratchetLastPushAt` — used for manual intervention detection

Fields no longer needed (candidates for removal in cleanup):
- `ratchetLastNotifiedState` — was used to avoid duplicate notifications to active fixers. With synchronous fixups, there is no mid-flight notification; each iteration either waits or launches a fresh session.

No new enums. No new tables in the minimal version.

### Optional: RatchetTransitionLog Table

For observability, add an append-only log:

1. `id String @id @default(cuid())`
2. `workspaceId String`
3. `action String` — the action taken (`WAIT`, `FIX_CI`, `FIX_REVIEW`, `DONE`, `TERMINAL_FAILED`)
4. `reason String` — human-readable explanation
5. `snapshot Json?` — decision-relevant fields (CI status, merge state, review state)
6. `createdAt DateTime @default(now())`

Index: `(workspaceId, createdAt)`.

**Retention:** Prune entries older than 7 days on server startup and via a daily timer.

## Service Architecture Changes

### Action Determination Service (New)

Create `src/backend/services/ratchet-action.service.ts`:

1. Pure function `determineAction(...)` as described above.
2. Exhaustive unit tests for every guard combination.
3. No network calls, no side effects, no database access.

### Ratchet Service Refactor

Simplify `ratchet.service.ts` to match the sequential loop:

1. **Check monitoring guards:** `hasAnySessionRunning()`, `notHasPr()`, `!prIsOpen()`, `ciRunning()`, `hasStaleCiRun()`. These are passive — they only observe state and decide to wait or exit.
2. **Clean up previous session:** `clearRatchetSessions()` tears down any leftover ratchet fixer session from the previous iteration. This runs before the ratchet-enabled check so that disabling ratchet mid-flight still cleans up.
3. **Check ratchet toggle:** `!ratchetEnabled()` — if disabled, break out of the loop. The workspace continues to be monitored (step 1 runs each iteration) but no fixup actions are taken.
4. **Fetch state:** Get PR/CI/review status from GitHub.
5. **Determine action:** Call `determineAction()`.
6. **Execute:** If `FIX_*`, record CI run ID, launch fixup session, await completion. After completion, check `didPush()`: if no push, break (agent couldn't or chose not to fix). If pushed, increment failure counter and continue to next iteration. If `DONE`, mark workspace complete. If `TERMINAL_FAILED`, update state for UI. If `WAIT`, do nothing. If `CLEANUP_ONLY`, no action (session already cleaned up in step 2).
7. **Log:** Write structured log entry.

The fixup launch uses the existing `fixerSessionService.acquireAndDispatch()` but the orchestrator awaits session completion before returning.

### Awaiting Session Completion

The key change: instead of fire-and-forget, the ratchet awaits the fixup session. Implementation options:

1. **Poll session status** — after launching, poll `session.status` every few seconds until it's `COMPLETED`. Simple but adds polling overhead.
2. **Session exit callback** — register a callback on session exit that resolves a promise. The ratchet `await`s this promise. Cleaner, leverages the existing `onExit` hook.

Option 2 is preferred. The `onExit` hook (from Phase 0) already fires on session exit — we just need it to resolve a promise that the ratchet is awaiting.

### Changes to Existing Services

1. **`session.service.ts`** — No additional changes beyond Phase 0. The `onExit` hook already clears `ratchetActiveSessionId`.
2. **`fixer-session.service.ts`** — Existing `acquireAndDispatch()` returns the session ID. Add a `waitForCompletion(sessionId)` method that returns a promise resolved by the session exit hook. Add `clearWorkspaceRatchetSessions(workspaceId)` to terminate and clean up leftover ratchet fixer sessions.
3. **`workspace.accessor.ts`** — Add method to increment/reset `ratchetConsecutiveFixupFailures`.

## Migration and Rollout Plan

### Phase 0: Immediate Fix — SHIPPED (#760)

~~Add session exit hook to clear `ratchetActiveSessionId` on fixer session exit.~~

### Phase 1: Sequential Loop with Synchronous Fixup

Deliver the full sequential loop model in one phase, since stale CI detection and synchronous fixup are interdependent and the intermediate async state isn't worth supporting.

1. Add `ratchetConsecutiveFixupFailures` field (schema migration).
2. Build `determineAction()` pure function with exhaustive tests.
3. Add `waitForCompletion(sessionId)` to fixer session service (promise resolved by `onExit` hook, with timeout).
4. Add `clearWorkspaceRatchetSessions(workspaceId)` to fixer session service.
5. Rewrite ratchet orchestrator as the sequential loop:
   - Monitoring guards (session running, PR state, CI state, stale CI).
   - `clearRatchetSessions()` before action phase.
   - `ratchetEnabled` check after cleanup.
   - Synchronous fixup: record CI run ID, launch session, await completion.
   - No-push detection: compare branch HEAD before/after session, break if no push.
6. Wire consecutive failure counter: increment after fixup if issue persists, reset on external push or ratchet re-enable.
7. Skip fixup launch when `consecutiveFailures >= 3` (`TERMINAL_FAILED`).

### Phase 2: Cleanup

1. Remove `handleExistingFixerSession` and all async fixup code paths — replaced by `clearRatchetSessions()` + synchronous await.
2. Remove `ratchetLastNotifiedState` field (no mid-flight notification in sync model).
3. Remove `shouldNotifyActiveFixer` logic.

## Detailed File-Level Plan

1. `prisma/schema.prisma`
   - Add `ratchetConsecutiveFixupFailures` field to Workspace.
   - Add `RatchetTransitionLog` table (optional).

2. `src/backend/services/ratchet-action.service.ts` (new)
   - Pure `determineAction()` function.

3. `src/backend/services/ratchet-action.service.test.ts` (new)
   - Exhaustive guard tests.

4. `src/backend/services/ratchet.service.ts`
   - Rewrite as sequential loop: monitoring guards → `clearRatchetSessions()` → `ratchetEnabled` check → `determineAction()` → synchronous fixup.
   - Wire failure counter (increment, reset, terminal check).

5. `src/backend/services/fixer-session.service.ts`
   - Add `waitForCompletion(sessionId)` (with timeout).
   - Add `clearWorkspaceRatchetSessions(workspaceId)`.

6. `src/backend/resource_accessors/workspace.accessor.ts`
   - Add `incrementFixupFailures()` / `resetFixupFailures()`.
   - Add `appendTransitionLog()` / `pruneTransitionLog()` (optional).

7. `src/backend/trpc/workspace.trpc.ts`
   - Reset `ratchetConsecutiveFixupFailures` on ratchet re-enable.

## Testing Plan

### Unit Tests

1. `src/backend/services/ratchet-action.service.test.ts` (new)
   - Every guard combination: no PR, PR closed/merged, CI running, stale CI, ratchet disabled, merge conflict, CI failed, review comments, all green.
   - `TERMINAL_FAILED` entry at 3 failures.
   - Counter reset on external push, ratchet re-enable.
   - Stale CI detection: same run ID → WAIT, different run ID → proceed.
   - Ratchet disabled → `CLEANUP_ONLY`.

2. `src/backend/services/ratchet.service.test.ts`
   - `clearRatchetSessions()` tears down previous fixup before action phase.
   - `clearRatchetSessions()` runs even when ratchet is disabled (cleanup path).
   - Stale CI guard prevents duplicate fixup after push.
   - Failure counter increments when agent pushes but issue persists.
   - Failure counter resets on external push.
   - `TERMINAL_FAILED` skips fixup launch.
   - Awaiting fixup completion works end-to-end.
   - No-push detection: agent exits without pushing → loop breaks immediately.
   - No-push does not increment failure counter (distinct from push-but-still-failing).

3. `src/backend/services/fixer-session.service.test.ts`
   - `waitForCompletion()` resolves when session exits.
   - `waitForCompletion()` resolves with timeout if session hangs.
   - `clearWorkspaceRatchetSessions()` terminates leftover sessions.

### Integration Tests

1. Full loop: CI fails → fixup pushes → stale CI detected → CI restarts → CI passes → DONE.
2. Repeated failures: 3 fixup attempts push but fail → TERMINAL_FAILED → manual push → counter resets → retry.
3. No-push exit: CI fails → agent can't fix → no push → loop breaks immediately (no stale CI wait).
4. Review no-push: review comments → agent declines → no push → loop breaks.
5. User session active: ratchet waits until user session exits.
6. Ratchet disabled mid-flight: current fixup completes, `clearRatchetSessions()` cleans up, loop exits.
7. Previous ratchet session cleaned up before new fixup launches.

## Observability

Structured logs at each decision point:

1. Action determined: `action`, `reason`, `consecutiveFailures`.
2. Fixup launched: `sessionId`, `workspaceId`, `issue`.
3. Fixup completed: `sessionId`, `duration`, `pushed` (yes/no), `exitReason` (if no push).
4. Stale CI detected: `currentRunId`, `recordedRunId`.
5. Terminal failure: `workspaceId`, `consecutiveFailures`.
6. Transition log: queryable via admin endpoint for recent history per workspace.

## Risks and Mitigations

1. **Risk:** Synchronous fixup blocks the workspace's ratchet slot for the duration of the agent session (could be minutes).
   - **Mitigation:** This is intentional — one thing at a time. Other workspaces continue processing independently via `p-limit`. The slot is freed immediately on session exit.

2. **Risk:** Stale CI run ID check depends on GitHub API returning updated run IDs.
   - **Mitigation:** If the run ID never changes (API lag), the stale check causes the ratchet to wait extra poll cycles — safe (just slow). Once CI starts, the ID updates and the loop proceeds.

3. **Risk:** `hasAnySessionRunning()` blocks ratchet while user is interactively working.
   - **Mitigation:** This is correct behavior — the ratchet shouldn't interfere with active user work. The ratchet resumes on the next poll after the user's session exits.

4. **Risk:** Fixup session hangs and `waitForCompletion` never resolves.
   - **Mitigation:** `waitForCompletion` has a timeout (e.g., 30 minutes). On timeout, the session is terminated, `clearRatchetSessions()` cleans up, and the failure counter increments. The next iteration re-evaluates fresh state.

5. **Risk:** Ratchet disabled while blocked in `await waitForCompletion()`.
   - **Mitigation:** The current fixup finishes (or times out). On the next iteration, `clearRatchetSessions()` cleans up, then `!ratchetEnabled()` breaks the loop. Disabling ratchet lets the in-flight fixup complete but prevents new launches.

## Success Criteria

1. No duplicate fixup launches for the same CI failure or review comment.
2. After a fixup pushes, the ratchet waits for CI to restart before re-evaluating.
3. If the agent exits without pushing, the loop stops immediately — no infinite stale CI wait, no pointless retries.
4. Repeated failed pushes (3x) trigger `TERMINAL_FAILED` and stop retrying.
5. Manual push or ratchet re-enable resets the failure counter and resumes.
6. Structured logs explain every ratchet decision for debugging.

## Implementation Checklist

1. ~~Ship Phase 0: session exit hook clears `ratchetActiveSessionId`.~~ Done (#760).
2. Add `ratchetConsecutiveFixupFailures` schema field.
3. Build `determineAction()` pure function + exhaustive tests.
4. Add `waitForCompletion(sessionId)` to fixer session service (with timeout).
5. Add `clearWorkspaceRatchetSessions(workspaceId)` to fixer session service.
6. Rewrite ratchet orchestrator as sequential loop (monitoring guards → cleanup → enabled check → action → synchronous fixup → no-push check).
7. Wire no-push detection: compare branch HEAD before/after fixup session, break if unchanged.
8. Wire consecutive failure counter (increment on push-but-still-failing, reset on external push or re-enable, terminal at 3).
9. Remove `handleExistingFixerSession`, `shouldNotifyActiveFixer`, and `ratchetLastNotifiedState`.
