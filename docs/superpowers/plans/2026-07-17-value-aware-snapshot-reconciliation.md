# Value-Aware Snapshot Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent unchanged snapshot reconciliation upserts from incrementing versions or emitting deltas while preserving ordering metadata.

**Architecture:** Separate timestamp acceptance from value change inside `WorkspaceSnapshotStore`, where field-group ordering is authoritative. Return an explicit upsert outcome so the reconciliation orchestrator can aggregate changed-workspace and emitted-delta metrics without duplicating equality logic.

**Tech Stack:** TypeScript, Node.js `EventEmitter` and `isDeepStrictEqual`, Vitest, Express backend services.

## Global Constraints

- Equal newer updates must advance field-group timestamps.
- Equal newer updates must not increment `version` or emit `SNAPSHOT_CHANGED` unless their time-sensitive derived candidate changed.
- Structured equality must not use JSON serialization.
- Stale updates and removal tombstones must retain their current ordering guarantees.
- A real change must emit exactly one consistent snapshot delta.
- Reconciliation logs must include `workspacesScanned`, `workspacesChanged`, and `deltasEmitted`.

---

### Task 1: Value-aware snapshot store merging

**Files:**
- Modify: `src/backend/services/workspace-snapshot-store.service.ts`
- Test: `src/backend/services/workspace-snapshot-store.service.test.ts`

**Interfaces:**
- Produces: `SnapshotUpsertResult` with boolean `accepted`, `changed`, and `emitted` properties.
- Produces: `WorkspaceSnapshotStore.upsert(...): SnapshotUpsertResult`.

- [ ] **Step 1: Write failing scalar and ordering tests**

Add tests that seed at timestamp 100, apply an equal scalar update at 200, and assert the workspace group timestamp is 200 while version, metadata, and event count remain unchanged. Then apply a conflicting update at 150 and assert it is rejected.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test src/backend/services/workspace-snapshot-store.service.test.ts`

Expected: FAIL because equal newer upserts currently increment versions and emit events.

- [ ] **Step 3: Write failing structured and race tests**

Add equal and changed cases for `gitStats` and `sessionSummaries`, retain removal/recreation coverage, and add a derived-state-only assertion using a mutable or time-sensitive derivation result with otherwise equal raw fields.

- [ ] **Step 4: Implement accepted-versus-changed merging**

Add `SnapshotUpsertResult`, targeted equality helpers, a merge result carrying timestamp acceptance and raw value change, and derived-candidate assignment that compares structured derived fields without serialization. Return ignored/no-op/changed outcomes from every `upsert` path.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `pnpm test src/backend/services/workspace-snapshot-store.service.test.ts`

Expected: PASS with equal updates producing no event or version change.

- [ ] **Step 6: Commit the store change**

```bash
git add src/backend/services/workspace-snapshot-store.service.ts src/backend/services/workspace-snapshot-store.service.test.ts
git commit -m "Avoid no-op snapshot store updates (#1942)"
```

### Task 2: Reconciliation outcome metrics

**Files:**
- Modify: `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`
- Test: `src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts`

**Interfaces:**
- Consumes: `WorkspaceSnapshotStore.upsert(...): SnapshotUpsertResult`.
- Produces: `ReconciliationResult.workspacesScanned`, `.workspacesChanged`, and `.deltasEmitted`.

- [ ] **Step 1: Write failing reconciliation metric tests**

Make the store mock return explicit outcomes. Assert a pass with unchanged existing fixtures reports scanned workspaces but zero changed workspaces and zero deltas, while a real change reports one of each. Assert the summary logger receives all three fields.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts`

Expected: FAIL because the result and log do not yet expose the metrics.

- [ ] **Step 3: Aggregate outcomes in reconciliation**

Extend `ReconciliationResult` and fallback results, collect each `upsert()` result, increment `workspacesChanged` when `upsertResult.changed` is true, increment `deltasEmitted` when `upsertResult.emitted` is true, count successful stale-removal events separately in `deltasEmitted`, and include the requested fields in the completion log and returned result. Preserve existing result fields for compatibility.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm test src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts`

Expected: PASS with idle fixtures reporting zero changes and deltas.

- [ ] **Step 5: Commit reconciliation metrics**

```bash
git add src/backend/orchestration/snapshot-reconciliation.orchestrator.ts src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts
git commit -m "Report snapshot reconciliation deltas (#1942)"
```

### Task 3: Full verification and pull request

**Files:**
- Review: all files changed from `origin/main`.

**Interfaces:**
- Consumes: completed store and reconciliation behavior.
- Produces: a clean, pushed branch and a draft-ready GitHub pull request closing #1942.

- [ ] **Step 1: Run repository verification**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`

Expected: all commands exit 0.

- [ ] **Step 2: Review the complete diff**

Run: `git diff origin/main` and inspect for unnecessary complexity, debug code, test gaps, and accidental formatting changes.

- [ ] **Step 3: Commit verification-only formatting if needed**

```bash
git add src/backend/services/workspace-snapshot-store.service.ts src/backend/services/workspace-snapshot-store.service.test.ts src/backend/orchestration/snapshot-reconciliation.orchestrator.ts src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts
git commit -m "Format snapshot reconciliation changes (#1942)"
```

- [ ] **Step 4: Push and create the PR**

Push with `git push -u origin HEAD`, create a body containing summary, changes, verification results, `Closes #1942`, and the required Factory Factory signature, then run `gh pr create --title "Fix #1942: Avoid no-op snapshot reconciliation fan-out" --body-file /tmp/pr-body.md`.

- [ ] **Step 5: Verify the PR**

Run: `gh pr view --json url,title,state` and report the created URL.
