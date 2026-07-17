# Shared Workspace Snapshot Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Share the workspace snapshot protocol and update all snapshot-backed workspace caches through typed, centralized projections.

**Architecture:** A framework-neutral shared Zod module is the only transport contract. The backend store and WebSocket handler consume that module, while one client projection module maps entries into tRPC-inferred sidebar, kanban, and detail cache shapes.

**Tech Stack:** TypeScript, Zod, tRPC inferred outputs, React Query cache utilities, Vitest, WebSocket JSON transport.

## Global Constraints

- Preserve reconnect healing, optimistic ratchet overrides, removals, optional review counts, kanban membership, and pending-request attention behavior.
- Preserve DB-backed `stateComputedAt`; map snapshot `computedAt` to `snapshotComputedAt`.
- Preserve existing DB-only cache fields on snapshot deltas.
- Do not introduce `Record<string, unknown>` or `as never` in snapshot synchronization.
- Do not add a normalized fourth cache in this change.

---

### Task 1: Shared snapshot transport contract

**Files:**
- Create: `src/shared/workspace-snapshot.ts`
- Create: `src/shared/workspace-snapshot.test.ts`
- Modify: `src/backend/services/workspace-snapshot-store.service.ts`
- Modify: `src/backend/routers/websocket/snapshots.handler.ts`
- Modify: `src/backend/routers/websocket/snapshots.handler.test.ts`

**Interfaces:**
- Produces: `WorkspaceSnapshotEntrySchema`, `WorkspaceSnapshotEntry`, `SnapshotServerMessageSchema`, `SnapshotFullMessage`, `SnapshotChangedMessage`, and `SnapshotRemovedMessage`.
- Preserves: backend re-exports of `SnapshotFieldGroup` and `WorkspaceSnapshotEntry`.

- [ ] **Step 1: Write shared-schema RED tests**

Add a valid complete snapshot factory, parse all three message variants, and assert parsing rejects `status: 'ACTIVE'`, `flowPhase: null`, and a `fieldTimestamps` object missing `reconciliation`.

- [ ] **Step 2: Verify RED**

Run: `pnpm test src/shared/workspace-snapshot.test.ts`

Expected: FAIL because `@/shared/workspace-snapshot` does not exist.

- [ ] **Step 3: Implement the shared schemas**

Define exact nested schemas using shared enum values and inferred types. Define full/change/removal message schemas and their discriminated union in the same module.

- [ ] **Step 4: Move backend ownership to the shared type**

Import and re-export `SnapshotFieldGroup` and `WorkspaceSnapshotEntry` from the shared module. Keep `SnapshotUpdateInput` and store events local. Replace anonymous handler payload records with `SnapshotChangedMessage` or `SnapshotRemovedMessage`, and type the full baseline as `SnapshotFullMessage` before serialization.

- [ ] **Step 5: Make backend tests consume the shared schema**

Parse emitted full/change/removal JSON with `SnapshotServerMessageSchema` and add a store test that parses a produced entry with `WorkspaceSnapshotEntrySchema`.

- [ ] **Step 6: Verify GREEN**

Run: `pnpm test src/shared/workspace-snapshot.test.ts src/backend/routers/websocket/snapshots.handler.test.ts src/backend/services/workspace-snapshot-store.service.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the shared contract**

```bash
git add src/shared/workspace-snapshot.ts src/shared/workspace-snapshot.test.ts src/backend/services/workspace-snapshot-store.service.ts src/backend/routers/websocket/snapshots.handler.ts src/backend/routers/websocket/snapshots.handler.test.ts
git commit -m "Share workspace snapshot protocol (#1959)"
```

### Task 2: Central typed cache projections

**Files:**
- Create: `src/client/lib/snapshot-to-workspace.ts`
- Create: `src/client/lib/snapshot-to-workspace.test.ts`
- Delete: `src/client/lib/snapshot-to-sidebar.ts`
- Delete: `src/client/lib/snapshot-to-sidebar.test.ts`
- Delete: `src/client/lib/snapshot-to-kanban.ts`
- Delete: `src/client/lib/snapshot-to-kanban.test.ts`
- Modify: `src/client/hooks/use-project-snapshot-sync.ts`
- Modify: `src/client/hooks/use-project-snapshot-sync.test.ts`

**Interfaces:**
- Consumes: `WorkspaceSnapshotEntry` from `@/shared/workspace-snapshot`.
- Produces: `projectSnapshotToSidebarWorkspace`, `projectSnapshotToKanbanWorkspace`, and `mergeProjectSnapshotIntoWorkspaceDetail` with tRPC-inferred output types.

- [ ] **Step 1: Write projection RED tests**

Test common real-time fields once across all three projections, `createdAt` conversion, `snapshotComputedAt`, preservation of `stateComputedAt`, preservation of DB-only issue/creation/parent fields, typed new-kanban defaults, and detail behavior when the cache is absent.

- [ ] **Step 2: Verify RED**

Run: `pnpm test src/client/lib/snapshot-to-workspace.test.ts`

Expected: FAIL because the consolidated projection module does not exist.

- [ ] **Step 3: Implement the common base and extensions**

Use `inferRouterOutputs<AppRouter>` aliases for summary, kanban, and detail entries. Build the shared real-time projection once, spread existing cache entries before it, and add only each view's renamed or defaulted fields.

- [ ] **Step 4: Rewrite cache synchronization with inferred types**

Import the shared message schema directly. Type each cache helper from router outputs, replace record lookups and object casts with `.id`, remove every snapshot-sync `as never`, and preserve full/change/remove, reconnect, ratchet, review-count, and attention ordering.

- [ ] **Step 5: Update fixtures and imports**

Import `WorkspaceSnapshotEntry` from the shared module, replace invalid fixture status `ACTIVE` with `READY`, and remove the superseded projection modules/tests.

- [ ] **Step 6: Verify GREEN and acceptance behavior**

Run: `pnpm test src/client/lib/snapshot-to-workspace.test.ts src/client/hooks/use-project-snapshot-sync.test.ts`

Expected: PASS, including reconnect healing, optimistic ratchet, removal, and pending-request tests.

- [ ] **Step 7: Commit typed projections**

```bash
git add src/client/lib/snapshot-to-workspace.ts src/client/lib/snapshot-to-workspace.test.ts src/client/hooks/use-project-snapshot-sync.ts src/client/hooks/use-project-snapshot-sync.test.ts src/client/lib/snapshot-to-sidebar.ts src/client/lib/snapshot-to-sidebar.test.ts src/client/lib/snapshot-to-kanban.ts src/client/lib/snapshot-to-kanban.test.ts
git commit -m "Unify snapshot cache projections (#1959)"
```

### Task 3: Verification and pull request

**Files:**
- Review: all files changed from `origin/main`.

**Interfaces:**
- Produces: a clean pushed branch and GitHub pull request closing #1959.

- [ ] **Step 1: Run required repository verification**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`

Expected: all commands exit 0. If the two baseline setup-terminal test files still fail with `act is not a function`, confirm the same failure on `origin/main` or correct only an in-scope dependency/environment cause before proceeding.

- [ ] **Step 2: Review the complete diff**

Run: `git diff origin/main` and inspect for duplicated literals, unsafe casts, dropped DB-only fields, debug code, and unrelated formatting.

- [ ] **Step 3: Commit verification-only changes if needed**

```bash
git add docs/superpowers/specs/2026-07-17-workspace-snapshot-contract-design.md docs/superpowers/plans/2026-07-17-workspace-snapshot-contract.md src/shared/workspace-snapshot.ts src/shared/workspace-snapshot.test.ts src/backend/services/workspace-snapshot-store.service.ts src/backend/routers/websocket/snapshots.handler.ts src/backend/routers/websocket/snapshots.handler.test.ts src/client/lib/snapshot-to-workspace.ts src/client/lib/snapshot-to-workspace.test.ts src/client/hooks/use-project-snapshot-sync.ts src/client/hooks/use-project-snapshot-sync.test.ts
git commit -m "Polish workspace snapshot contracts (#1959)"
```

- [ ] **Step 4: Push and create the pull request**

Push with `git push -u origin HEAD`. Write `/tmp/pr-body.md` with summary, changes, exact test results, `Closes #1959`, and the required Factory Factory signature. Create the PR with `gh pr create --title "Fix #1959: Share workspace snapshot contracts" --body-file /tmp/pr-body.md`.

- [ ] **Step 5: Verify the pull request**

Run: `gh pr view --json url,title,state` and report the URL.
