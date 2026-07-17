# Auto-Iteration Loop Cleanup Race Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent stale auto-iteration cleanup from deleting a replacement loop registered for the same workspace.

**Architecture:** Centralize map ownership validation in a private `deleteLoopIfCurrent(loop)` helper. Route every asynchronous cleanup deletion through that helper so only the exact `RunningLoop` that initiated cleanup can remove itself.

**Tech Stack:** TypeScript, Vitest, pnpm, Biome

## Global Constraints

- Preserve the one-loop-per-workspace map API and existing status/session persistence behavior.
- Use `RunningLoop` object identity, not mutable session IDs, for asynchronous cleanup ownership.
- Guard every currently unguarded asynchronous map deletion in `AutoIterationService`.
- No UI or database changes.

---

### Task 1: Add stale-cleanup regression coverage

**Files:**
- Modify: `src/backend/services/auto-iteration/service/auto-iteration.service.test.ts`

**Interfaces:**
- Consumes: `AutoIterationService.resume(workspaceId: string): Promise<void>`, `AutoIterationService.onSessionDeath(workspaceId: string, sessionId: string): void`, and private `finalize(loop: RunningLoop, status: AutoIterationStatus): Promise<void>` through the existing test internals pattern.
- Produces: deterministic regression coverage proving an old rejection or finalizer cannot remove a replacement `RunningLoop`.

- [ ] **Step 1: Write a failing stale-rejection test**

Create a deferred rejected `runLoop()` promise, resume an old paused loop, remove it using `onSessionDeath()`, insert a distinct replacement, reject the old promise, then assert `serviceInternals.loops.get('ws-1')` is the replacement.

- [ ] **Step 2: Write a failing stale-finalize test**

Defer `stopSession()`, invoke private `finalize()` for the old loop, wait until cleanup is blocked, remove the old loop using `onSessionDeath()`, insert a distinct replacement, release cleanup, then assert the map still contains the replacement.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `pnpm vitest run src/backend/services/auto-iteration/service/auto-iteration.service.test.ts`

Expected: the two new tests fail because the stale paths delete the replacement by workspace key.

### Task 2: Make cleanup ownership-aware

**Files:**
- Modify: `src/backend/services/auto-iteration/service/auto-iteration.service.ts`
- Test: `src/backend/services/auto-iteration/service/auto-iteration.service.test.ts`

**Interfaces:**
- Consumes: `RunningLoop.workspaceId` and the existing `Map<string, RunningLoop>`.
- Produces: `private deleteLoopIfCurrent(loop: RunningLoop): void`.

- [ ] **Step 1: Add the minimal ownership helper**

```typescript
private deleteLoopIfCurrent(loop: RunningLoop): void {
  if (this.loops.get(loop.workspaceId) === loop) {
    this.loops.delete(loop.workspaceId);
  }
}
```

- [ ] **Step 2: Route all asynchronous cleanup deletions through the helper**

Replace the six unguarded `this.loops.delete(...)` calls in `start()` setup/rejection cleanup, `resume()` rejection cleanup, `resumeFromFailed()` setup/rejection cleanup, and `finalize()` with `this.deleteLoopIfCurrent(...)` using the owning `placeholder` or `loop` object.

- [ ] **Step 3: Run focused tests and verify GREEN**

Run: `pnpm vitest run src/backend/services/auto-iteration/service/auto-iteration.service.test.ts`

Expected: all tests in the file pass.

- [ ] **Step 4: Commit the focused fix**

```bash
git add src/backend/services/auto-iteration/service/auto-iteration.service.ts src/backend/services/auto-iteration/service/auto-iteration.service.test.ts
git commit -m "Fix stale auto-iteration loop cleanup (#1912)"
```

### Task 3: Verify, review, and publish

**Files:**
- Review: all changes relative to `origin/main`
- Create temporarily: `/tmp/pr-body.md`

**Interfaces:**
- Consumes: repository scripts and authenticated `git`/`gh` remotes.
- Produces: a pushed branch and a verified GitHub pull request closing #1912.

- [ ] **Step 1: Run required verification**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`

Expected: all commands exit successfully. If the unchanged baseline `act is not a function` failures remain, investigate environment/dependency setup and report them explicitly before PR creation.

- [ ] **Step 2: Review and commit formatter changes if any**

Run: `git diff origin/main` and `git status --short`

Expected: only the design/plan, service, and service test changes are present; no debug output or unrelated changes remain.

- [ ] **Step 3: Push and create the PR**

Push with `git push -u origin HEAD`, create `/tmp/pr-body.md` with summary, changes, testing, `Closes #1912`, and the required Factory Factory signature, then run:

```bash
gh pr create --title "Fix #1912: prevent stale loop cleanup" --body-file /tmp/pr-body.md
```

- [ ] **Step 4: Verify the PR URL**

Run: `gh pr view --json url --jq .url`

Expected: the new pull request URL.
