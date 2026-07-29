# Kanban Column Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a workspace's Kanban column a pure projection of its status reason code, so the column a card sits in can never contradict the label it shows, and WAITING means only "a human owns the next action".

**Architecture:** A total `Record<WorkspaceStatusReasonCode, KanbanColumn | null>` in `src/shared/` replaces the independent `computeKanbanColumn` derivation. Four new status reason codes close the gaps that previously fell through to the WAITING fallback, one redundant code is deleted, and four fields join the snapshot wire so the live stream and the tRPC query derive identically. A separate client fix stops a snapshot-introduced workspace from appearing on the board while its issue is still in the Todo column.

**Tech Stack:** TypeScript (strict), Prisma + SQLite, tRPC, Zod, React + React Query, Vitest, Biome.

## Global Constraints

- Schemas use Zod. No raw typecasts (`as` on values); `as const` and type-only assertions are fine.
- Backend service capsules are imported through their barrel (`@/backend/services/session`), never internal paths.
- Path aliases: `@/*` → `src/`, `@prisma-gen/*` → `prisma/generated/`.
- Tests are co-located with the module they cover.
- Run `pnpm check:fix` before each commit; `pnpm typecheck` and `pnpm test` must pass.
- `pnpm check:prisma-schema` must pass after any `prisma/schema.prisma` change.
- Commit messages: short, imperative, under 72 characters on the first line.
- Do not commit to `main`. All work lands on the current branch `kanban-column-projection`.

---

### Task 1: Persist the ratchet's own stall conclusion

The ratchet already decides it will take no further action until the PR changes, then discards that decision. Persist it as a boolean so status derivation can read it without recomputing a snapshot key it cannot see.

**Files:**
- Modify: `prisma/schema.prisma` (model `WorkspaceRatchet`, around line 348)
- Create: `prisma/migrations/<timestamp>_add_ratchet_dispatch_stalled/migration.sql` (generated)
- Modify: `src/backend/services/workspace/resources/workspace-ratchet.accessor.ts`
- Modify: `src/backend/services/ratchet/service/bridges.ts` (`RatchetWorkspaceBridge`, line 58)
- Modify: `src/backend/services/ratchet/service/ratchet.service.ts`
- Modify: `src/backend/orchestration/domain-bridges.orchestrator.ts`
- Test: `src/backend/services/workspace/resources/workspace-ratchet.accessor.test.ts`
- Test: `src/backend/services/ratchet/service/ratchet.service.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `WorkspaceRatchetFields.ratchetDispatchStalled: boolean` (flattened read name), `workspaceRatchetAccessor.markDispatchStalled(workspaceId, snapshotKey): Promise<boolean>`, reached from the ratchet via `RatchetWorkspaceBridge`. Task 3 puts this on the snapshot wire; Task 4 consumes it as `dispatchStalled` in `WorkspaceStatusReasonInput`.

- [ ] **Step 1: Add the column to the Prisma schema**

In `prisma/schema.prisma`, inside `model WorkspaceRatchet`, add after `dispatchRetryCount`:

```prisma
  // The ratchet's own conclusion that it will not act again until the PR
  // changes: either a settled dispatch achieved nothing for an unchanged
  // snapshot key, or a DIED fixer exhausted its retries. Persisted because the
  // snapshot key hashes statusCheckRollup detail `WorkspacePR` does not store,
  // so no reader can re-derive this.
  dispatchStalled     Boolean      @default(false)
```

- [ ] **Step 2: Generate and apply the migration**

Run: `pnpm db:migrate --name add_ratchet_dispatch_stalled`
Expected: a new folder under `prisma/migrations/`, and "Your database is now in sync with your schema." Prisma does not emit `ALTER TABLE ... ADD COLUMN` for SQLite here — it emits a `RedefineTables` block that creates `new_WorkspaceRatchet`, copies every existing column across with `INSERT ... SELECT`, drops the old table, renames, and recreates the `lastCheckedAt` index. That is expected and non-destructive; confirm the `INSERT ... SELECT` lists all seven pre-existing columns.

Then run: `pnpm db:generate`
Expected: "Generated Prisma Client".

- [ ] **Step 3: Verify the schema check passes**

Run: `pnpm check:prisma-schema`
Expected: exit 0, no drift reported.

- [ ] **Step 4: Write the failing accessor test**

`src/backend/services/workspace/resources/workspace-ratchet.accessor.test.ts` already exists and provides a `ratchetRow(overrides?: Partial<WorkspaceRatchetRow>)` factory at line 31. Add `dispatchStalled: false` to that factory's defaults, then add:

```ts
describe('flattenWorkspaceRatchet', () => {
  it('defaults ratchetDispatchStalled to false when no ratchet row exists', () => {
    expect(flattenWorkspaceRatchet(null)).toMatchObject({ ratchetDispatchStalled: false });
  });

  it('flattens dispatchStalled under the ratchet-prefixed read name', () => {
    expect(flattenWorkspaceRatchet(ratchetRow({ dispatchStalled: true }))).toMatchObject({
      ratchetDispatchStalled: true,
    });
  });
});
```

`flattenWorkspaceRatchet` is exported from the accessor (line 70); add it to that file's existing import if it is not already there.

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm test src/backend/services/workspace/resources/workspace-ratchet.accessor.test.ts`
Expected: FAIL — `ratchetDispatchStalled` is undefined, not `false`/`true`.

- [ ] **Step 6: Flatten the new column**

In `src/backend/services/workspace/resources/workspace-ratchet.accessor.ts`:

Add to the `WorkspaceRatchetFields` interface, after `ratchetDispatchRetryCount: number;`:

```ts
  ratchetDispatchStalled: boolean;
```

Add to the defaults object (the one containing `ratchetDispatchRetryCount: 0`):

```ts
  ratchetDispatchStalled: false,
```

Add to the flattening return (beside `ratchetDispatchRetryCount: ratchet.dispatchRetryCount`):

```ts
    ratchetDispatchStalled: ratchet.dispatchStalled,
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm test src/backend/services/workspace/resources/workspace-ratchet.accessor.test.ts`
Expected: PASS.

- [ ] **Step 8: Add the write and clear paths**

In the same accessor, add a setter next to the existing dispatch writers:

```ts
  /**
   * Record that the ratchet has concluded it will not act again for the current
   * PR state. Cleared by `resetSettledDispatch` and `disable`, which already own
   * the rest of the dispatch record's lifecycle.
   */
  async markDispatchStalled(workspaceId: string): Promise<void> {
    await prisma.workspaceRatchet.updateMany({
      where: { workspaceId },
      data: { dispatchStalled: true },
    });
  }
```

In `disable`, add `dispatchStalled: false` to the `data` object.

In `resetSettledDispatch`, add `dispatchStalled: false` to the `data` object of its `updateMany` — the reset already fires when an observation invalidates the settled dispatch, which is exactly when a stall stops being true.

- [ ] **Step 9: Write the failing ratchet decision tests**

`src/backend/services/ratchet/service/ratchet.service.test.ts` has no shared arrangement factory — each test builds its own mock workspace and calls `ratchetService.checkWorkspaceById(id)`. Copy the arrangement from two existing tests rather than inventing a harness:

- `'does not dispatch when PR state unchanged since last dispatch'` (line 583) — the unchanged-key case.
- the DIED-retry tests around lines 1526 and 1570, which set `ratchetDispatchOutcome: 'DIED'` with a retry count.

Add `markDispatchStalled: vi.fn()` to the workspace-ratchet accessor mock in that file's `vi.mock` block, then add three tests beside the ones above:

```ts
it('marks the dispatch stalled when a settled dispatch achieved nothing', async () => {
  // CI still failing and the snapshot key is unchanged since a dispatch that
  // settled COMPLETED, so the ratchet declines to re-dispatch: nothing will
  // happen here until the PR itself changes.
  // (arrangement copied from 'does not dispatch when PR state unchanged since
  // last dispatch', with ratchetDispatchOutcome set to 'COMPLETED')

  await ratchetService.checkWorkspaceById('ws-1');

  expect(workspaceRatchetAccessorMock.markDispatchStalled).toHaveBeenCalledWith('ws-1');
});

it('marks the dispatch stalled when a DIED fixer exhausts its retries', async () => {
  // arrangement copied from the DIED-retry test at line 1570, with
  // ratchetDispatchRetryCount set to SERVICE_THRESHOLDS.ratchetDispatchMaxRetries

  await ratchetService.checkWorkspaceById('ws-1');

  expect(workspaceRatchetAccessorMock.markDispatchStalled).toHaveBeenCalledWith('ws-1');
});

it('does not mark the dispatch stalled when the PR state has changed', async () => {
  // Same as the first test, but the cached ratchetDispatchSnapshotKey differs
  // from the key the fetch computes, so a fresh dispatch is warranted.

  await ratchetService.checkWorkspaceById('ws-1');

  expect(workspaceRatchetAccessorMock.markDispatchStalled).not.toHaveBeenCalled();
});
```

Fill each arrangement comment with the actual mock setup copied from the referenced test — the three tests differ only in `ratchetDispatchOutcome`, `ratchetDispatchRetryCount`, and whether the cached snapshot key matches the computed one.

- [ ] **Step 10: Run the tests to verify they fail**

Run: `pnpm test src/backend/services/ratchet/service/ratchet.service.test.ts -t "stalled"`
Expected: FAIL — `markDispatchStalled` is not a function / never called.

- [ ] **Step 11: Set the flag at the two decline points**

In `src/backend/services/ratchet/service/ratchet.service.ts`, in `decideRatchetAction`, change the unchanged-key gate:

```ts
    if (!context.hasStateChangedSinceLastDispatch) {
      // A settled dispatch achieved nothing for this PR state, and this gate is
      // only reachable after an actionable trigger was confirmed and the DIED
      // and active-session paths returned. Nothing further will happen here
      // until the PR changes, so record it rather than looking busy.
      await this.workspace.markDispatchStalled(context.workspace.id);
      return {
        type: 'RETURN_ACTION',
        action: { type: 'WAITING', reason: 'PR state unchanged since last ratchet dispatch' },
      };
    }
```

In `decideDiedFixerRetry`, change the exhausted-retries branch:

```ts
    if (context.dispatchRetryCount >= SERVICE_THRESHOLDS.ratchetDispatchMaxRetries) {
      await this.workspace.markDispatchStalled(context.workspace.id);
      return {
        type: 'RETURN_ACTION',
        action: {
          type: 'WAITING',
          reason: `Fixer died ${context.dispatchRetryCount + 1} times for this PR state; waiting for PR state to change`,
        },
      };
    }
```

`decideRatchetAction` is already `async`, and `decideDiedFixerRetry` is too (it awaits `hasActiveSession`).

The snippets above already call through the bridge, which is mandatory: the ratchet capsule does **not** import `workspaceRatchetAccessor` — it reaches workspace state only through `RatchetWorkspaceBridge` (`src/backend/services/ratchet/service/bridges.ts:58`, which today exposes `findFixerContext` and `recordSessionEnd`). Adding a direct import would violate the capsule boundary and fail `pnpm check`. So:

Add to `RatchetWorkspaceBridge`:

```ts
  markDispatchStalled(workspaceId: string): Promise<void>;
```

Wire it in `src/backend/orchestration/domain-bridges.orchestrator.ts` where the ratchet's workspace bridge object is constructed, alongside the existing `recordSessionEnd` delegate:

```ts
    markDispatchStalled: (workspaceId) => workspaceRatchetAccessor.markDispatchStalled(workspaceId),
```

Then call `await this.workspace.markDispatchStalled(context.workspace.id)` at both decline points, matching how `this.workspace.recordSessionEnd` is called at `ratchet.service.ts:315`. The test double in Step 9 mocks the bridge, not the accessor.

- [ ] **Step 12: Run the tests to verify they pass**

Run: `pnpm test src/backend/services/ratchet/service/ratchet.service.test.ts`
Expected: PASS, including the pre-existing tests in that file.

- [ ] **Step 13: Verify boundaries and types**

Run: `pnpm typecheck && pnpm check`
Expected: exit 0; dependency-cruiser reports no violations.

- [ ] **Step 14: Commit**

```bash
pnpm check:fix
git add prisma/schema.prisma prisma/migrations src/backend/services/workspace/resources/workspace-ratchet.accessor.ts src/backend/services/workspace/resources/workspace-ratchet.accessor.test.ts src/backend/services/ratchet/service/ratchet.service.ts src/backend/services/ratchet/service/ratchet.service.test.ts
git commit -m "Persist ratchet dispatch stall conclusion"
```

---

### Task 2: Detect a session that is starting

**Files:**
- Modify: `src/shared/session-runtime.ts`
- Test: `src/shared/session-runtime.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `hasStartingSessionSummary(summaries: Pick<SessionSummary, 'runtimePhase'>[]): boolean`. Task 4 consumes it as the `isSessionStarting` input; Task 5 calls it at both derivation sites.

- [ ] **Step 1: Write the failing test**

Add to `src/shared/session-runtime.test.ts`:

```ts
describe('hasStartingSessionSummary', () => {
  it('treats loading and starting phases as starting', () => {
    expect(hasStartingSessionSummary([{ runtimePhase: 'starting' }])).toBe(true);
    expect(hasStartingSessionSummary([{ runtimePhase: 'loading' }])).toBe(true);
  });

  it('does not treat a running, idle, stopping, or errored session as starting', () => {
    expect(hasStartingSessionSummary([{ runtimePhase: 'running' }])).toBe(false);
    expect(hasStartingSessionSummary([{ runtimePhase: 'idle' }])).toBe(false);
    expect(hasStartingSessionSummary([{ runtimePhase: 'stopping' }])).toBe(false);
    expect(hasStartingSessionSummary([{ runtimePhase: 'error' }])).toBe(false);
  });

  it('is false for a workspace with no sessions', () => {
    expect(hasStartingSessionSummary([])).toBe(false);
  });

  it('is true when any session is starting', () => {
    expect(
      hasStartingSessionSummary([{ runtimePhase: 'idle' }, { runtimePhase: 'starting' }])
    ).toBe(true);
  });
});
```

Add `hasStartingSessionSummary` to the existing import from `./session-runtime` at the top of that file.

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm test src/shared/session-runtime.test.ts -t "hasStartingSessionSummary"`
Expected: FAIL with "hasStartingSessionSummary is not a function".

- [ ] **Step 3: Implement the predicate**

In `src/shared/session-runtime.ts`, directly after `hasWorkingSessionSummary`:

```ts
/**
 * A session that has been spawned but has not yet reported work.
 *
 * `isSessionSummaryWorking` counts only `running`/`WORKING`, so the window
 * between spawning an ACP session and its first activity reads as not-working.
 * Workspace init marks the workspace READY while that spawn is still in flight,
 * so without this the card falls to the idle column mid-launch.
 */
export function hasStartingSessionSummary(
  summaries: Pick<SessionSummary, 'runtimePhase'>[]
): boolean {
  return summaries.some(
    (summary) => summary.runtimePhase === 'starting' || summary.runtimePhase === 'loading'
  );
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm test src/shared/session-runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm check:fix
git add src/shared/session-runtime.ts src/shared/session-runtime.test.ts
git commit -m "Add starting-session summary predicate"
```

---

### Task 3: Carry the four missing facts on the snapshot wire

The snapshot stream and the tRPC query must derive from the same facts. `hasMergeConflict`, `mode`, `autoIterationStatus`, and `dispatchStalled` are read by the query path today but absent from the wire, so this task plumbs them end to end with no behavior change.

**Files:**
- Modify: `src/shared/workspace-snapshot.ts`
- Modify: `src/backend/services/workspace/service/snapshot/workspace-snapshot-store.service.ts`
- Modify: `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`
- Modify: `src/client/lib/snapshot-to-workspace.ts`
- Test: `src/shared/workspace-snapshot.test.ts`
- Test: `src/backend/services/workspace/service/snapshot/workspace-snapshot-store.service.test.ts`

**Interfaces:**
- Consumes: `ratchetDispatchStalled` from Task 1.
- Produces: `WorkspaceSnapshotEntry` gains `hasMergeConflict: boolean`, `mode: WorkspaceMode`, `autoIterationStatus: AutoIterationStatus | null`, `ratchetDispatchStalled: boolean`. Task 5 reads all four in `recomputeDerivedState`.

- [ ] **Step 1: Write the failing schema test**

`src/shared/workspace-snapshot.test.ts` builds entries with a local `makeCompleteSnapshot()` (line 8) that wraps `makeWorkspaceSnapshotEntry` from `@/test-utils/workspace-snapshot`. Add:

```ts
it('carries merge conflict, mode, auto-iteration status, and dispatch stall', () => {
  const parsed = WorkspaceSnapshotEntrySchema.parse({
    ...makeCompleteSnapshot(),
    hasMergeConflict: true,
    mode: 'AUTO_ITERATION',
    autoIterationStatus: 'RUNNING',
    ratchetDispatchStalled: true,
  });

  expect(parsed).toMatchObject({
    hasMergeConflict: true,
    mode: 'AUTO_ITERATION',
    autoIterationStatus: 'RUNNING',
    ratchetDispatchStalled: true,
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/shared/workspace-snapshot.test.ts`
Expected: FAIL — the schema strips or rejects the unknown keys.

- [ ] **Step 3: Extend the schema**

In `src/shared/workspace-snapshot.ts`, add to `WorkspaceSnapshotEntrySchema`:

after `prUpdatedAt: z.string().nullable(),`

```ts
  hasMergeConflict: z.boolean(),
```

after `ratchetDispatchRetryCount: z.number().int().nonnegative(),`

```ts
  ratchetDispatchStalled: z.boolean(),
```

after `hasHadSessions: z.boolean(),`

```ts
  mode: z.nativeEnum(WorkspaceMode),
  autoIterationStatus: z.nativeEnum(AutoIterationStatus).nullable(),
```

Import `WorkspaceMode` and `AutoIterationStatus` from `@/shared/core` alongside the existing enum imports in that file. Both are exported there as const objects with matching types (`enums.ts:137-146` for `AutoIterationStatus`, whose values are `IDLE`, `RUNNING`, `PAUSED`, `COMPLETED`, `MAX_ITERATIONS`, `STOPPED`, `FAILED`), so `z.nativeEnum` works on both exactly as it does for `WorkspaceStatus`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/shared/workspace-snapshot.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the fields to the store's input and field groups**

In `src/backend/services/workspace/service/snapshot/workspace-snapshot-store.service.ts`:

Add to `SnapshotUpdateInput`, in the matching comment blocks:

```ts
  // Workspace fields (group: 'workspace')
  mode?: WorkspaceMode;
  autoIterationStatus?: AutoIterationStatus | null;

  // PR fields (group: 'pr')
  hasMergeConflict?: boolean;

  // Ratchet fields (group: 'ratchet')
  ratchetDispatchStalled?: boolean;
```

Extend the field arrays:

```ts
const WORKSPACE_FIELDS = [
  'projectId',
  'name',
  'status',
  'createdAt',
  'branchName',
  'hasHadSessions',
  'mode',
  'autoIterationStatus',
] as const;
const PR_FIELDS = [
  'prUrl',
  'prNumber',
  'prState',
  'prCiStatus',
  'prUpdatedAt',
  'hasMergeConflict',
] as const;
const RATCHET_FIELDS = [
  'ratchetEnabled',
  'ratchetState',
  'ratchetDispatchOutcome',
  'ratchetDispatchRetryCount',
  'ratchetDispatchStalled',
] as const;
```

Add to `createDefaultEntry`, matching the surrounding style:

```ts
      hasMergeConflict: false,
      mode: 'STANDARD' as WorkspaceMode,
      autoIterationStatus: null,
      ratchetDispatchStalled: false,
```

- [ ] **Step 6: Populate the fields in reconciliation**

In `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`, in the returned `SnapshotUpdateInput` object, add:

```ts
      hasMergeConflict: ws.prHasMergeConflict,
      mode: ws.mode,
      autoIterationStatus: ws.autoIterationStatus,
      ratchetDispatchStalled: ws.ratchetDispatchStalled,
```

All four read names come from the accessors that flatten the 1:1 side tables — `prHasMergeConflict` from `workspace-pr.accessor.ts:48`, `mode` and `autoIterationStatus` from `workspace-auto-iteration.accessor.ts:26-27`, and `ratchetDispatchStalled` from Task 1. The rows arrive via `this.dependencies.workspaceMaintenanceService.findActiveWithSessionsAndProject()` (line 300); if its select does not carry the `pr`, `autoIteration`, or `ratchet` relations, widen it so the flatteners run.

- [ ] **Step 7: Write the failing store test**

`src/backend/services/workspace/service/snapshot/workspace-snapshot-store.service.test.ts` builds inputs with `makeUpdate(overrides?: Partial<SnapshotUpdateInput>)` (line 34) and calls `store.upsert(id, update, source, timestamp)` — four arguments, not three. First add the new fields to `makeUpdate`'s defaults (`hasMergeConflict: false`, `mode: 'STANDARD'`, `autoIterationStatus: null`, `ratchetDispatchStalled: false`), then add:

```ts
it('accepts and stores the merge conflict, mode, auto-iteration, and stall fields', () => {
  store.upsert('ws-1', makeUpdate({ projectId: 'proj-A' }), 'test', 100);
  store.upsert(
    'ws-1',
    makeUpdate({
      hasMergeConflict: true,
      mode: 'AUTO_ITERATION',
      autoIterationStatus: 'RUNNING',
      ratchetDispatchStalled: true,
    }),
    'test',
    200
  );

  expect(store.get('ws-1')).toMatchObject({
    hasMergeConflict: true,
    mode: 'AUTO_ITERATION',
    autoIterationStatus: 'RUNNING',
    ratchetDispatchStalled: true,
  });
});
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm test src/backend/services/workspace/service/snapshot/workspace-snapshot-store.service.test.ts`
Expected: PASS (the schema and field-group work in Steps 3 and 5 already satisfies it).

- [ ] **Step 9: Stop defaulting the moved fields on the client**

In `src/client/lib/snapshot-to-workspace.ts`, remove `mode` from `mutationOnlyFieldDefaults()` — it is now a live field — and add to `projectSnapshotToLiveFields`:

```ts
    mode: entry.mode,
```

Leave `autoIterationStatus`, `autoIterationConfig`, and `autoIterationProgress` in `mutationOnlyFieldDefaults()`: only `autoIterationStatus` is on the wire and it is consumed by derivation on the backend, so the client list row keeps its existing mutation-sourced values rather than gaining a second source of truth.

Add to `mergeProjectSnapshotIntoWorkspaceDetail`, beside the existing `ratchetDispatchOutcome` line:

```ts
    ratchetDispatchStalled: entry.ratchetDispatchStalled,
```

- [ ] **Step 10: Verify the whole suite still passes**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. Fix any snapshot-entry fixtures in `src/test-utils/workspace-snapshot.ts` that now fail schema validation by adding the four fields with their defaults (`false`, `'STANDARD'`, `null`, `false`).

- [ ] **Step 11: Commit**

```bash
pnpm check:fix
git add src/shared/workspace-snapshot.ts src/shared/workspace-snapshot.test.ts src/backend/services/workspace/service/snapshot/workspace-snapshot-store.service.ts src/backend/services/workspace/service/snapshot/workspace-snapshot-store.service.test.ts src/backend/orchestration/snapshot-reconciliation.orchestrator.ts src/client/lib/snapshot-to-workspace.ts src/test-utils/workspace-snapshot.ts
git commit -m "Carry conflict, mode, and stall state on snapshot wire"
```

---

### Task 4: Rewrite the status reason and project the column from it

Merged from two tasks. The reason codes and the column map are one logical change: changing `WorkspaceStatusReasonInput` breaks both derivation call sites immediately, so splitting them would land a commit that does not typecheck, against this plan's Global Constraints.

**Files:**
- Modify: `src/shared/workspace-status-reason.ts`
- Test: `src/shared/workspace-status-reason.test.ts`
- Create: `src/shared/kanban-column-projection.ts`
- Create: `src/shared/kanban-column-projection.test.ts`
- Delete: `src/backend/services/workspace/service/state/kanban-state.ts`
- Delete: `src/backend/services/workspace/service/state/kanban-state.test.ts`
- Modify: `src/backend/lib/workspace-derived-state.ts`
- Modify: `src/backend/services/workspace/service/query/workspace-query.service.ts`
- Modify: `src/backend/services/workspace/service/snapshot/workspace-snapshot-store.service.ts`
- Modify: `src/backend/orchestration/domain-bridges.orchestrator.ts`
- Modify: `src/backend/services/workspace/service/state/flow-state.ts`
- Test: `src/backend/services/workspace/service/state/flow-state.test.ts`

**Interfaces:**
- Consumes: `hasStartingSessionSummary` (Task 2) indirectly — this task only takes the resulting boolean.
- Produces: `kanbanColumnForStatusReason(code: WorkspaceStatusReasonCode): KanbanColumn | null`. `WorkspaceStatusReasonInput` drops `runScriptStatus`, gains `isSessionStarting: boolean`, `hasMergeConflict: boolean`, `ratchetEnabled: boolean`, `dispatchStalled: boolean`, `mode: WorkspaceMode`, `autoIterationStatus: AutoIterationStatus | null`. `WORKSPACE_STATUS_REASON_CODES` drops `DEV_SERVER_RUNNING` and gains `STARTING_SESSION`, `AUTO_ITERATING`, `FIXING_MERGE_CONFLICT`, `MERGE_CONFLICT`, `RATCHET_STALLED`, and every code is mapped to a column in the same task.

- [ ] **Step 1: Write the failing tests**

Add to `src/shared/workspace-status-reason.test.ts`. First extend `makeInput`'s defaults — remove `runScriptStatus` and add:

```ts
    isSessionStarting: false,
    hasMergeConflict: false,
    ratchetEnabled: false,
    dispatchStalled: false,
    mode: 'STANDARD',
    autoIterationStatus: null,
```

Then add the cases:

```ts
it('reports a spawning session as starting rather than idle', () => {
  expect(deriveWorkspaceStatusReason(makeInput({ isSessionStarting: true }))).toMatchObject({
    code: 'STARTING_SESSION',
    label: 'Starting session',
    tone: 'working',
    needsUser: false,
  });
});

it('lets a pending request outrank a starting session', () => {
  expect(
    deriveWorkspaceStatusReason(
      makeInput({ isSessionStarting: true, pendingRequestType: 'permission_request' })
    )
  ).toMatchObject({ code: 'NEEDS_PERMISSION' });
});

it('lets provisioning outrank a starting session', () => {
  expect(
    deriveWorkspaceStatusReason(makeInput({ isSessionStarting: true, lifecycle: 'PROVISIONING' }))
  ).toMatchObject({ code: 'SETTING_UP' });
});

it('reports a running auto-iteration loop between sessions as working', () => {
  expect(
    deriveWorkspaceStatusReason(
      makeInput({ mode: 'AUTO_ITERATION', autoIterationStatus: 'RUNNING' })
    )
  ).toMatchObject({ code: 'AUTO_ITERATING', tone: 'working', needsUser: false });
});

it('prefers the live session over the loop when both are active', () => {
  expect(
    deriveWorkspaceStatusReason(
      makeInput({ mode: 'AUTO_ITERATION', autoIterationStatus: 'RUNNING', isWorking: true })
    )
  ).toMatchObject({ code: 'AGENT_WORKING' });
});

it('reports a conflicted PR as being fixed when the ratchet is on', () => {
  expect(
    deriveWorkspaceStatusReason(
      makeInput({
        hasMergeConflict: true,
        ratchetEnabled: true,
        ratchetState: 'MERGE_CONFLICT',
        flowPhase: 'RATCHET_VERIFY',
        prState: 'OPEN',
      })
    )
  ).toMatchObject({ code: 'FIXING_MERGE_CONFLICT', tone: 'working', needsUser: false });
});

it('reports a conflicted PR as needing a human when the ratchet is off', () => {
  expect(
    deriveWorkspaceStatusReason(
      makeInput({
        hasMergeConflict: true,
        ratchetEnabled: false,
        flowPhase: 'READY',
        ciObservation: 'CHECKS_PASSED',
        prState: 'OPEN',
      })
    )
  ).toMatchObject({ code: 'MERGE_CONFLICT', tone: 'attention', needsUser: true });
});

it('reports a stalled auto-fix ahead of the fixing states', () => {
  expect(
    deriveWorkspaceStatusReason(
      makeInput({
        ratchetEnabled: true,
        dispatchStalled: true,
        ratchetState: 'CI_FAILED',
        flowPhase: 'RATCHET_FIXING',
        prState: 'OPEN',
      })
    )
  ).toMatchObject({ code: 'RATCHET_STALLED', tone: 'attention', needsUser: true });
});

it('marks a reviewable pull request as needing the user', () => {
  expect(
    deriveWorkspaceStatusReason(
      makeInput({ flowPhase: 'READY', ciObservation: 'CHECKS_PASSED', prState: 'OPEN' })
    )
  ).toMatchObject({ code: 'READY_TO_MERGE', needsUser: true });

  expect(
    deriveWorkspaceStatusReason(
      makeInput({ flowPhase: 'READY', ciObservation: 'NO_CHECKS', prState: 'OPEN' })
    )
  ).toMatchObject({ code: 'READY_FOR_REVIEW', needsUser: true });
});
```

Delete any existing test asserting `DEV_SERVER_RUNNING`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/shared/workspace-status-reason.test.ts`
Expected: FAIL — unknown properties on the input type and missing codes.

- [ ] **Step 3: Update the code list and input type**

In `src/shared/workspace-status-reason.ts`, in `WORKSPACE_STATUS_REASON_CODES`, remove `'DEV_SERVER_RUNNING'` and add `'STARTING_SESSION'`, `'AUTO_ITERATING'`, `'FIXING_MERGE_CONFLICT'`, `'MERGE_CONFLICT'`, `'RATCHET_STALLED'`.

Replace `WorkspaceStatusReasonInput` with:

```ts
export interface WorkspaceStatusReasonInput {
  lifecycle: WorkspaceStatus;
  hasHadSessions: boolean;
  isWorking: boolean;
  isSessionStarting: boolean;
  pendingRequestType: WorkspacePendingRequestType | null;
  hasSessionRuntimeError?: boolean;
  flowPhase: WorkspaceFlowPhase;
  ciObservation: WorkspaceCiObservation;
  prState: PRState;
  prCiStatus: CIStatus;
  ratchetState: RatchetState;
  ratchetEnabled: boolean;
  hasMergeConflict: boolean;
  dispatchStalled: boolean;
  mode: WorkspaceMode;
  autoIterationStatus: AutoIterationStatus | null;
}
```

Remove the `RunScriptStatus` import and add `WorkspaceMode` plus the auto-iteration status type, importing them the same way Task 3 imported them into the snapshot schema.

- [ ] **Step 4: Update the derivation branches**

Replace `deriveActiveReason` entirely:

```ts
function deriveActiveReason(input: WorkspaceStatusReasonInput): OptionalWorkspaceStatusReason {
  if (input.isWorking) {
    return reason('AGENT_WORKING', 'Agent working', 'working');
  }

  if (input.isSessionStarting) {
    return reason('STARTING_SESSION', 'Starting session', 'working');
  }

  if (input.mode === 'AUTO_ITERATION' && input.autoIterationStatus === 'RUNNING') {
    return reason('AUTO_ITERATING', 'Auto-iterating', 'working');
  }

  return null;
}
```

The dev-server branch is gone: nothing read `DEV_SERVER_RUNNING`, the Kanban card already renders its own indicator from `runScriptStatus`, and returning it here masked the real reason for any workspace with a dev server up.

In `derivePrFlowReason`, insert two blocks immediately before the existing `if (input.flowPhase === 'CI_WAIT')`:

```ts
  if (input.ratchetEnabled && input.dispatchStalled) {
    return reason('RATCHET_STALLED', 'Auto-fix stalled', 'attention', true);
  }

  if (input.hasMergeConflict) {
    return input.ratchetEnabled
      ? reason('FIXING_MERGE_CONFLICT', 'Fixing merge conflict', 'working')
      : reason('MERGE_CONFLICT', 'Merge conflict', 'attention', true);
  }
```

Change the two ready branches to report that a human owns the next action:

```ts
  if (input.flowPhase === 'READY' && input.ciObservation === 'CHECKS_PASSED') {
    return reason('READY_TO_MERGE', 'Ready to merge', 'success', true);
  }

  if (input.flowPhase === 'READY') {
    return reason('READY_FOR_REVIEW', 'Ready for review', 'neutral', true);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test src/shared/workspace-status-reason.test.ts`
Expected: PASS.

The status-reason module will not typecheck on its own between Steps 3 and 6 — its two call sites are updated in Step 11. Do not commit until Step 15, when the whole change is green.

- [ ] **Step 6: Write the failing projection test**

Create `src/shared/kanban-column-projection.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  KANBAN_COLUMN_BY_STATUS_REASON_CODE,
  kanbanColumnForStatusReason,
} from './kanban-column-projection';
import { WORKSPACE_STATUS_REASON_CODES } from './workspace-status-reason';

describe('kanbanColumnForStatusReason', () => {
  it('maps every status reason code', () => {
    for (const code of WORKSPACE_STATUS_REASON_CODES) {
      expect(KANBAN_COLUMN_BY_STATUS_REASON_CODE).toHaveProperty(code);
    }
  });

  it('puts every state where automation owns the next action in WORKING', () => {
    for (const code of [
      'SETTING_UP',
      'STARTING_SESSION',
      'AGENT_WORKING',
      'AUTO_ITERATING',
      'WAITING_FOR_CI',
      'FIXING_CI_FAILURES',
      'FIXING_REVIEW_COMMENTS',
      'FIXING_MERGE_CONFLICT',
      'CHECKING_PR',
    ] as const) {
      expect(kanbanColumnForStatusReason(code)).toBe('WORKING');
    }
  });

  it('puts every state where a human owns the next action in WAITING', () => {
    for (const code of [
      'NEEDS_PERMISSION',
      'NEEDS_PLAN_APPROVAL',
      'NEEDS_ANSWER',
      'SESSION_ERROR',
      'SETUP_FAILED',
      'MERGE_CONFLICT',
      'RATCHET_STALLED',
      'READY_TO_MERGE',
      'READY_FOR_REVIEW',
      'NO_SESSION_STARTED',
      'READY_FOR_NEXT_PROMPT',
    ] as const) {
      expect(kanbanColumnForStatusReason(code)).toBe('WAITING');
    }
  });

  it('puts terminal pull requests in DONE and archiving workspaces off the board', () => {
    expect(kanbanColumnForStatusReason('MERGED')).toBe('DONE');
    expect(kanbanColumnForStatusReason('PR_CLOSED')).toBe('DONE');
    expect(kanbanColumnForStatusReason('ARCHIVING')).toBeNull();
    expect(kanbanColumnForStatusReason('ARCHIVED')).toBeNull();
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm test src/shared/kanban-column-projection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Write the projection**

Create `src/shared/kanban-column-projection.ts`:

```ts
import { KanbanColumn } from '@/shared/core';
import type { WorkspaceStatusReasonCode } from '@/shared/workspace-status-reason';

/**
 * The Kanban column is a projection of the status reason, not a second opinion.
 *
 * The column and the card label used to be derived independently from
 * overlapping inputs, which let them disagree: a dev server moved a card out of
 * "Ready to merge", and a conflicted PR read as "Checking PR". Typing this as a
 * total `Record` over the code union makes an unmapped code a compile error, so
 * the two cannot drift apart again.
 *
 * WAITING is positively asserted rather than inherited. A new code with no
 * obvious home belongs in WORKING: an unclassified workspace should read as
 * "something is happening" and get corrected, rather than quietly accumulating
 * in the column that is supposed to mean the user is blocking.
 */
export const KANBAN_COLUMN_BY_STATUS_REASON_CODE: Record<
  WorkspaceStatusReasonCode,
  KanbanColumn | null
> = {
  // Automation owns the next action.
  SETTING_UP: KanbanColumn.WORKING,
  STARTING_SESSION: KanbanColumn.WORKING,
  AGENT_WORKING: KanbanColumn.WORKING,
  AUTO_ITERATING: KanbanColumn.WORKING,
  WAITING_FOR_CI: KanbanColumn.WORKING,
  FIXING_CI_FAILURES: KanbanColumn.WORKING,
  FIXING_REVIEW_COMMENTS: KanbanColumn.WORKING,
  FIXING_MERGE_CONFLICT: KanbanColumn.WORKING,
  CHECKING_PR: KanbanColumn.WORKING,

  // A human owns the next action.
  NEEDS_PERMISSION: KanbanColumn.WAITING,
  NEEDS_PLAN_APPROVAL: KanbanColumn.WAITING,
  NEEDS_ANSWER: KanbanColumn.WAITING,
  SESSION_ERROR: KanbanColumn.WAITING,
  SETUP_FAILED: KanbanColumn.WAITING,
  MERGE_CONFLICT: KanbanColumn.WAITING,
  RATCHET_STALLED: KanbanColumn.WAITING,
  READY_TO_MERGE: KanbanColumn.WAITING,
  READY_FOR_REVIEW: KanbanColumn.WAITING,
  NO_SESSION_STARTED: KanbanColumn.WAITING,
  READY_FOR_NEXT_PROMPT: KanbanColumn.WAITING,

  // Finished.
  MERGED: KanbanColumn.DONE,
  PR_CLOSED: KanbanColumn.DONE,

  // Excluded from the board rather than placed in a column.
  ARCHIVING: null,
  ARCHIVED: null,
};

export function kanbanColumnForStatusReason(
  code: WorkspaceStatusReasonCode
): KanbanColumn | null {
  return KANBAN_COLUMN_BY_STATUS_REASON_CODE[code];
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm test src/shared/kanban-column-projection.test.ts`
Expected: PASS.

- [ ] **Step 10: Rewire the assembly**

In `src/backend/lib/workspace-derived-state.ts`:

Replace the `WorkspaceDerivedStateInput` ratchet-dispatch and run-script fields — remove `ratchetDispatchOutcome`, `ratchetDispatchRetryCount`, and `runScriptStatus`, and add:

```ts
  isSessionStarting: boolean;
  ratchetEnabled: boolean;
  hasMergeConflict: boolean;
  dispatchStalled: boolean;
  mode: WorkspaceMode;
  autoIterationStatus: AutoIterationStatus | null;
```

Remove `computeKanbanColumn` from `WorkspaceDerivedStateFns`, leaving only `deriveSidebarStatus`.

Replace the body of `assembleWorkspaceDerivedState`:

```ts
export function assembleWorkspaceDerivedState(
  input: WorkspaceDerivedStateInput,
  fns: WorkspaceDerivedStateFns
): WorkspaceDerivedState {
  const isWorking = input.sessionIsWorking;

  // The reason is computed first and the column read off it, so there is no
  // path that reaches a column without going through a reason.
  const statusReason = deriveWorkspaceStatusReason({
    lifecycle: input.lifecycle,
    hasHadSessions: input.hasHadSessions,
    isWorking,
    isSessionStarting: input.isSessionStarting,
    pendingRequestType: input.pendingRequestType,
    hasSessionRuntimeError: input.hasSessionRuntimeError,
    flowPhase: input.flowState.phase,
    ciObservation: input.flowState.ciObservation,
    prState: input.prState,
    prCiStatus: input.prCiStatus,
    ratchetState: input.ratchetState,
    ratchetEnabled: input.ratchetEnabled,
    hasMergeConflict: input.hasMergeConflict,
    dispatchStalled: input.dispatchStalled,
    mode: input.mode,
    autoIterationStatus: input.autoIterationStatus,
  });

  return {
    isWorking,
    sidebarStatus: fns.deriveSidebarStatus({
      isWorking,
      prUrl: input.prUrl,
      prState: input.prState,
      prCiStatus: input.prCiStatus,
      ratchetState: input.ratchetState,
    }),
    kanbanColumn: kanbanColumnForStatusReason(statusReason.code),
    flowPhase: input.flowState.phase,
    ciObservation: input.flowState.ciObservation,
    ratchetButtonAnimated: input.flowState.shouldAnimateRatchetButton,
    statusReason,
  };
}
```

Import `kanbanColumnForStatusReason` from `@/shared/kanban-column-projection`.

- [ ] **Step 11: Update the two call sites**

In `src/backend/services/workspace/service/query/workspace-query.service.ts`, in `deriveProjectWorkspaces`, drop `computeKanbanColumn` from the injected `fns` object and from the imports, delete the `ratchetDispatchOutcome`/`ratchetDispatchRetryCount`/`runScriptStatus` inputs, and add:

```ts
            isSessionStarting: hasStartingSessionSummary(sessionSummaries),
            ratchetEnabled: workspace.ratchetEnabled,
            hasMergeConflict: workspace.prHasMergeConflict,
            dispatchStalled: workspace.ratchetDispatchStalled,
            mode: workspace.mode,
            autoIterationStatus: workspace.autoIterationStatus,
```

Import `hasStartingSessionSummary` alongside the existing `hasWorkingSessionSummary` import from `@/shared/session-runtime`.

In `src/backend/services/workspace/service/snapshot/workspace-snapshot-store.service.ts`, in `recomputeDerivedState`, make the matching changes reading from `entry`:

```ts
        isSessionStarting: hasStartingSessionSummary(entry.sessionSummaries),
        ratchetEnabled: entry.ratchetEnabled,
        hasMergeConflict: entry.hasMergeConflict,
        dispatchStalled: entry.ratchetDispatchStalled,
        mode: entry.mode,
        autoIterationStatus: entry.autoIterationStatus,
```

and pass only `{ deriveSidebarStatus: this.derive.deriveSidebarStatus }` as the second argument.

In `src/backend/services/workspace/service/snapshot/workspace-snapshot-store.service.ts`, remove `computeKanbanColumn` from the `SnapshotDerivationFns` interface. In `src/backend/orchestration/domain-bridges.orchestrator.ts`, remove it from the object passed to the store's `configure()` call and from that file's imports.

- [ ] **Step 12: Delete the superseded module**

```bash
git rm src/backend/services/workspace/service/state/kanban-state.ts src/backend/services/workspace/service/state/kanban-state.test.ts
```

Its coverage now lives in `src/shared/kanban-column-projection.test.ts` (the mapping) and `src/shared/workspace-status-reason.test.ts` (the conditions that select each code).

- [ ] **Step 13: Make the CI observation pure**

In `src/backend/services/workspace/service/state/flow-state.ts`, delete the `CI_UNKNOWN_GRACE_MS` constant and replace the `CIStatus.UNKNOWN` branch of `deriveWorkspaceCiObservation`:

```ts
  if (input.prCiStatus === CIStatus.UNKNOWN) {
    // `UNKNOWN` means we have not read checks for this PR yet. It used to be
    // split from "no checks configured" by a 90s wall clock, which made derived
    // state a function of the current time: the same stored row produced
    // different columns on different reconciliation passes. The PR sync poll
    // resolves this to a real status, so reading it as not-yet-fetched is both
    // honest and self-correcting.
    return 'NOT_FETCHED';
  }
```

Remove the now-unused `prUpdatedAt` reads inside that function; leave `prUpdatedAt` on `WorkspaceFlowStateInput`, which other callers still pass.

Update `src/backend/services/workspace/service/state/flow-state.test.ts`: delete any test asserting the 90-second decay to `NO_CHECKS`, and add:

```ts
it('reads an unfetched CI status as not fetched regardless of elapsed time', () => {
  const state = deriveWorkspaceFlowState({
    prUrl: 'https://github.com/o/r/pull/1',
    prState: PRState.OPEN,
    prCiStatus: CIStatus.UNKNOWN,
    prUpdatedAt: new Date('2020-01-01T00:00:00.000Z'),
    ratchetEnabled: false,
    ratchetState: RatchetState.IDLE,
  });

  expect(state).toMatchObject({ ciObservation: 'NOT_FETCHED', phase: 'CI_WAIT', isWorking: true });
});
```

- [ ] **Step 14: Run the full suite**

Run: `pnpm test && pnpm typecheck && pnpm check`
Expected: PASS with no dependency violations. Existing tests that construct `WorkspaceDerivedStateInput` or `WorkspaceStatusReasonInput` will need the new fields; add them with the defaults `false`, `'STANDARD'`, `null`.

- [ ] **Step 15: Commit**

```bash
pnpm check:fix
git add -A src/shared src/backend
git commit -m "Project Kanban column from workspace status reason"
```

---

### Task 5: Stop a new workspace appearing on the board and in Todo at once

**Files:**
- Modify: `src/client/hooks/use-project-snapshot-sync.ts`
- Modify: `src/client/features/kanban/kanban-context.tsx`
- Test: `src/client/hooks/use-project-snapshot-sync.test.ts`
- Test: `src/client/features/kanban/kanban-context.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later depends on it.

- [ ] **Step 1: Update the existing invalidation contract and write the failing tests**

`src/client/hooks/use-project-snapshot-sync.test.ts` has a `describe('cache invalidation strategy')` block at line 442 whose first test — `'snapshot_changed and snapshot_removed never invalidate caches'` — asserts precisely the behavior this task changes. It must be narrowed, not left in place, or the task ends with a red suite.

Rename that test to `'snapshot_changed and snapshot_removed do not invalidate caches for a known workspace'` and seed the list cache with the entry's workspace id before dispatching, using the same `mocks.workspaceListState`-style seeding the rest of the file uses for `listForProject.getData`. Its `expectNoInvalidations()` assertion then still holds and now documents the narrower rule.

Then add, in the same block:

```ts
it('invalidates the project list once when snapshot_changed introduces an unknown workspace', () => {
  useProjectSnapshotSync('proj-1');
  const onMessage = capturedOptions!.onMessage!;

  onMessage({ type: 'snapshot_changed', workspaceId: 'ws-new', entry: makeEntry('ws-new') });
  onMessage({ type: 'snapshot_changed', workspaceId: 'ws-new', entry: makeEntry('ws-new') });

  expect(mockListInvalidate).toHaveBeenCalledTimes(1);
  expect(mockListInvalidate).toHaveBeenCalledWith({ projectId: 'proj-1' });
});

it('invalidates when snapshot_full introduces a workspace the cache has never seen', () => {
  useProjectSnapshotSync('proj-1');
  const onMessage = capturedOptions!.onMessage!;

  onMessage({ type: 'snapshot_full', projectId: 'proj-1', entries: [makeEntry('ws-new')] });

  expect(mockListInvalidate).toHaveBeenCalledWith({ projectId: 'proj-1' });
});
```

Adapt `makeEntry` to whatever argument it already takes in that file; if it takes no workspace id, spread an override (`{ ...makeEntry(), workspaceId: 'ws-new' }`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/client/hooks/use-project-snapshot-sync.test.ts`
Expected: FAIL — `invalidate` is never called.

- [ ] **Step 3: Invalidate on an unknown workspace**

In `src/client/hooks/use-project-snapshot-sync.ts`, add a ref beside the existing `baselineProjectsRef`:

```ts
  const invalidatedForUnknownWorkspaceRef = useRef<Set<string>>(new Set());
```

A snapshot entry carries only live fields. Mutation-sourced fields — including `githubIssueNumber` and `linearIssueId`, which the Todo column matches issues against — fall back to nulls for a workspace no fetch has returned yet, so the workspace lands on the board while its issue is still in Todo. Invalidating once at the point of introduction repairs every such field rather than the two that happen to hurt.

Thread the ref through `applySnapshotChangedMessage` and `applySnapshotFullMessage` as a parameter and, in each, after the `setData` call:

```ts
  const introduced = entriesToCheck.filter(
    (entry) =>
      !alreadyInvalidated.has(entry.workspaceId) &&
      !knownWorkspaceIds.has(entry.workspaceId)
  );
  if (introduced.length > 0) {
    for (const entry of introduced) {
      alreadyInvalidated.add(entry.workspaceId);
    }
    void utils.workspace.listForProject.invalidate({ projectId });
  }
```

Both helpers are module-scoped functions, not hooks, so pass the ref's **contents** in — `invalidatedForUnknownWorkspaceRef.current` — and name the parameter `alreadyInvalidated: Set<string>`. Passing the ref object itself and calling `.has`/`.add` on it directly is a type error.

Compute `knownWorkspaceIds` *before* each function's `setData` call, since `setData` is what inserts the unknown workspace:

```ts
  const knownWorkspaceIds = new Set(
    (utils.workspace.listForProject.getData({ projectId })?.workspaces ?? []).map((w) => w.id)
  );
```

For `applySnapshotChangedMessage`, `entriesToCheck` is `[entry]`; for `applySnapshotFullMessage` it is `entries`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/client/hooks/use-project-snapshot-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing issue-link test**

`src/client/features/kanban/kanban-context.test.tsx` renders via `renderProvider()`, which returns the captured context, and mocks `trpc.github.listIssuesForProject.useQuery` to return a hardcoded `{ issues: [] }` (line 101). Make that mock's issues configurable first: add `githubIssues: [] as Array<{ number: number; title: string }>` to the hoisted `mocks` object, and change the mock to `data: { issues: mocks.githubIssues }`.

Then add:

```tsx
it('keeps an archiving workspace suppressing its issue', () => {
  // A workspace mid-archive derives a null column, so the board filters it out
  // of `workspaces`. Its issue link must still suppress the Todo card, or the
  // issue reappears for as long as the archive takes.
  mocks.githubIssues = [{ number: 42, title: 'Fix the thing' }];
  mocks.workspaceListState = {
    workspaces: [
      {
        id: 'workspace-archiving',
        kanbanColumn: null,
        githubIssueNumber: 42,
        linearIssueId: null,
      },
    ],
    reviewCount: 0,
  };

  const context = renderProvider();

  expect(context.issues).toEqual([]);
});
```

Reset `mocks.githubIssues = []` in the existing `beforeEach` alongside the other mock resets. Match `mocks.workspaceListState`'s existing shape in that `beforeEach` — copy any additional required workspace fields from it rather than trimming the fixture.

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm test src/client/features/kanban/kanban-context.test.tsx`
Expected: FAIL — the issue card renders.

- [ ] **Step 7: Feed the issue filter the unfiltered list**

In `src/client/features/kanban/kanban-context.tsx`, change the `useProjectIssues` call to source links from the unfiltered query data:

```tsx
  } = useProjectIssues(projectId, issueProvider, {
    // Deliberately the unfiltered list: `workspaces` drops null-column
    // workspaces for the board's benefit, and an archiving workspace still owns
    // its issue until the archive completes.
    workspaceIssueLinks: projectWorkspaces?.workspaces,
    optimisticWorkspaceIssueLinks: archivingWorkspaceIssueLinks,
  });
```

Leave the `workspaces` memo and its null-column filter alone; the board still renders from it.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test src/client/features/kanban`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
pnpm check:fix
git add src/client/hooks/use-project-snapshot-sync.ts src/client/hooks/use-project-snapshot-sync.test.ts src/client/features/kanban/kanban-context.tsx src/client/features/kanban/kanban-context.test.tsx
git commit -m "Stop new workspaces showing in Todo and on the board"
```

---

### Task 6: Update the documentation

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Correct the Kanban model bullet**

In `AGENTS.md`, in the **Kanban model** bullet, replace the sentence describing column derivation with:

> The column is a projection of `statusReason.code` through `KANBAN_COLUMN_BY_STATUS_REASON_CODE` (`src/shared/kanban-column-projection.ts`), derived on every read and never persisted, so the column a card sits in and the label it shows cannot disagree. The map is typed as a total `Record` over the code union, so a new reason code without a column is a compile error. WAITING is positively asserted — it means a human owns the next action — and a code with no obvious home belongs in WORKING.

Delete the clause claiming READY workspaces with no prior sessions are hidden from the board. No such filter exists: the projection takes no `hasHadSessions` input and `listForProject` excludes only archiving and archived workspaces.

- [ ] **Step 2: Correct the auto-iteration bullet**

In the **Auto-iteration state** bullet, replace the claim that none of the five fields are on the snapshot wire:

> `mode` and `autoIterationStatus` are on the snapshot wire, because the status reason derives `AUTO_ITERATING` from them and the snapshot store has to reach the same answer as the query path. The other three (`config`, `progress`, `sessionId`) remain in the client's `mutationOnlyFieldDefaults`.

- [ ] **Step 3: Correct the ratchet bullet**

In the **Auto-Fix (Ratchet)** bullet, add after the dispatch-record sentence:

> A `dispatchStalled` boolean on the same row records the ratchet's own conclusion that it will not act again until the PR changes — set both when a settled dispatch achieved nothing for an unchanged snapshot key and when a `DIED` fixer exhausts its retries, cleared by `resetSettledDispatch` and `disable`. It is what moves a stuck workspace out of the WORKING column; the snapshot key hashes `statusCheckRollup` detail `WorkspacePR` does not store, so no reader can re-derive it.

- [ ] **Step 4: Verify the full suite one last time**

Run: `pnpm test && pnpm typecheck && pnpm check && pnpm check:prisma-schema`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md
git commit -m "Document Kanban column projection"
```

---

## Manual Verification

After Task 6, confirm the behavior the plan exists to fix:

1. Run `pnpm dev` and open a project's Kanban board.
2. Click Start on a Todo issue. The issue card should leave the Todo column as the workspace card appears — never both at once.
3. Watch the new card through provisioning and session startup. It should stay in Working continuously, with no flash into Waiting.
4. Confirm a workspace whose agent has finished a turn with no PR sits in Waiting labelled "Ready for next prompt".
5. Start the dev server on a workspace with an open, green PR. The card must stay in Waiting labelled "Ready to merge", with the green dev-server icon showing — the label must not change to "Dev server running".
