# Failed Dispatch Rejection Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve unexpired failed-dispatch recovery records across inactive session-store eviction so reconnects can restore drafts for the existing 60-second window.

**Architecture:** Make store clearing optionally retain only unexpired `recentRejections` while rebuilding every other field from the registry's default state. Opt into that behavior only from lifecycle and WebSocket inactivity eviction; destructive deletion and rollback paths keep the current full clear.

**Tech Stack:** TypeScript, Express/WebSocket backend services, Vitest, pnpm

## Global Constraints

- Default `clearSession(sessionId)` behavior must remain a full destructive clear.
- Preserve only entries with `expiresAt > Date.now()`.
- Reset transcript, queue, pending requests, runtime, hydration state, ordering, initial messages, and history-retry cooldowns.
- Preserve both `REJECTED` and `FAILED` record shapes without changing the 60-second TTL or 100-record cap.
- Prune preserved payloads at their expiry and delete an untouched preservation-only store without deleting a reactivated store.
- Destructively clear transient ratchet session state immediately after its database row is deleted.
- Do not change viewer counting, runtime-running guards, client replay protocol, or UI behavior.

---

### Task 1: Add opt-in rejection-preserving store clear

**Files:**
- Modify: `src/backend/services/session/service/store/session-store-registry.ts`
- Test: `src/backend/services/session/service/store/session-store-registry.test.ts`
- Modify: `src/backend/services/session/service/session-domain.service.ts`
- Test: `src/backend/services/session/service/session-domain.service.test.ts`

**Interfaces:**
- Consumes: `SessionStore.recentRejections` and each record's numeric `expiresAt`.
- Produces: `clearSession(sessionId: string, options?: { preserveRejections?: boolean }): void` on both `SessionStoreRegistry` and `SessionDomainService`.

- [ ] **Step 1: Write the failing registry test**

Add a test that fixes `Date.now()`, populates one active and one expired
rejection plus unrelated queue/runtime state, calls:

```ts
registry.clearSession('session-1', { preserveRejections: true });
```

Then assert the recreated store contains only the literal active rejection,
has an empty queue, has the initial runtime state, and no longer has its
history-retry cooldown.

- [ ] **Step 2: Run the registry test to verify RED**

Run:

```bash
pnpm exec vitest run src/backend/services/session/service/store/session-store-registry.test.ts
```

Expected: the preservation assertion fails because the current implementation
deletes the full store and ignores the second argument.

- [ ] **Step 3: Implement the minimal registry option**

Change the signature to:

```ts
clearSession(sessionId: string, options?: { preserveRejections?: boolean }): void
```

Before deletion, filter the existing store's rejections with:

```ts
const rejectionsToPreserve = options?.preserveRejections
  ? this.stores
      .get(sessionId)
      ?.recentRejections.filter((rejection) => rejection.expiresAt > Date.now())
  : undefined;
```

Delete the cooldown and store as today. If the filtered array is non-empty,
create a fresh store through `getOrCreate` and assign the filtered records.
Track that exact store as preservation-only and schedule an unref'ed timer for
the earliest expiry. The timer must filter expired records, reschedule for the
next record, and delete the store only when the same store instance remains
preservation-only. Any later `getOrCreate` marks it reactivated so the timer
prunes payloads without deleting newer state. Default and all-session clears
cancel timers.

- [ ] **Step 4: Run the registry test to verify GREEN**

Run:

```bash
pnpm exec vitest run src/backend/services/session/service/store/session-store-registry.test.ts
```

Expected: all registry tests pass.

- [ ] **Step 4a: Verify expiry and destructive-clear boundaries**

Add fake-timer tests proving:

- default `clearSession(sessionId)` removes an unexpired rejection;
- an untouched preservation-only store has no rejection after expiry;
- a reactivated store keeps its new queue state while its expired rejection
  payload is pruned.

Run the registry test file and expect all cases to pass.

- [ ] **Step 5: Write the failing domain replay test**

Record a failed message with literal draft text and attachment data, add a
queued message and initial message, then call:

```ts
sessionDomainService.clearSession('s1', { preserveRejections: true });
```

Subscribe and assert the replay contains this exact recovery event:

```ts
{
  type: 'message_state_changed',
  id: 'failed-after-crash',
  newState: 'FAILED',
  errorMessage: 'runtime crashed',
  userMessage: {
    text: 'recover this draft',
    timestamp: '2026-07-29T12:00:00.000Z',
    attachments: [attachment],
    sessionId: 's1',
  },
}
```

Also assert queue length is zero and `consumeInitialMessage('s1')` is null.

- [ ] **Step 6: Run the domain test to verify RED**

Run:

```bash
pnpm exec vitest run src/backend/services/session/service/session-domain.service.test.ts
```

Expected: the replay lacks `failed-after-crash` because the domain service has
not forwarded the option.

- [ ] **Step 7: Forward the domain option**

Change the domain signature to:

```ts
clearSession(sessionId: string, options?: { preserveRejections?: boolean }): void
```

Keep deleting `initialMessages`, then call:

```ts
this.registry.clearSession(sessionId, options);
```

- [ ] **Step 8: Run focused domain and registry tests**

Run:

```bash
pnpm exec vitest run \
  src/backend/services/session/service/store/session-store-registry.test.ts \
  src/backend/services/session/service/session-domain.service.test.ts
```

Expected: both files pass.

### Task 2: Preserve rejections in every inactive eviction path

**Files:**
- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.service.ts`
- Test: `src/backend/services/session/service/lifecycle/session.service.test.ts`
- Modify: `src/backend/routers/websocket/chat.handler.ts`
- Test: `src/backend/routers/websocket/chat.handler.test.ts`

**Interfaces:**
- Consumes: `SessionDomainService.clearSession(sessionId, { preserveRejections: true })` from Task 1.
- Produces: inactivity cleanup that resets ordinary store state without deleting reconnect recovery records.

- [ ] **Step 1: Write the failing lifecycle race test**

Create a normal ACP session and capture its `onExit` handler. Replace the exit
repository update with a deferred promise, start `onExit`, and wait until it is
paused at that update. During the pause, call `failMessage` with literal draft
content. Resolve the repository update, await exit cleanup, then subscribe and
assert the exact `FAILED` recovery event is replayed.

This test catches removing the preservation option from runtime-exit cleanup.

- [ ] **Step 2: Run the lifecycle test to verify RED**

Run:

```bash
pnpm exec vitest run src/backend/services/session/service/lifecycle/session.service.test.ts
```

Expected: the recovery event is missing after `onExit` finishes.

- [ ] **Step 3: Enable preserving lifecycle cleanup**

In `clearSessionStoreIfInactive`, keep both guards and call:

```ts
this.sessionDomainService.clearSession(sessionId, { preserveRejections: true });
```

Update the existing manual-stop cleanup expectation to include the option.
After a transient ratchet session's database row is successfully deleted in
either manual-stop or runtime-exit cleanup, call the one-argument destructive
`clearSession(sessionId)` before the shared inactivity cleanup. Tests must prove
the destructive clear occurs after each database delete. If persistence or
deletion fails, do not destructively clear because the session row remains.

- [ ] **Step 4: Run lifecycle tests to verify GREEN**

Run:

```bash
pnpm exec vitest run src/backend/services/session/service/lifecycle/session.service.test.ts
```

Expected: all lifecycle tests pass, including the crash interleaving.

- [ ] **Step 5: Write failing WebSocket inactivity expectations**

In the existing no-runtime/no-viewer disconnect tests, assert both immediate and
deferred cleanup call:

```ts
expect(clearSessionSpy).toHaveBeenCalledWith(sessionId, {
  preserveRejections: true,
});
```

The deferred test must close the socket while a message is in flight and verify
cleanup occurs only after that handler settles.

- [ ] **Step 6: Run the WebSocket tests to verify RED**

Run:

```bash
pnpm exec vitest run src/backend/routers/websocket/chat.handler.test.ts
```

Expected: call-argument assertions fail because cleanup currently performs the
default destructive clear.

- [ ] **Step 7: Enable preserving WebSocket cleanup**

Change only the inactive disconnect call to:

```ts
sessionDomainService.clearSession(dbSessionId, { preserveRejections: true });
```

- [ ] **Step 8: Run all focused regression tests**

Run:

```bash
pnpm exec vitest run \
  src/backend/services/session/service/store/session-store-registry.test.ts \
  src/backend/services/session/service/session-domain.service.test.ts \
  src/backend/services/session/service/lifecycle/session.service.test.ts \
  src/backend/routers/websocket/chat.handler.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 9: Commit the bug fix**

```bash
git add \
  src/backend/services/session/service/store/session-store-registry.ts \
  src/backend/services/session/service/store/session-store-registry.test.ts \
  src/backend/services/session/service/session-domain.service.ts \
  src/backend/services/session/service/session-domain.service.test.ts \
  src/backend/services/session/service/lifecycle/session.lifecycle.service.ts \
  src/backend/services/session/service/lifecycle/session.service.test.ts \
  src/backend/routers/websocket/chat.handler.ts \
  src/backend/routers/websocket/chat.handler.test.ts
git commit -m "Preserve failed dispatch drafts on cleanup (#2061)"
```

### Task 3: Verify, review, and publish

**Files:**
- Review: all files changed against `origin/main`
- Create temporarily: `/tmp/pr-body.md`

**Interfaces:**
- Consumes: committed implementation from Tasks 1-2.
- Produces: a pushed issue branch and verified GitHub pull request closing #2061.

- [ ] **Step 1: Run the required verification chain**

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```

Expected: exit code 0. If the known service-accessor boundary tests time out
under full-suite process contention, rerun that file alone, record both pieces
of evidence, then rerun the required full test command before publishing.

- [ ] **Step 2: Inspect formatting changes and commit if needed**

```bash
git status --short
git diff
```

Stage only issue-related formatting changes and commit them with an imperative
message under 72 characters.

- [ ] **Step 3: Review the full branch diff**

```bash
git diff --check origin/main
git diff --stat origin/main
git diff origin/main
```

Remove debug output, ambiguous naming, or unnecessary complexity, then rerun
focused tests after any edit.

- [ ] **Step 4: Request independent code review**

Ask a read-only reviewer to compare `origin/main` with `HEAD` against issue
#2061 and this plan. Resolve all critical and important findings, then rerun the
required verification chain if code changes.

- [ ] **Step 5: Confirm clean publish state**

```bash
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: clean worktree with descriptive commits only for this issue.

- [ ] **Step 6: Push the branch**

```bash
git push -u origin HEAD
```

- [ ] **Step 7: Create the required PR body**

Write `/tmp/pr-body.md` with Summary, Changes, Testing, `Closes #2061`, and this
exact final signature:

```markdown
---
🏭 Forged in [Factory Factory](https://factoryfactory.ai)
```

- [ ] **Step 8: Create and verify the pull request**

```bash
gh pr create \
  --title "Fix #2061: Preserve failed drafts after runtime crashes" \
  --body-file /tmp/pr-body.md
gh pr view --json number,title,url,state,headRefName,baseRefName
```

Expected: an open PR from the issue branch to the repository default branch,
with its URL printed for handoff.
