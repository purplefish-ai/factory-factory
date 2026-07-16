# Ratchet Delegation Flattening & Decision Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement GitHub issue #1861 — flatten the ratchet service's delegation plumbing, merge the activity-collection step into `decideRatchetAction`, consolidate disable-race handling onto the conditional accessors, and let event-driven ratchet refreshes bypass the PR-fetch cooldown.

**Architecture:** `src/backend/services/ratchet/service/` keeps its helper-module layout, but helpers own their logger (`createLogger('ratchet')`) and call each other / `workspaceAccessor` directly instead of receiving callbacks. The service class keeps thin private methods only where they inject genuine seams (session/github bridges, backoff state). `decideRatchetAction` becomes async and fetches `hasActiveSession` lazily at its two dispatch points, replacing the parallel `collectHasOtherActiveSession`/`isRetryableDeath` gate mirror. `checkWorkspaceById` gains a `bypassPrFetchCooldown` option used by the event collector.

**Tech Stack:** TypeScript, Vitest, Prisma, Biome.

## Global Constraints

- No behavior change except item 4 (cooldown bypass for event-driven checks) and removal of redundant double-stop / redundant enabled pre-check (verdicts unchanged).
- Barrel API (`src/backend/services/ratchet/index.ts` → `service/index.ts`) must not change shape except additive optional parameter on `checkWorkspaceById`.
- All existing tests must pass (adapted mechanically where they touched removed plumbing); `pnpm test`, `pnpm typecheck`, `pnpm check`.
- Commit per task, imperative subject, reference `#1861`.

---

### Task 0: Branch

- [ ] `git switch -c ratchet-flatten-1861`

### Task 1: Flatten `ratchet-pr-state.helpers.ts` + add cooldown bypass param

**Files:**
- Modify: `src/backend/services/ratchet/service/ratchet-pr-state.helpers.ts`
- Modify: `src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts`
- Modify: `src/backend/services/ratchet/service/ratchet.service.ts` (fetchPRState call site)

**Interfaces produced:**
```ts
export function resolveRatchetPrContext(workspace: WorkspaceWithPR, github: RatchetGitHubBridge): { repo: string; prNumber: number } | null
export async function fetchPRState(params: {
  workspace: WorkspaceWithPR;
  authenticatedUsername: string | null;
  github: RatchetGitHubBridge;
  backoff: RateLimitBackoff;
  bypassRecentFetchCooldown?: boolean;
}): Promise<PRStateFetchResult>
```

- [ ] In helpers: add `const logger = createLogger('ratchet');` at module scope; drop `Logger` type/params from `resolveRatchetPrContext` and `fetchPRState`; delete the `computeLatestReviewActivityAtMs`/`computeDispatchSnapshotKey` callback params (call module functions directly); guard cooldown with `if (!params.bypassRecentFetchCooldown && github.isRecentlyFetched(workspace.id))`.
- [ ] In helpers test: remove logger/callback args from `fetchPRState` calls; add tests: (a) `bypassRecentFetchCooldown: true` fetches even when `isRecentlyFetched` returns true and still calls `startFetch`/`registerFetch`; (b) default still skips with `{ skipped: true, reason: 'recently_fetched' }`.
- [ ] In service: private `fetchPRState(workspace, authenticatedUsername, opts?: { bypassRecentFetchCooldown?: boolean })` becomes a 1-call wrapper injecting `this.github`/`this.backoff` only (delete the callback re-injection). Delete now-unused private `computeDispatchSnapshotKey`/`computeLatestReviewActivityAtMs` wrappers and their imports.
- [ ] Run `pnpm vitest run src/backend/services/ratchet` — PASS; commit `Flatten ratchet PR-state helper plumbing (#1861)`.

### Task 2: Flatten active-session + decision-logging helpers; drop pure-function wrappers

**Files:**
- Modify: `ratchet-active-session.helpers.ts`, `ratchet-decision-logging.helpers.ts`, `ratchet.service.ts`, `ratchet.service.test.ts`

- [ ] `checkActiveFixerSession(params: { workspace; sessionBridge })`: module logger; delete `recordSessionEnd` callback — import `workspaceAccessor` and call `workspaceAccessor.recordRatchetSessionEnd` directly. Same file: `hasActiveSession` unchanged.
- [ ] Decision-logging helpers: module logger; drop `logger` from both param bags.
- [ ] Service: delete public `buildRatchetingLogContext` method and private wrappers `shouldSkipCleanPR`, `hasNewReviewActivitySinceLastDispatch`, `determineRatchetState`, `getAuthenticatedUsernameCached` stays (holds cache state), `logWorkspaceRatchetingDecision` becomes direct helper calls; call pr-state helper functions directly at use sites. `checkActiveFixerSession` private method shrinks to inject `this.session` only.
- [ ] Service test: re-point `buildRatchetingLogContext` describe (≈lines 1317–1390) and `determineRatchetState` describe (≈1391+), `computeDispatchSnapshotKey`/`computeLatestReviewActivityAtMs` describes (≈1478–1630) to direct helper imports (or delete where duplicating `ratchet-pr-state.helpers.test.ts`).
- [ ] Run ratchet tests — PASS; commit `Flatten ratchet session/logging helper plumbing (#1861)`.

### Task 3: Flatten fixer-dispatch helpers; remove fixer service's redundant enabled check

**Files:**
- Modify: `ratchet-fixer-dispatch.helpers.ts`, `fixer-session.service.ts`, `fixer-session.service.test.ts`, `ratchet.service.ts`

**Interface produced:**
```ts
export async function triggerRatchetFixer(params: {
  workspace: WorkspaceWithPR;
  prStateInfo: PRStateInfo;
  retryCount: number;
  sessionBridge: RatchetSessionBridge;
}): Promise<RatchetAction>
```

- [ ] Helpers: module logger; import `workspaceAccessor`; replace callbacks with direct calls — `recordRatchetDispatchIfEnabled(workspace.id, { sessionId, snapshotKey: prStateInfo.snapshotKey, retryCount })`, `adoptRatchetActiveSessionIfEnabled`, and clear-active-session via `workspaceAccessor.update(workspaceId, { ratchetActiveSessionId: null })`. Keep the record-failed → stop-session → return-DISABLED reaction (it is the response to the conditional accessor's verdict, the single enforcement point).
- [ ] `fixer-session.service.ts`: delete the `workspace.ratchetEnabled === false` pre-check block (the conditional dispatch record now solely enforces the disable race). Adapt/delete its test.
- [ ] Service `triggerFixer` shrinks to `triggerRatchetFixer({ workspace, prStateInfo, retryCount, sessionBridge: this.session })`; delete private `clearActiveSession`.
- [ ] Run ratchet tests — PASS; commit `Consolidate ratchet disable-race handling onto conditional accessors (#1861)`.

### Task 4: Merge activity collection into `decideRatchetAction`; delete dead disabled gates

**Files:**
- Modify: `ratchet.types.ts`, `ratchet.service.ts`, `ratchet.service.test.ts`

- [ ] `ratchet.types.ts`: remove `finalState` and `hasOtherActiveSession` from `RatchetDecisionContext`.
- [ ] Service: delete `collectHasOtherActiveSession` and `isRetryableDeath`; `buildRatchetDecisionContext` no longer computes them (and drops `finalState`; the `activeFixerCheck` condition drops `workspace.ratchetEnabled &&` — the early disabled branch guarantees enabled here since `findWithPRsForRatchet` filters `ratchetEnabled: true` and `processWorkspace` returns early otherwise).
- [ ] `decideRatchetAction` → `async`, delete its leading DISABLED gate (dead code), and at both dispatch points (fresh dispatch tail and `decideDiedFixerRetry`) replace `context.hasOtherActiveSession` with `await this.hasActiveSession(context.workspace.id)` — placed after all cheaper gates so the common no-op path still issues no DB query.
- [ ] `finishRatchetCheck`: use `newState` where `finalState` was; simplify the `updateApplied` translation to an early `if (!updated) return { …, newState: RatchetState.IDLE, action: DISABLED }` (kept — reacting to the conditional accessor's verdict prevents emitting stale state-change events after a disable race).
- [ ] Tests: drop the two removed fields from all context literals; `await` the now-async `decideRatchetAction`; rewrite the two "other active session" cases to arrange `agentSessionAccessor.findByWorkspaceId` + `mockSessionBridge.isSessionWorking`; delete the decide-level DISABLED expectation if present (covered by `processWorkspace` disabled test).
- [ ] Run ratchet tests — PASS; commit `Merge ratchet activity checks into decideRatchetAction (#1861)`.

### Task 5: Remove `setWorkspaceRatcheting` double session-stop

- [ ] Delete the direct `ratchetActiveSessionId` stop block (service ≈lines 323–334); `stopActiveRatchetSessionsAfterDisable` already stops every RUNNING/IDLE `workflow === 'ratchet'` session, which includes the active one. Adapt toggle tests (≈2445, 2488) to assert the single stop path.
- [ ] Run ratchet tests — PASS; commit `Remove duplicate ratchet session stop on disable (#1861)`.

### Task 6: Event-driven ratchet refresh bypasses PR-fetch cooldown (fix item 4)

**Files:**
- Modify: `ratchet.service.ts` (`checkWorkspaceById`, `runWorkspaceCheckSafely`, `processWorkspace` threading)
- Modify: `src/backend/orchestration/event-collector.orchestrator.ts` (PR-switch/reopen refresh call)
- Test: `ratchet.service.test.ts`, `event-collector.orchestrator.test.ts`

**Interface produced:**
```ts
async checkWorkspaceById(workspaceId: string, opts?: { bypassPrFetchCooldown?: boolean }): Promise<WorkspaceRatchetResult | null>
```

- [ ] Write failing service test: `isRecentlyFetched` mocked true; `checkWorkspaceById(id, { bypassPrFetchCooldown: true })` still fetches (asserts `getPRFullDetails` called / result not `WAITING: recently_fetched`); plain call still skips.
- [ ] Thread `opts` → `runWorkspaceCheckSafely(workspace, opts)` → `processWorkspace(workspace, opts)` → `this.fetchPRState(workspace, username, { bypassRecentFetchCooldown: opts?.bypassPrFetchCooldown })`.
- [ ] Event collector: `ratchetService.checkWorkspaceById(event.workspaceId, { bypassPrFetchCooldown: true })` in the `shouldRefreshRatchet` branch; add/adapt orchestrator test asserting the option is passed.
- [ ] Run tests — PASS; commit `Fix #1861: bypass PR fetch cooldown for event-driven ratchet refresh`.

### Task 7: Full verification & PR

- [ ] `pnpm test` (full), `pnpm typecheck`, `pnpm check`, `pnpm check:fix` — all green.
- [ ] Push branch; `gh pr create` with `--body-file` describing the four issue items, the two intentional deviations (kept the record-failed stop reaction and the `updateApplied` early return — full deletion would leak fixer sessions / emit stale events on the disable race), and `Fixes #1861`.

## Self-Review Notes

- Spec coverage: item 1 → Tasks 1–3; item 2 → Task 4; item 3 → Tasks 3–5; item 4 → Tasks 1+6; "fold disabled branch" → Task 4.
- Deviation from issue text (documented in PR): `recordActiveSessionOrDisable`'s stop-on-failed-record and `finishRatchetCheck`'s no-emit-on-failed-update are *reactions to* the conditional accessors, not parallel defenses; deleting them outright would change behavior (leaked fixer session / stale events), contradicting "no behavior change intended".
