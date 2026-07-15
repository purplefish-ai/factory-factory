# Workspace Notification JSONL Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent pending workspace notifications from being re-enqueued when provider JSONL history already contains the exact delivered user prompt under a provider-generated ID.

**Architecture:** Keep the existing exact queue-ID match as the primary deduplication signal, then fall back to exact canonical prompt-text matching for user transcript entries. Reserve content-fallback matches within one pending-delivery pass so a single JSONL entry cannot satisfy multiple identical notification records.

**Tech Stack:** TypeScript, Vitest, Express backend service capsules, ACP transcript history.

## Global Constraints

- Preserve exact-ID deduplication for live Factory Factory transcript entries.
- Content fallback must examine only `source === 'user'` transcript entries and require exact full prompt-text equality.
- A provider-generated transcript entry may content-match at most one pending notification per delivery pass.
- Do not use timestamps for fallback matching because provider JSONL timestamps represent send time rather than notification creation time.
- Do not change ACP message IDs, provider adapters, database schema, or UI behavior.
- Keep the change within the session lifecycle service and its co-located test.

---

### Task 1: Deduplicate JSONL-Hydrated Notification Prompts

**Files:**
- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.service.ts:974-1085`
- Test: `src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts:320-442`

**Interfaces:**
- Consumes: `SessionDomainService.getTranscriptSnapshot(sessionId: string): ChatMessage[]` and the canonical notification fields already loaded from `workspaceNotificationAccessor.findPending`.
- Produces: private transcript matching that returns a matched transcript entry ID or `undefined`, while `deliverPendingChildNotifications(sessionId, workspaceId): Promise<number>` retains its existing external behavior.

- [ ] **Step 1: Add the provider-ID regression test**

Add a lifecycle test whose pending parent notification has message `Please check the failing test.` and whose transcript contains this user entry:

```typescript
{
  id: '550e8400-e29b-41d4-a716-446655440000-0',
  source: 'user',
  text: '[Message from parent workspace "Parent Workspace"]: Please check the failing test.',
  timestamp: createdAt.toISOString(),
  order: 0,
}
```

Assert that the returned count is `0`, `enqueue`, `appendClaudeEvent`, and `emitDelta` are not called, and `markDelivered` is called with `['notif-parent']`.

- [ ] **Step 2: Run the regression test to verify RED**

Run:

```bash
pnpm vitest run src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts -t 'provider-generated ID'
```

Expected: FAIL because the returned count is `1` and `enqueue` is called.

- [ ] **Step 3: Add negative and one-to-one edge regressions**

Add focused tests that assert:

```typescript
// Different exact user text under a provider ID does not match.
expect(enqueuedCount).toBe(1);
expect(sessionDomainService.enqueue).toHaveBeenCalledOnce();
expect(workspaceNotificationAccessor.markDelivered).not.toHaveBeenCalled();

// Two identical pending rows plus one matching provider user entry consume that entry once.
expect(enqueuedCount).toBe(1);
expect(sessionDomainService.enqueue).toHaveBeenCalledOnce();
expect(workspaceNotificationAccessor.markDelivered).toHaveBeenCalledTimes(1);
```

Use distinct notification IDs for the duplicate-text rows, and assert the first oldest pending row is the one marked delivered because `findPending` is ordered by creation time.

- [ ] **Step 4: Implement the minimal transcript matcher**

In `deliverPendingChildNotifications`, create one set before the loop:

```typescript
const consumedContentMatchIds = new Set<string>();
```

Build `enqueueText` before transcript matching. Replace the boolean helper with a helper shaped as:

```typescript
private findCommittedQueuedWorkspaceNotificationMessage(
  sessionId: string,
  messageId: string,
  messageText: string,
  consumedContentMatchIds: ReadonlySet<string>
): { id: string; matchedByContent: boolean } | undefined
```

The helper must:

1. Restrict candidates to user transcript entries.
2. Return an exact-ID candidate first with `matchedByContent: false`.
3. Otherwise return the first candidate whose `text === messageText` and whose ID is not in `consumedContentMatchIds`, with `matchedByContent: true`.
4. Return `undefined` when neither match exists.

When a match has `matchedByContent: true`, add its ID to `consumedContentMatchIds` before retrying `markDelivered`. Keep the current rule that any transcript match suppresses re-enqueueing even if `markDelivered` fails.

- [ ] **Step 5: Run focused tests to verify GREEN**

Run:

```bash
pnpm vitest run src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts
```

Expected: all tests in the file pass with no failures.

- [ ] **Step 6: Format, inspect, and commit the focused fix**

Run:

```bash
pnpm biome check --write src/backend/services/session/service/lifecycle/session.lifecycle.service.ts src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts
git diff --check
git diff -- src/backend/services/session/service/lifecycle/session.lifecycle.service.ts src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts
git add src/backend/services/session/service/lifecycle/session.lifecycle.service.ts src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts
git commit -m "Fix notification JSONL deduplication (#1844)"
```

Expected: the focused tests and formatting pass, the diff contains only the matching change and regressions, and the commit succeeds.

### Task 2: Verify, Review, and Publish

**Files:**
- Review: all files changed from `origin/main`
- Create temporarily: `/tmp/pr-body.md`

**Interfaces:**
- Consumes: the committed Task 1 behavior and repository verification scripts.
- Produces: a clean pushed branch and a GitHub pull request closing `#1844`.

- [ ] **Step 1: Run the complete required verification chain**

Run exactly:

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```

Expected: exit code `0`. If the known port-allocation test flakes again, rerun the focused failing test to diagnose it and then rerun the complete chain; do not claim the suite passes without a fresh successful full run.

- [ ] **Step 2: Review the complete branch diff**

Run:

```bash
git diff origin/main
git diff --check origin/main
git status --short
```

Expected: no debug logs, commented-out code, unintended formatting, whitespace errors, or unstaged changes.

- [ ] **Step 3: Obtain final code review and address findings**

Review the complete `origin/main...HEAD` change for spec compliance, false-positive deduplication risk, one-to-one matching, and test maintainability. Apply and retest any Critical or Important findings before continuing.

- [ ] **Step 4: Commit any verification formatting changes**

If `pnpm check:fix` changed files, inspect them and commit only in-scope changes:

```bash
git add -p
git commit -m "Format notification deduplication fix (#1844)"
```

Expected: `git status --short` is empty after the commit.

- [ ] **Step 5: Push and create the required pull request**

Create `/tmp/pr-body.md` with:

```markdown
## Summary
- Prevent workspace notifications from being re-enqueued after provider JSONL transcript hydration.
- Preserve exact-ID matching while adding an occurrence-aware exact-text fallback for provider-generated IDs.

## Changes
- **Session lifecycle**: Match committed user prompts by queue ID or canonical notification text without reusing one history entry for multiple notifications.
- **Tests**: Cover provider UUID history, nonmatching text, and duplicate pending notification content.

## Testing
- [x] Tests pass (`pnpm test`)
- [x] Types pass (`pnpm typecheck`)
- [x] Build succeeds (`pnpm build`)
- [ ] Manual testing: Not applicable; backend recovery behavior is covered by lifecycle regressions.

Closes #1844

---
🏭 Forged in [Factory Factory](https://factoryfactory.ai)
```

Then run:

```bash
git push -u origin HEAD
gh pr create --title "Fix #1844: Deduplicate JSONL workspace notifications" --body-file /tmp/pr-body.md
gh pr view --json url,title,state
```

Expected: push succeeds and `gh pr view` returns the new pull request URL in open state.
