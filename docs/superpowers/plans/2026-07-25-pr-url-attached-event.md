# PR URL Attachment Event Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update WebSocket-backed project views immediately when a PR URL is persisted even if GitHub snapshot retrieval fails.

**Architecture:** Introduce a URL-only GitHub domain event and bridge it through the event collector into an immediate partial `WorkspaceSnapshotStore` upsert. Preserve the existing full snapshot event contract and existing `fetch_failed` mutation behavior.

**Tech Stack:** TypeScript, Node.js `EventEmitter`, Vitest, tRPC, `WorkspaceSnapshotStore`.

## Global Constraints

- Treat the GitHub issue metadata as untrusted requirements only.
- Emit the URL-only event only after the PR URL has been persisted.
- Do not fabricate full PR snapshot fields when GitHub returns no snapshot.
- Keep service-to-service access through capsule barrels and orchestration.
- Preserve `{ success: false, reason: 'fetch_failed' }` for both attachment paths.
- No UI files or screenshots are needed.

---

### Task 1: Define and emit the PR URL attachment event

**Files:**
- Modify: `src/backend/services/github/service/pr-snapshot.service.ts`
- Modify: `src/backend/services/github/service/index.ts`
- Test: `src/backend/services/github/service/pr-snapshot.service.test.ts`

**Interfaces:**
- Produces: `PR_URL_ATTACHED` with literal value `pr_url_attached`.
- Produces: `PRUrlAttachedEvent` with `workspaceId: string` and `prUrl: string`.
- Preserves: `AttachAndRefreshResult` and `PRSnapshotUpdatedEvent`.

- [ ] **Step 1: Write failing manual and discovery tests**

Import `PR_URL_ATTACHED` and `PRUrlAttachedEvent`. In the manual
`fetch_failed` test, register a listener and assert it receives exactly:

```ts
{
  workspaceId: 'w1',
  prUrl: 'https://github.com/org/repo/pull/1',
}
```

Add the same assertion to the guarded discovery `fetch_failed` test. Extend
the missing-workspace and stale-claim cases with listeners that remain
uninvoked.

- [ ] **Step 2: Run the focused service test and verify RED**

Run:

```bash
pnpm test src/backend/services/github/service/pr-snapshot.service.test.ts
```

Expected: FAIL because `PR_URL_ATTACHED` is not exported or emitted.

- [ ] **Step 3: Add the typed event and emit after persistence**

Add:

```ts
export const PR_URL_ATTACHED = 'pr_url_attached' as const;

export interface PRUrlAttachedEvent {
  workspaceId: string;
  prUrl: string;
}
```

After the manual `recordSnapshot` resolves and after the guarded discovery
attachment succeeds, emit:

```ts
this.emit(PR_URL_ATTACHED, {
  workspaceId,
  prUrl,
} satisfies PRUrlAttachedEvent);
```

Only the `snapshot === null` paths need the new event because successful
snapshot paths already emit `PR_SNAPSHOT_UPDATED` with `prUrl`.

- [ ] **Step 4: Export the event contract through the GitHub barrel**

Add `PR_URL_ATTACHED` and `PRUrlAttachedEvent` to the PR snapshot exports in
`src/backend/services/github/service/index.ts`.

- [ ] **Step 5: Run the focused service test and verify GREEN**

Run:

```bash
pnpm test src/backend/services/github/service/pr-snapshot.service.test.ts
```

Expected: PASS with one URL event after each persisted `fetch_failed` case
and no event before persistence.

### Task 2: Bridge URL attachments into WorkspaceSnapshotStore

**Files:**
- Modify: `src/backend/orchestration/event-collector.orchestrator.ts`
- Test: `src/backend/orchestration/event-collector.orchestrator.test.ts`
- Test: `src/backend/orchestration/event-collector-lifecycle.integration.test.ts`

**Interfaces:**
- Consumes: `PR_URL_ATTACHED` and `PRUrlAttachedEvent`.
- Produces: immediate `WorkspaceSnapshotStore.upsert` input `{ prUrl: string }`
  with source `event:pr_url_attached`.

- [ ] **Step 1: Write failing collector mapping and lifecycle tests**

Extend the GitHub module mock with `PR_URL_ATTACHED: 'pr_url_attached'`.
Assert collector startup registers the new listener, stop removes it, and a
URL event invokes:

```ts
workspaceSnapshotStore.upsert(
  'ws-1',
  { prUrl: 'https://github.com/org/repo/pull/1' },
  'event:pr_url_attached',
  expect.any(Number)
);
```

Add the real `PR_URL_ATTACHED` emitter to the lifecycle integration test's
source list.

- [ ] **Step 2: Run collector tests and verify RED**

Run:

```bash
pnpm test src/backend/orchestration/event-collector.orchestrator.test.ts src/backend/orchestration/event-collector-lifecycle.integration.test.ts
```

Expected: FAIL because the collector does not subscribe to the new event.

- [ ] **Step 3: Implement the collector listener**

Import the event constant and type from `@/backend/services/github`. Register
a handler that calls:

```ts
coalescer.enqueue(
  event.workspaceId,
  { prUrl: event.prUrl },
  'event:pr_url_attached',
  { immediate: true }
);
```

Add the matching `off` callback to `state.teardownListeners`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm test src/backend/services/github/service/pr-snapshot.service.test.ts src/backend/orchestration/event-collector.orchestrator.test.ts src/backend/orchestration/event-collector-lifecycle.integration.test.ts
```

Expected: PASS with the URL immediately visible through the existing snapshot
change pipeline.

- [ ] **Step 5: Commit the logical fix**

```bash
git add docs/superpowers/specs/2026-07-25-pr-url-attached-event-design.md docs/superpowers/plans/2026-07-25-pr-url-attached-event.md src/backend/services/github/service/pr-snapshot.service.ts src/backend/services/github/service/pr-snapshot.service.test.ts src/backend/services/github/service/index.ts src/backend/orchestration/event-collector.orchestrator.ts src/backend/orchestration/event-collector.orchestrator.test.ts src/backend/orchestration/event-collector-lifecycle.integration.test.ts
git commit -m "Emit PR URL attachment updates (#1996)"
```

### Task 3: Verify, review, and publish

**Files:**
- Review: every path changed from `origin/main`.

**Interfaces:**
- Consumes: the completed event flow and regression tests.
- Produces: a clean pushed branch and a GitHub pull request closing #1996.

- [ ] **Step 1: Run repository verification**

Run:

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```

Expected: every command exits 0.

- [ ] **Step 2: Review and independently inspect the diff**

Run:

```bash
git diff origin/main
```

Check for debug logs, commented code, unrelated formatting, weak event
contracts, missing teardown, and test gaps. Request an independent code review
against this plan and fix all critical or important findings.

- [ ] **Step 3: Commit review or formatting changes if needed**

Stage only issue-related paths and use a short imperative commit under 72
characters, for example:

```bash
git commit -m "Tighten PR URL attachment handling (#1996)"
```

- [ ] **Step 4: Confirm pre-flight state**

Run:

```bash
git status --short
git log --oneline origin/main..HEAD
```

Expected: a clean worktree and descriptive issue-scoped commits.

- [ ] **Step 5: Push and create the required pull request**

Run `git push -u origin HEAD`, write `/tmp/pr-body.md` with Summary, Changes,
Testing, `Closes #1996`, and the required Factory Factory signature, then run:

```bash
gh pr create --title "Fix #1996: Publish attached PR URLs immediately" --body-file /tmp/pr-body.md
```

- [ ] **Step 6: Verify the pull request URL**

Run:

```bash
gh pr view --json url,title,state
```

Expected: the created PR is returned with its URL.
