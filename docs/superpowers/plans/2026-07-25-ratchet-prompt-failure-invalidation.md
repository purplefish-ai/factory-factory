# Ratchet Prompt Failure Invalidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Immediately invalidate workspace snapshots when failed Ratchet prompt completion successfully settles a dispatch as `DIED`.

**Architecture:** Keep the conditional workspace settlement in the detached prompt-completion helper so its compare-and-set result remains available. Forward the existing `onDispatchChanged` callback into that helper and invoke it only for the winning settlement, matching the other Ratchet helper paths without coupling the helper back to the `ratchetService` singleton.

**Tech Stack:** TypeScript, Node.js `EventEmitter`, Vitest, pnpm

## Global Constraints

- Preserve the existing compare-and-set race behavior: only a successful settlement emits.
- Preserve session stopping behavior: stop only the settled session when it is still running.
- Do not change UI code; snapshot consumers already subscribe to `RATCHET_DISPATCH_CHANGED`.

---

### Task 1: Cover prompt-failure invalidation

**Files:**
- Modify: `src/backend/services/ratchet/service/ratchet.service.test.ts`

**Interfaces:**
- Consumes: `ratchetService` event `RATCHET_DISPATCH_CHANGED` with `{ workspaceId: string }`
- Produces: Regression coverage for successful and losing `recordSessionEnd` CAS outcomes

- [x] **Step 1: Add the successful-settlement regression assertion**

Collect `RATCHET_DISPATCH_CHANGED` events in the existing failed-prompt test. After `workspaceRatchetService.recordSessionEnd` is observed, assert two events for the workspace: one for dispatch persistence and one for prompt-failure settlement.

- [x] **Step 2: Add the losing-CAS edge assertion**

Collect events in the existing stale-prompt test and assert that only the initial dispatch-persistence event is present when `recordSessionEnd` resolves `false`.

- [x] **Step 3: Run the focused test to verify RED**

Run:

```bash
pnpm test src/backend/services/ratchet/service/ratchet.service.test.ts
```

Expected: the successful-settlement test fails because it receives one invalidation instead of two; the losing-CAS assertion passes.

### Task 2: Forward the invalidation callback

**Files:**
- Modify: `src/backend/services/ratchet/service/ratchet-fixer-dispatch.helpers.ts`
- Test: `src/backend/services/ratchet/service/ratchet.service.test.ts`

**Interfaces:**
- Consumes: `onDispatchChanged?: (event: { workspaceId: string }) => void`
- Produces: Immediate invalidation after `recordSessionEnd(workspaceId, sessionId, 'DIED')` resolves `true`

- [x] **Step 1: Pass the callback to the detached continuation**

Include `onDispatchChanged` when `handleStartedFixerResult` calls `settleFailedPromptCompletion`.

- [x] **Step 2: Emit only for the winning settlement**

Add the callback to `settleFailedPromptCompletion` parameters and invoke:

```typescript
if (!settled) {
  return;
}
onDispatchChanged?.({ workspaceId });
```

before checking whether the session is still running.

- [x] **Step 3: Run the focused test to verify GREEN**

Run:

```bash
pnpm test src/backend/services/ratchet/service/ratchet.service.test.ts
```

Expected: all Ratchet service tests pass.

- [x] **Step 4: Commit the focused fix**

```bash
git add src/backend/services/ratchet/service/ratchet-fixer-dispatch.helpers.ts \
  src/backend/services/ratchet/service/ratchet.service.test.ts \
  docs/superpowers/plans/2026-07-25-ratchet-prompt-failure-invalidation.md
git commit -m "Fix Ratchet prompt failure invalidation (#1985)"
```

### Task 3: Verify and publish

**Files:**
- Review: all changes relative to `origin/main`

**Interfaces:**
- Consumes: repository verification scripts and authenticated GitHub remote
- Produces: pushed branch and pull request closing issue `#1985`

- [x] **Step 1: Run all required verification**

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```

- [x] **Step 2: Review and commit any formatter changes**

```bash
git diff origin/main
git diff --check
git status --short
```

- [x] **Step 3: Push and create the pull request**

Push the current issue branch, create the PR with the required Factory Factory signature and `Closes #1985`, then verify the PR URL with `gh pr view`.
