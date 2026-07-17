# Kanban Next-Action Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `WORKING`, `WAITING`, and `DONE` represent next-action ownership while keeping live agent execution as a separate session-only signal.

**Architecture:** Keep `deriveWorkspaceFlowState` responsible for PR/CI/Ratchet automation progress, and make `computeKanbanColumn` combine that flow activity with lifecycle, live session activity, explicit human blockers, and exhausted Ratchet dispatch state. Thread the existing dispatch outcome/retry fields through the in-memory snapshot and publish dispatch changes through the Ratchet event boundary so live and cached projections converge immediately.

**Tech Stack:** TypeScript, Express service capsules, Prisma-generated types, EventEmitter orchestration, Vitest, Biome, pnpm.

## Global Constraints

- `WorkspaceDerivedState.isWorking` remains session-only; CI and Ratchet flow must not set it to true.
- `ARCHIVING` and `ARCHIVED` return `null`, and merged/closed PRs return `DONE` before other rules.
- `FAILED`, pending interactive requests, session runtime errors, and exhausted `DIED` dispatches are human-owned `WAITING` states.
- `NEW`, `PROVISIONING`, active sessions, `CI_WAIT`, `RATCHET_VERIFY`, and `RATCHET_FIXING` are `WORKING` unless a higher-priority human-attention rule applies.
- `COMPLETED` does not by itself move a workspace to `WAITING`.
- Ratchet exhaustion uses `SERVICE_THRESHOLDS.ratchetDispatchMaxRetries`; do not duplicate the numeric limit.
- No Prisma migration, poll-frequency change, new Kanban column, or Ratchet dispatch-policy change.
- Service consumers continue importing capsule APIs through barrel files.

---

### Task 1: Canonical next-action ownership derivation

**Files:**
- Modify: `src/backend/services/workspace/service/state/kanban-state.ts`
- Modify: `src/backend/services/workspace/service/state/kanban-state.test.ts`
- Modify: `src/backend/lib/workspace-derived-state.ts`
- Modify: `src/backend/lib/workspace-derived-state.test.ts`
- Modify: `src/backend/services/workspace/service/query/workspace-query.service.ts`
- Modify: `src/backend/services/workspace/service/query/workspace-query.service.test.ts`
- Modify: `src/backend/services/workspace/service/lifecycle/state-machine.service.ts`
- Modify: `src/backend/services/workspace/service/lifecycle/state-machine.service.test.ts`
- Modify: `src/backend/services/workspace-snapshot-store.service.ts`

**Interfaces:**
- Consumes: `WorkspaceFlowState.isWorking`, `WorkspacePendingRequestType`, Prisma `RatchetDispatchOutcome`, and `SERVICE_THRESHOLDS.ratchetDispatchMaxRetries`.
- Produces: a pure `computeKanbanColumn(input: KanbanStateInput): KanbanColumn | null` whose input separates `sessionIsWorking` from `flowIsWorking` and carries explicit human-attention state.

- [ ] **Step 1: Expand the existing Kanban tests with precedence-focused failing tests**

Add a local input builder to `kanban-state.test.ts` and test terminal, human-owned, and automation-owned cases without mocks:

```ts
function makeInput(overrides: Partial<KanbanStateInput> = {}): KanbanStateInput {
  return {
    lifecycle: WorkspaceStatus.READY,
    sessionIsWorking: false,
    flowIsWorking: false,
    prState: PRState.NONE,
    ratchetState: RatchetState.IDLE,
    pendingRequestType: null,
    hasSessionRuntimeError: false,
    ratchetDispatchOutcome: null,
    ratchetDispatchRetryCount: 0,
    ...overrides,
  };
}
```

Required assertions:

```ts
expect(computeKanbanColumn(makeInput({ lifecycle: WorkspaceStatus.FAILED }))).toBe('WAITING');
expect(computeKanbanColumn(makeInput({ flowIsWorking: true }))).toBe('WORKING');
expect(
  computeKanbanColumn(
    makeInput({
      ratchetState: RatchetState.CI_FAILED,
      flowIsWorking: true,
      ratchetDispatchOutcome: 'DIED',
      ratchetDispatchRetryCount: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
    })
  )
).toBe('WAITING');
expect(
  computeKanbanColumn(
    makeInput({ flowIsWorking: true, pendingRequestType: 'permission_request' })
  )
).toBe('WAITING');
```

Also cover `NEW`, `PROVISIONING`, active session, runtime error, `COMPLETED`, merged, closed, and archived.

In the service tests, add full persisted-workspace cases proving `updateCachedKanbanColumn` writes `WORKING` for pending CI with no live session and `WAITING` for a `DIED` dispatch at the retry limit.

- [ ] **Step 2: Add a failing derived-state regression test for the reported transition**

In `workspace-derived-state.test.ts`, pass `sessionIsWorking: false` and `flowState.isWorking: true`, then assert:

```ts
expect(result.isWorking).toBe(false);
expect(result.kanbanColumn).toBe(KanbanColumn.WORKING);
expect(computeKanbanColumn).toHaveBeenCalledWith(
  expect.objectContaining({ sessionIsWorking: false, flowIsWorking: true })
);
```

Include required dispatch defaults on every `WorkspaceDerivedStateInput` fixture.

- [ ] **Step 3: Run the focused tests and verify the new expectations fail for the intended reason**

Run:

```bash
pnpm exec vitest run \
  src/backend/services/workspace/service/state/kanban-state.test.ts \
  src/backend/lib/workspace-derived-state.test.ts
```

Expected: failures show `FAILED` still returns `WORKING`, flow-only ownership returns `WAITING`, or the new input properties are absent from the current interface.

- [ ] **Step 4: Implement the pure ownership rules**

Change `KanbanStateInput` to the following shape and implement the precedence literally:

```ts
export interface KanbanStateInput {
  lifecycle: WorkspaceStatus;
  sessionIsWorking: boolean;
  flowIsWorking: boolean;
  prState: PRState;
  ratchetState: RatchetState;
  pendingRequestType: WorkspacePendingRequestType | null;
  hasSessionRuntimeError: boolean;
  ratchetDispatchOutcome: RatchetDispatchOutcome | null;
  ratchetDispatchRetryCount: number;
}

const retriesExhausted =
  input.ratchetDispatchOutcome === 'DIED' &&
  input.ratchetDispatchRetryCount >= SERVICE_THRESHOLDS.ratchetDispatchMaxRetries;
```

Order the branches as archived, done, human attention, initializing/automation, fallback waiting. Update the function comment to define columns by next-action ownership.

- [ ] **Step 5: Keep session activity separate in the canonical derived-state assembler**

Extend `WorkspaceDerivedStateInput` with:

```ts
ratchetDispatchOutcome: RatchetDispatchOutcome | null;
ratchetDispatchRetryCount: number;
```

Keep `const isWorking = input.sessionIsWorking`, but call the Kanban function with:

```ts
kanbanColumn: fns.computeKanbanColumn({
  lifecycle: input.lifecycle,
  sessionIsWorking: input.sessionIsWorking,
  flowIsWorking: input.flowState.isWorking,
  prState: input.prState,
  ratchetState: input.ratchetState,
  pendingRequestType: input.pendingRequestType,
  hasSessionRuntimeError: input.hasSessionRuntimeError ?? false,
  ratchetDispatchOutcome: input.ratchetDispatchOutcome,
  ratchetDispatchRetryCount: input.ratchetDispatchRetryCount,
}),
```

- [ ] **Step 6: Update all direct derivation call sites**

For full workspace rows, pass `workspace.ratchetDispatchOutcome` and `workspace.ratchetDispatchRetryCount`. Use `runtimeState.isSessionWorking` and `runtimeState.flowState.isWorking`, not `runtimeState.isWorking`, for the two independent activity inputs.

For lifecycle cache transitions, derive flow from the workspace PR/Ratchet fields, pass `sessionIsWorking: false`, and pass `pendingRequestType: null` plus `hasSessionRuntimeError: false` because those are in-memory overlays. Until Task 2 adds raw dispatch fields to `WorkspaceSnapshotEntry`, the snapshot-store call site must explicitly pass `ratchetDispatchOutcome: null` and `ratchetDispatchRetryCount: 0`; do not substitute the derived `isWorking` field.

- [ ] **Step 7: Update query/lifecycle tests and verify Task 1 is green**

Change lifecycle expectations so `PROVISIONING -> FAILED` writes `cachedKanbanColumn: 'WAITING'`. Add a query-service case with pending CI, no working session, and assert `isWorking: false` plus `cachedKanbanColumn: 'WORKING'`.

Run:

```bash
pnpm exec vitest run \
  src/backend/services/workspace/service/state/kanban-state.test.ts \
  src/backend/lib/workspace-derived-state.test.ts \
  src/backend/services/workspace/service/query/workspace-query.service.test.ts \
  src/backend/services/workspace/service/lifecycle/state-machine.service.test.ts
```

Expected: all selected files pass.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/backend/services/workspace/service/state/kanban-state.ts \
  src/backend/services/workspace/service/state/kanban-state.test.ts \
  src/backend/lib/workspace-derived-state.ts \
  src/backend/lib/workspace-derived-state.test.ts \
  src/backend/services/workspace/service/query/workspace-query.service.ts \
  src/backend/services/workspace/service/query/workspace-query.service.test.ts \
  src/backend/services/workspace/service/lifecycle/state-machine.service.ts \
  src/backend/services/workspace/service/lifecycle/state-machine.service.test.ts \
  src/backend/services/workspace-snapshot-store.service.ts
git commit -m "Derive Kanban columns from next-action ownership"
```

---

### Task 2: Persist Ratchet dispatch state in workspace snapshots

**Files:**
- Modify: `src/backend/services/workspace-snapshot-store.service.ts`
- Modify: `src/backend/services/workspace-snapshot-store.service.test.ts`
- Modify: `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`
- Modify: `src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts`

**Interfaces:**
- Consumes: persisted `Workspace.ratchetDispatchOutcome` and `Workspace.ratchetDispatchRetryCount`.
- Produces: `WorkspaceSnapshotEntry.ratchetDispatchOutcome`, `WorkspaceSnapshotEntry.ratchetDispatchRetryCount`, and matching optional `SnapshotUpdateInput` fields in the Ratchet timestamp group.

- [ ] **Step 1: Add failing snapshot-store ownership transition tests**

Configure the real derivation functions and seed a ready workspace with an open PR, no session activity, Ratchet enabled, `ratchetDispatchOutcome: null`, and retry count `0`. Apply updates representing:

```ts
{ prCiStatus: 'PENDING', ratchetState: 'CI_RUNNING' } // WORKING
{ prCiStatus: 'FAILURE', ratchetState: 'CI_RUNNING' } // WORKING / verify
{ ratchetState: 'CI_FAILED', ratchetDispatchOutcome: 'RUNNING' } // WORKING
{
  ratchetState: 'CI_FAILED',
  ratchetDispatchOutcome: 'DIED',
  ratchetDispatchRetryCount: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
} // WAITING
```

Assert `entry.isWorking` stays false throughout and the Kanban sequence is `WORKING`, `WORKING`, `WORKING`, `WAITING`.

- [ ] **Step 2: Run the snapshot test and verify RED**

Run:

```bash
pnpm exec vitest run src/backend/services/workspace-snapshot-store.service.test.ts
```

Expected: the entry/update types or exhausted-retry assertion fail because dispatch metadata is not stored.

- [ ] **Step 3: Add dispatch fields to the Ratchet snapshot group**

Import `RatchetDispatchOutcome` as a type and add:

```ts
ratchetDispatchOutcome: RatchetDispatchOutcome | null;
ratchetDispatchRetryCount: number;
```

to `WorkspaceSnapshotEntry`, optional forms to `SnapshotUpdateInput`, defaults `null` and `0` in `createDefaultEntry`, and both names to `RATCHET_FIELDS`. Pass them into `assembleWorkspaceDerivedState` during every recomputation.

- [ ] **Step 4: Add reconciliation coverage before production reconciliation changes**

Extend the reconciliation fixture with `ratchetDispatchOutcome: 'DIED'` and an exhausted count. Assert the resulting snapshot contains both values and is `WAITING`. Add both fields to `DriftComparableField` and the Ratchet drift group, then assert drift detection reports either changed field.

- [ ] **Step 5: Seed dispatch fields from authoritative workspace rows**

Add to `buildAuthoritativeFields`:

```ts
ratchetDispatchOutcome: ws.ratchetDispatchOutcome,
ratchetDispatchRetryCount: ws.ratchetDispatchRetryCount,
```

This makes startup and periodic reconciliation deterministic without a schema migration.

- [ ] **Step 6: Run Task 2 tests and verify GREEN**

Run:

```bash
pnpm exec vitest run \
  src/backend/services/workspace-snapshot-store.service.test.ts \
  src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts
```

Expected: both files pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/backend/services/workspace-snapshot-store.service.ts \
  src/backend/services/workspace-snapshot-store.service.test.ts \
  src/backend/orchestration/snapshot-reconciliation.orchestrator.ts \
  src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts
git commit -m "Track Ratchet dispatch state in workspace snapshots"
```

---

### Task 3: Publish live Ratchet dispatch ownership changes

**Files:**
- Modify: `src/backend/services/ratchet/service/ratchet.service.ts`
- Modify: `src/backend/services/ratchet/service/ratchet.service.test.ts`
- Modify: `src/backend/services/ratchet/service/ratchet-active-session.helpers.ts`
- Modify: `src/backend/services/ratchet/service/index.ts`
- Modify: `src/backend/orchestration/event-collector.orchestrator.ts`
- Modify: `src/backend/orchestration/event-collector.orchestrator.test.ts`

**Interfaces:**
- Consumes: successful dispatch-record mutations and the snapshot Ratchet field group from Task 2.
- Produces: `RATCHET_DISPATCH_CHANGED` with `RatchetDispatchChangedEvent { workspaceId, outcome, retryCount }` and an immediate event-collector upsert.

- [ ] **Step 1: Add failing Ratchet service event tests**

Test both lifecycle settlement and retry dispatch:

```ts
const events: RatchetDispatchChangedEvent[] = [];
ratchetService.on(RATCHET_DISPATCH_CHANGED, (event) => events.push(event));

await ratchetService.recordSessionEnd('ws-1', 'session-1', 'DIED');

expect(events).toContainEqual({
  workspaceId: 'ws-1',
  outcome: 'DIED',
  retryCount: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
});
```

Also exercise a successful retry dispatch and expect `{ outcome: 'RUNNING', retryCount: 1 }`. A lost conditional settlement must emit nothing.

- [ ] **Step 2: Add a failing active-session fallback event test to the Ratchet service suite**

Exercise the service's private `checkActiveFixerSession` wrapper with a missing/dead recorded fixer and assert the public dispatch-change event receives the workspace ID, settled outcome, and the workspace's current retry count. Assert no event on `ended_concurrently`. Implement the helper boundary with an `onDispatchChanged` callback so the helper remains independent of the service emitter.

- [ ] **Step 3: Run Ratchet tests and verify RED**

Run:

```bash
pnpm exec vitest run src/backend/services/ratchet/service/ratchet.service.test.ts
```

Expected: the new event constant/callback is missing.

- [ ] **Step 4: Implement and export the dispatch-change event**

Add to `ratchet.service.ts` and export through the capsule barrel:

```ts
export const RATCHET_DISPATCH_CHANGED = 'ratchet_dispatch_changed' as const;

export interface RatchetDispatchChangedEvent {
  workspaceId: string;
  outcome: RatchetDispatchOutcome | null;
  retryCount: number;
}
```

Emit only after a dispatch-record mutation succeeds. `recordSessionEnd` should re-read the workspace after the conditional update and emit its authoritative outcome/count. The active-fixer fallback passes a callback into `checkActiveFixerSession`, and a successful `TRIGGERED_FIXER` emits `RUNNING` with the decision's retry count. Do not emit for failed CAS/disabled paths.

- [ ] **Step 5: Add failing event-collector propagation tests**

Capture the registered `ratchet_dispatch_changed` listener, invoke it with an exhausted `DIED` event, and assert an immediate store upsert:

```ts
expect(mockUpsert).toHaveBeenCalledWith(
  'ws-1',
  {
    ratchetDispatchOutcome: 'DIED',
    ratchetDispatchRetryCount: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
  },
  'event:ratchet_dispatch_changed'
);
```

Update listener-count/log expectations to include the new subscription.

- [ ] **Step 6: Wire the event collector and cache refresh**

Subscribe through the Ratchet barrel, enqueue both dispatch fields with `{ immediate: true }`, and fire-and-forget `kanbanStateService.updateCachedKanbanColumn(workspaceId)` with warning logging on failure. Use the same cache-refresh helper after `RATCHET_STATE_CHANGED` and `RATCHET_TOGGLED`, since either can change durable ownership.

- [ ] **Step 7: Run Task 3 tests and verify GREEN**

Run:

```bash
pnpm exec vitest run \
  src/backend/services/ratchet/service/ratchet.service.test.ts \
  src/backend/orchestration/event-collector.orchestrator.test.ts
```

Expected: all selected files pass with immediate dispatch propagation covered.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/backend/services/ratchet/service/ratchet.service.ts \
  src/backend/services/ratchet/service/ratchet.service.test.ts \
  src/backend/services/ratchet/service/ratchet-active-session.helpers.ts \
  src/backend/services/ratchet/service/index.ts \
  src/backend/orchestration/event-collector.orchestrator.ts \
  src/backend/orchestration/event-collector.orchestrator.test.ts
git commit -m "Publish Ratchet dispatch ownership changes"
```

---

### Task 4: Align workspace progression documentation

**Files:**
- Modify: `docs/workspaces.md`

**Interfaces:**
- Consumes: verified ownership derivation, snapshot propagation, cache refresh, and Ratchet dispatch event behavior from Tasks 1–3.
- Produces: current repository documentation for the implemented model.

- [ ] **Step 1: Rewrite the stale Working/Waiting documentation**

Update `docs/workspaces.md` to:

- point at current service-capsule paths;
- state the current two-minute Ratchet and three-minute PR-sync intervals;
- define `isWorking` as session-only;
- define Kanban through next-action ownership and list the exhausted-retry override;
- remove `hasHadSessions` from `computeKanbanColumn` inputs;
- correct the duplicated archived-workspace bullet and stale testing paths.

- [ ] **Step 2: Verify the documented state matrix against focused tests**

Run:

```bash
pnpm exec vitest run \
  src/backend/services/workspace/service/state/kanban-state.test.ts \
  src/backend/services/workspace/service/lifecycle/state-machine.service.test.ts
git diff --check
```

Expected: tests pass and no whitespace errors are reported.

- [ ] **Step 3: Commit Task 4**

```bash
git add docs/workspaces.md
git commit -m "Document Kanban ownership semantics"
```

---

### Task 5: Full verification and cleanup

**Files:**
- Modify only files already in scope if verification finds formatting or type issues.

**Interfaces:**
- Consumes: completed implementation from Tasks 1–4.
- Produces: verified repository state with no behavior, type, lint, build, or documentation regressions attributable to the change.

- [ ] **Step 1: Run the complete focused regression set**

```bash
pnpm exec vitest run \
  src/backend/services/workspace/service/state/kanban-state.test.ts \
  src/backend/services/workspace/service/state/flow-state.test.ts \
  src/backend/lib/workspace-derived-state.test.ts \
  src/backend/services/workspace-snapshot-store.service.test.ts \
  src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts \
  src/backend/orchestration/event-collector.orchestrator.test.ts \
  src/backend/services/workspace/service/query/workspace-query.service.test.ts \
  src/backend/services/workspace/service/lifecycle/state-machine.service.test.ts \
  src/backend/services/ratchet/service/ratchet.service.test.ts
```

Expected: all selected tests pass with zero failures.

- [ ] **Step 2: Run formatting and standard guardrails**

```bash
pnpm check:fix
pnpm check
pnpm typecheck
```

Expected: each command exits `0`. Inspect `git diff` after `check:fix` and retain only in-scope formatting changes.

- [ ] **Step 3: Run the full test suite and production build**

```bash
pnpm test
pnpm build
```

Expected: both commands exit `0`. If a pre-existing unrelated failure appears, capture its exact output and verify it also occurs on the pre-change commit before reporting it as pre-existing.

- [ ] **Step 4: Inspect final scope and behavior evidence**

```bash
git status --short
git diff ced1cf04..HEAD --stat
git log -5 --oneline
```

Confirm only the design/plan, Kanban derivation, snapshot propagation, Ratchet event wiring, tests, and `docs/workspaces.md` changed. Re-read the design's column-rule checklist against the final tests.

- [ ] **Step 5: Commit any verification-only formatting fix**

Only if Step 2 changed in-scope files after Task 4:

Stage only the already listed Task 1–4 files changed by Biome, verify the staged diff, and commit:

```bash
git diff --name-only
git add src/backend/lib/workspace-derived-state.ts \
  src/backend/lib/workspace-derived-state.test.ts \
  src/backend/services/workspace-snapshot-store.service.ts \
  src/backend/services/workspace-snapshot-store.service.test.ts \
  src/backend/services/workspace/service/state/kanban-state.ts \
  src/backend/services/workspace/service/state/kanban-state.test.ts \
  src/backend/services/workspace/service/query/workspace-query.service.ts \
  src/backend/services/workspace/service/query/workspace-query.service.test.ts \
  src/backend/services/workspace/service/lifecycle/state-machine.service.ts \
  src/backend/services/workspace/service/lifecycle/state-machine.service.test.ts \
  src/backend/services/ratchet/service/ratchet.service.ts \
  src/backend/services/ratchet/service/ratchet.service.test.ts \
  src/backend/services/ratchet/service/ratchet-active-session.helpers.ts \
  src/backend/services/ratchet/service/index.ts \
  src/backend/orchestration/snapshot-reconciliation.orchestrator.ts \
  src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts \
  src/backend/orchestration/event-collector.orchestrator.ts \
  src/backend/orchestration/event-collector.orchestrator.test.ts \
  docs/workspaces.md
git diff --cached --check
git commit -m "Format Kanban ownership changes"
```

If there are no remaining changes, do not create an empty commit.
