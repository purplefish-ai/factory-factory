# Issue #1889: Unify Snapshot Cache Merge Strategy & Session-Status Derivation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One merge strategy per React Query cache (WS-patched deltas, refetch-heal on reconnect baseline), one shared session-status derivation, and one ratchet-toggle path guarded against snapshot overwrites.

**Architecture:** The `/snapshots` WS hook becomes pure-patch for delta messages and adds an explicit reconnect heal (invalidate the `staleTime: Infinity` caches only on the first `snapshot_full` after a disconnect). Session status gets a canonical `SessionUiStatusKind` in `src/shared/session-runtime.ts` consumed by both the chat reducer and the session-tab presenter; the `liveSessionRuntimeById` map + timestamp merge is replaced by a "live overlay for the selected, connected session only" rule. Ratchet toggling moves to a shared `useToggleRatcheting` hook with a module-level pending-toggle registry that the snapshot hook consults before applying entries.

**Tech Stack:** TypeScript, React, tRPC + React Query, Vitest, Biome.

## Global Constraints

- Barrel-import rules per AGENTS.md; client code stays in `src/client/`, shared logic in `src/shared/`.
- Schemas use Zod; no raw typecasts beyond existing patterns.
- Run `pnpm test`, `pnpm typecheck`, `pnpm check` before finishing.
- Commit messages: short imperative, reference `#1889`.

---

### Task 1: Canonical session-status kind in shared/session-runtime

**Files:**
- Modify: `src/shared/session-runtime.ts`
- Test: `src/shared/session-runtime.test.ts`

**Interfaces:**
- Produces: `SessionUiStatusKind` union, `deriveSessionUiStatusKind(input: SessionUiStatusInput): SessionUiStatusKind`, `sessionUiStatusKindFromSummary(summary): SessionUiStatusKind`.
- `SessionUiStatusInput = { phase, processState, activity, lastExit?: SessionRuntimeLastExit | null }`.

- [ ] Write failing tests in `src/shared/session-runtime.test.ts` covering precedence: loading > starting > stopping > error > stopped (unexpected-exit vs stopped) > working (activity WORKING or phase running) > idle. Include: `phase: 'running', processState: 'stopped'` → `'stopped'`; `phase: 'idle', activity: 'WORKING'` → `'working'`.
- [ ] Run `pnpm vitest run src/shared/session-runtime.test.ts` — expect FAIL (function not defined).
- [ ] Implement in `src/shared/session-runtime.ts`:

```ts
export type SessionUiStatusKind =
  | 'loading' | 'starting' | 'stopping' | 'error'
  | 'unexpected-exit' | 'stopped' | 'working' | 'idle';

export interface SessionUiStatusInput {
  phase: SessionRuntimePhase;
  processState: SessionRuntimeProcessState;
  activity: SessionRuntimeActivity;
  lastExit?: SessionRuntimeLastExit | null;
}

export function deriveSessionUiStatusKind(input: SessionUiStatusInput): SessionUiStatusKind {
  if (input.phase === 'loading' || input.phase === 'starting' || input.phase === 'stopping') {
    return input.phase;
  }
  if (input.phase === 'error') {
    return 'error';
  }
  if (input.processState === 'stopped') {
    return input.lastExit?.unexpected ? 'unexpected-exit' : 'stopped';
  }
  if (input.activity === 'WORKING' || input.phase === 'running') {
    return 'working';
  }
  return 'idle';
}

export function sessionUiStatusKindFromSummary(
  summary: Pick<SessionSummary, 'runtimePhase' | 'processState' | 'activity' | 'lastExit'>
): SessionUiStatusKind {
  return deriveSessionUiStatusKind({
    phase: summary.runtimePhase,
    processState: summary.processState,
    activity: summary.activity,
    lastExit: summary.lastExit,
  });
}
```

- [ ] Tests pass; commit `Add canonical SessionUiStatusKind derivation (#1889)`.

### Task 2: Session tab presenter consumes the shared kind

**Files:**
- Modify: `src/components/workspace/session-tab-runtime.ts`
- Test: `src/components/workspace/session-tab-runtime.test.ts` (existing — must stay green)

- [ ] Rewrite `deriveSessionTabRuntime` body as a `switch` on `sessionUiStatusKindFromSummary(summary)` producing the exact same `SessionTabRuntimeInfo` objects as today (loading/starting/stopping spinners, error + unexpected-exit via `getSessionSummaryErrorMessage`, stopped, working=Running, idle). No presentation changes.
- [ ] Run existing `session-tab-runtime.test.ts` — expect PASS (pure refactor).
- [ ] Commit `Derive session tab runtime from shared status kind (#1889)`.

### Task 3: Chat reducer consumes the shared kind

**Files:**
- Modify: `src/components/chat/reducer/slices/session.ts`

- [ ] Replace local `deriveSessionStatus` switch with mapping over `deriveSessionUiStatusKind(runtime)`:

```ts
function deriveSessionStatus(runtime: ChatState['sessionRuntime']): ChatState['sessionStatus'] {
  switch (deriveSessionUiStatusKind(runtime)) {
    case 'loading': return { phase: 'loading' };
    case 'starting': return { phase: 'starting' };
    case 'stopping': return { phase: 'stopping' };
    case 'working': return { phase: 'running' };
    default: return { phase: 'ready' };
  }
}
```

Intentional semantic unification: `phase: 'idle', activity: 'WORKING'` now reports `running` (previously `ready`) — matches the tab presenter.
- [ ] Run full chat reducer tests (`pnpm vitest run src/components/chat`) — expect PASS.
- [ ] Commit `Unify chat reducer session status with shared kind (#1889)`.

### Task 4: Replace liveSessionRuntimeById map with selected-session overlay

**Files:**
- Modify: `src/client/routes/projects/workspaces/workspace-detail-container.utils.ts`
- Modify: `src/client/routes/projects/workspaces/workspace-detail-container.tsx`
- Test: `src/client/routes/projects/workspaces/workspace-detail-container.utils.test.ts`

**Interfaces:**
- Produces: `buildSessionSummariesById({ workspaceSummaries, sessions, selectedSessionId, liveRuntime, chatConnected }): Map<string, WorkspaceSessionRuntimeSummary>`.
- Rule: snapshot `sessionSummaries` are the base; the chat WS runtime overlays **only** the currently selected session and **only** while the chat socket is connected. No timestamp comparison.

- [ ] Write failing tests: base map from summaries; overlay applied for selected+connected; not applied when disconnected; not applied for non-selected sessions; overlay creates entry when summary missing but session exists; metadata (name/workflow/model/provider/persistedStatus) preserved from summary, falling back to session row.
- [ ] Implement `buildSessionSummariesById` in the utils file (field mapping identical to current `mergeSessionSummariesWithLiveRuntime` overlay body).
- [ ] In the container: delete `areRuntimeStatesEqual`, `isLiveRuntimeNewerOrEqual`, `mergeSessionSummariesWithLiveRuntime`, `SessionForRuntimeOverlay` (move to utils), the `liveSessionRuntimeById` state and both sync effects; compute `sessionSummariesById` via `useMemo` over the new function.
- [ ] Run tests + typecheck; commit `Replace live-runtime map with selected-session overlay (#1889)`.

### Task 5: Pending ratchet-toggle registry + snapshot guard helpers

**Files:**
- Modify: `src/client/lib/ratchet-toggle-cache.ts`
- Test: `src/client/lib/ratchet-toggle-cache.test.ts`

**Interfaces:**
- Produces: `setPendingRatchetToggle(id, enabled)`, `clearPendingRatchetToggle(id)`, `resetPendingRatchetTogglesForTests()`, and `overridePendingRatchetToggle<T extends Omit<RatchetToggleCacheShape,'id'> & { workspaceId: string }>(entry: T): T` — returns entry unchanged when no pending toggle or values agree, otherwise `applyRatchetToggleState(entry, pending)`.

- [ ] Failing tests: no pending → identity; pending equal to entry value → identity (same reference); pending differs → ratchetEnabled/ratchetState/ratchetButtonAnimated/sidebarStatus overridden per `applyRatchetToggleState`; clear removes override.
- [ ] Implement with a module-level `Map<string, boolean>`.
- [ ] Tests pass; commit `Add pending ratchet-toggle registry with snapshot override (#1889)`.

### Task 6: Shared useToggleRatcheting hook; unify both call sites

**Files:**
- Create: `src/client/hooks/use-toggle-ratcheting.ts`
- Modify: `src/client/routes/projects/workspaces/workspace-detail-header/ratcheting-toggle.tsx`
- Modify: `src/client/components/kanban/kanban-context.tsx`

**Interfaces:**
- Produces: `useToggleRatcheting(projectId: string)` → tRPC mutation for `workspace.toggleRatcheting` with: onMutate = register pending + optimistic setData on `workspace.get`, `listWithKanbanState`, `getProjectSummaryState`; onSettled = clear pending + invalidate those three.

- [ ] Implement hook (optimistic bodies copied from current `ratcheting-toggle.tsx` onMutate).
- [ ] `ratcheting-toggle.tsx`: replace inline mutation with the hook (`useToggleRatcheting(workspace.projectId)`); rendering unchanged.
- [ ] `kanban-context.tsx`: replace `trpc.workspace.toggleRatcheting.useMutation()` + manual `refetchWorkspaces`/invalidate block with the hook; keep `togglingWorkspaceId` try/finally around `mutateAsync`.
- [ ] `pnpm typecheck` + targeted tests pass; commit `Unify ratchet toggle paths on shared optimistic hook (#1889)`.

### Task 7: Snapshot sync — pure-patch deltas, reconnect heal, ratchet guard

**Files:**
- Modify: `src/client/hooks/use-project-snapshot-sync.ts`
- Test: `src/client/hooks/use-project-snapshot-sync.test.ts`

**Behavior:**
1. Delete `invalidateWorkspaceListCaches` from `snapshot_changed`/`snapshot_removed` paths (deltas are pure setData patches). Drop `listWithRuntimeState` invalidation everywhere (no consumers).
2. Track disconnects: `onDisconnected` sets `staleSinceDisconnectRef.current = true`. On `snapshot_full`, if the flag is set, after patching call a `healStaleCachesAfterReconnect(utils, projectId)` that invalidates `workspace.get` (all ids), `workspace.list({projectId})`, `workspace.getProjectSummaryState({projectId})`, `workspace.listWithKanbanState({projectId})`, then clear the flag. Initial connect does not invalidate.
3. Apply `overridePendingRatchetToggle` to every entry before mapping (both `snapshot_full` entries and `snapshot_changed` entry).

- [ ] Update/extend tests: per-delta invalidation assertions flipped to "not called"; snapshot_full without prior disconnect → no invalidations; snapshot_full after `onDisconnected` fired → all four invalidations, and a second snapshot_full → none; pending ratchet toggle overrides entry values passed to setData updaters.
- [ ] Implement; run suite; commit `Snapshot deltas pure-patch; heal caches on reconnect baseline (#1889)`.

### Task 8: Full verification

- [ ] `pnpm test` — all green.
- [ ] `pnpm typecheck` — clean.
- [ ] `pnpm check` / `pnpm check:fix` — clean.
- [ ] Open PR referencing #1889 with summary of the four issue points and how each is addressed.
