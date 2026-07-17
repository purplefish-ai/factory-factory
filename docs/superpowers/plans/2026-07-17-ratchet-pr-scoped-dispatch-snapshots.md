# Ratchet PR-Scoped Dispatch Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ratchet fixer-dispatch deduplication distinguish identical actionable state on different pull requests.

**Architecture:** Keep the persisted snapshot record and comparison unchanged, but make the snapshot itself self-contained by prefixing the resolved pull request number. Generate the key at the existing PR-fetch boundary so every downstream consumer receives the scoped identity automatically.

**Tech Stack:** TypeScript, Vitest, Prisma-backed workspace service, pnpm, Biome

## Global Constraints

- Preserve same-pull-request deduplication and bounded retry behavior.
- Do not add or alter database columns or migrations.
- Keep the existing CI, review-activity, and merge-conflict snapshot segments unchanged.
- Treat legacy unprefixed snapshots as changed on their first comparison with a new prefixed snapshot.

---

### Task 1: Add PR-scoped snapshot regression coverage

**Files:**
- Test: `src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts`
- Test: `src/backend/services/ratchet/service/ratchet.service.test.ts`

**Interfaces:**
- Consumes: `computeDispatchSnapshotKey(prNumber, ciStatus, hasChangesRequested, latestReviewActivityAtMs, statusChecks, hasMergeConflict): string`
- Produces: Regression expectations for key identity and cross-PR fixer dispatch.

- [ ] **Step 1: Add failing snapshot identity tests**

```typescript
it('includes the pull request number', () => {
  expect(computeDispatchSnapshotKey(123, CIStatus.SUCCESS, false, null, null, true)).toBe(
    'pr:123|ci:SUCCESS|no-changes-requested:none|merge:conflict'
  );
});

it('produces different keys for identical state on different pull requests', () => {
  const first = computeDispatchSnapshotKey(123, CIStatus.SUCCESS, false, null, null, true);
  const second = computeDispatchSnapshotKey(456, CIStatus.SUCCESS, false, null, null, true);
  expect(first).not.toBe(second);
});
```

- [ ] **Step 2: Add the cross-PR service regression test**

Create snapshots for pull requests 123 and 456 with otherwise identical successful-CI, no-review-activity, merge-conflict inputs. Set the workspace's completed dispatch snapshot to pull request 123 and mock the current fetched state with pull request 456's snapshot. Call `processWorkspace` and expect a `TRIGGERED_FIXER` action.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `pnpm exec vitest run src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts src/backend/services/ratchet/service/ratchet.service.test.ts`

Expected: FAIL because `computeDispatchSnapshotKey` does not accept or encode `prNumber`.

### Task 2: Scope dispatch snapshots to the resolved pull request

**Files:**
- Modify: `src/backend/services/ratchet/service/ratchet-pr-state.helpers.ts`
- Modify: `src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts`
- Modify: `src/backend/services/ratchet/service/ratchet.service.test.ts`
- Modify: `prisma/schema.prisma` (comment only; no generated-code or migration change)

**Interfaces:**
- Consumes: `resolveRatchetPrContext(workspace, github): { repo: string; prNumber: number } | null`
- Produces: `computeDispatchSnapshotKey(prNumber: number, ciStatus: CIStatus, hasChangesRequested: boolean, latestReviewActivityAtMs: number | null, statusChecks: RatchetStatusCheckRollupItem[] | null, hasMergeConflict?: boolean): string`

- [ ] **Step 1: Add the pull request number to the helper signature and key**

```typescript
export function computeDispatchSnapshotKey(
  prNumber: number,
  ciStatus: CIStatus,
  hasChangesRequested: boolean,
  latestReviewActivityAtMs: number | null,
  statusChecks: RatchetStatusCheckRollupItem[] | null,
  hasMergeConflict?: boolean
): string {
  const ciKey = computeCiSnapshotKey(ciStatus, statusChecks);
  const reviewKey = `${hasChangesRequested ? 'changes-requested' : 'no-changes-requested'}:${
    latestReviewActivityAtMs ?? 'none'
  }`;
  const mergeKey = hasMergeConflict ? 'conflict' : 'clean';
  return `pr:${prNumber}|${ciKey}|${reviewKey}|merge:${mergeKey}`;
}
```

- [ ] **Step 2: Pass the resolved pull request number from `fetchPRState`**

```typescript
const snapshotKey = computeDispatchSnapshotKey(
  prDetails.number,
  ciStatus,
  hasChangesRequested,
  latestReviewActivityAtMs,
  reducedStatusCheckRollup,
  hasMergeConflict
);
```

- [ ] **Step 3: Update existing test callers with explicit pull request numbers**

Use `123` in helper tests and the service test helper so the tests retain their existing state assertions while covering the new required argument.

- [ ] **Step 4: Correct the persisted-field documentation**

Update the `ratchetLastCiRunId` schema comment to describe a full PR dispatch snapshot containing pull request identity, CI signature, review activity, and merge-conflict state. Do not change the field type or create a migration.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm exec vitest run src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts src/backend/services/ratchet/service/ratchet.service.test.ts`

Expected: both files pass, including same-pull-request unchanged-state coverage and the new cross-pull-request regression.

- [ ] **Step 6: Commit the focused implementation**

```bash
git add prisma/schema.prisma src/backend/services/ratchet/service/ratchet-pr-state.helpers.ts src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts src/backend/services/ratchet/service/ratchet.service.test.ts
git commit -m "Scope ratchet snapshots to pull requests (#1899)"
```

### Task 3: Verify, review, and publish

**Files:**
- Review: all changes relative to `origin/main`

**Interfaces:**
- Consumes: the PR-scoped snapshot implementation and regression tests.
- Produces: a clean pushed branch and a pull request closing issue #1899.

- [ ] **Step 1: Run required verification**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`

Expected: every command exits successfully. If the two pre-existing setup-terminal test files still fail with `TypeError: act is not a function`, isolate and report that baseline failure, then verify all issue-scoped ratchet tests separately.

- [ ] **Step 2: Review the complete branch diff**

Run: `git diff origin/main` and `git status --short`.

Expected: only the two planning documents, the schema comment, the snapshot helper, and focused ratchet tests differ from `origin/main`; no debug output or unrelated formatting changes remain.

- [ ] **Step 3: Commit any verification-driven changes**

Stage only intended paths and use a short imperative commit message referencing `#1899`. Confirm `git status --short` is empty afterward.

- [ ] **Step 4: Push and create the required pull request**

Run `git push -u origin HEAD`, write `/tmp/pr-body.md` with Summary, Changes, Testing, `Closes #1899`, and the required Factory Factory signature, then run:

```bash
gh pr create --title "Fix #1899: Scope ratchet snapshots to pull requests" --body-file /tmp/pr-body.md
gh pr view --json url,title,state
```

Expected: GitHub returns the new pull request URL.
