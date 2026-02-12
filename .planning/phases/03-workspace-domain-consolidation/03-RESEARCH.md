# Phase 3: Workspace Domain Consolidation - Research

**Researched:** 2026-02-10
**Domain:** TypeScript module consolidation, workspace lifecycle management, kanban state derivation, worktree management
**Confidence:** HIGH

## Summary

Phase 3 consolidates ~2,350 lines of workspace-related source code (plus ~1,800 lines of tests) from `src/backend/services/` into `src/backend/domains/workspace/`. This is significantly smaller and simpler than Phase 2 (session domain, ~15,000 lines) because the workspace files have a flatter dependency graph, fewer consumers, and no deeply nested subdirectories to preserve.

The workspace domain encompasses 9 source files spanning 4 conceptual areas: (1) workspace lifecycle -- creation, state machine, data access, and query; (2) worktree management -- worktree creation, cleanup, and archival; (3) kanban state derivation -- column computation and caching; and (4) activity/flow state tracking -- session activity monitoring and CI/PR flow state derivation. There are also workspace init policy functions that belong in this domain.

The biggest architectural concern is **cross-domain dependencies**. The session domain (already consolidated in Phase 2) imports `workspaceActivityService` and `getWorkspaceInitPolicy` from workspace services. Conversely, workspace services import `sessionService`, `sessionDomainService`, and `chatEventForwarderService` from the session domain. After consolidation, if workspace domain imports session domain and session domain imports workspace domain, the `no-cross-domain-imports` dependency-cruiser rule will fire. The solution during Phase 3 is to keep workspace services importing from the old session shims (which still exist in `src/backend/services/`), and NOT import from `@/backend/domains/session/`. The session domain's imports of workspace services will similarly go through the old paths until Phase 8 (Orchestration) properly untangles cross-domain flows.

**Primary recommendation:** Move files in 3 batches (pure functions/types first, then state machine/data layer, then lifecycle/query layer), leave re-export shims at old locations, eliminate 3 module-level global state items in `worktree-lifecycle.service.ts` and 1 in `workspace-query.service.ts` (DOM-04), and ensure `pnpm typecheck` passes after each batch. Include `workspace-init-policy.service.ts` in the consolidation since it is pure workspace logic.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 5.9.3 | Type system, path aliases, barrel files | Project standard |
| Vitest | 4.0.18 | Test runner with co-located tests | Project standard |
| Biome | 2.3.13 | Formatting and linting | Project standard |
| p-limit | (installed) | Concurrency limiting for git operations | Already used in `workspace-query.service.ts` |
| zod | (installed) | Schema validation for resume modes | Already used in `worktree-lifecycle.service.ts` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:events | built-in | EventEmitter for WorkspaceActivityService | Activity tracking events |
| node:fs/promises | built-in | File operations for worktree/resume modes | Worktree lifecycle |
| node:path | built-in | Path manipulation for worktree paths | Worktree path safety |
| @trpc/server | (installed) | TRPCError for validation errors | Workspace creation, archival |

### Alternatives Considered

None -- this phase exclusively reorganizes existing code. No new dependencies.

**Installation:**
```bash
# No new packages needed. All dependencies already installed.
```

## Architecture Patterns

### Recommended Domain Directory Structure

```
src/backend/domains/workspace/
├── index.ts                              # Barrel: public API for all consumers
│
├── state/                                # Pure state derivation (no side effects, no DB)
│   ├── kanban-state.ts                   # computeKanbanColumn() pure function
│   ├── kanban-state.test.ts              # Existing tests
│   ├── flow-state.ts                     # deriveWorkspaceFlowState() pure functions
│   ├── flow-state.test.ts               # Existing tests
│   └── init-policy.ts                    # getWorkspaceInitPolicy() pure function
│   └── init-policy.test.ts              # Existing tests
│
├── lifecycle/                            # Workspace lifecycle management
│   ├── state-machine.service.ts          # WorkspaceStateMachineService (status transitions)
│   ├── state-machine.service.test.ts     # Existing tests
│   ├── creation.service.ts               # WorkspaceCreationService (creation orchestration)
│   ├── creation.service.test.ts          # Existing tests
│   ├── data.service.ts                   # WorkspaceDataService (CRUD thin wrapper)
│   └── activity.service.ts              # WorkspaceActivityService (session activity tracking)
│   └── activity.service.test.ts         # Existing tests
│
├── worktree/                             # Worktree management
│   ├── worktree-lifecycle.service.ts     # WorktreeLifecycleService + init/cleanup functions
│   ├── worktree-lifecycle.service.test.ts # Existing tests
│   └── worktree-init.test.ts            # Existing init integration tests
│
├── query/                                # Workspace query/aggregation
│   └── workspace-query.service.ts        # WorkspaceQueryService (summary, kanban list, PR sync)
│
└── workspace-domain-exports.test.ts      # Barrel smoke test (WORK-05)
```

### Pattern 1: Re-export Shims at Old Paths

**What:** After moving a file, leave a re-export shim at the original location so downstream consumers continue to compile.

**When to use:** For every moved file that has external consumers.

**Example:**
```typescript
// src/backend/services/workspace-state-machine.service.ts (SHIM - after move)
/**
 * @deprecated Import from '@/backend/domains/workspace' instead.
 * This re-export shim will be removed in Phase 9 (Import Rewiring).
 */
export {
  workspaceStateMachine,
  WorkspaceStateMachineError,
  type TransitionOptions,
  type StartProvisioningOptions,
} from '@/backend/domains/workspace';
```

### Pattern 2: Instance-Based State (DOM-04)

**What:** Replace module-level Maps, caches, and mutable variables with instance fields on the service class.

**When to use:** Required by DOM-04. Apply to `worktree-lifecycle.service.ts` (3 global items) and `workspace-query.service.ts` (1 global item).

**Example (before -- worktree-lifecycle.service.ts):**
```typescript
const workspaceInitModes = new Map<string, boolean>();
const resumeModeLocks = new Map<string, Promise<void>>();
let cachedGitHubUsername: string | null | undefined;
```

**Example (after):**
```typescript
export class WorktreeLifecycleService {
  private readonly initModes = new Map<string, boolean>();
  private readonly resumeModeLocks = new Map<string, Promise<void>>();
  private cachedGitHubUsername: string | null | undefined;
  // ... methods that previously used module-level state now use this.initModes, etc.
}
```

**Example (before -- workspace-query.service.ts):**
```typescript
let cachedReviewCount: { count: number; fetchedAt: number } | null = null;
```

**Example (after):**
```typescript
class WorkspaceQueryService {
  private cachedReviewCount: { count: number; fetchedAt: number } | null = null;
  // ...
}
```

### Pattern 3: Cross-Domain Imports Stay on Old Paths

**What:** When workspace files import from session domain (or vice versa), keep using the old `src/backend/services/` shim paths during Phase 3. Do not create direct `@/backend/domains/session/` imports from workspace domain files.

**When to use:** Always, during consolidation phases. Cross-domain wiring is Phase 8's responsibility.

**Why:** The dependency-cruiser rule `no-cross-domain-imports` forbids `src/backend/domains/workspace/` from importing `src/backend/domains/session/`. The old shim paths in `src/backend/services/` are NOT under `src/backend/domains/` so they don't trigger the rule.

**Example:**
```typescript
// src/backend/domains/workspace/query/workspace-query.service.ts
// CORRECT: Import through shim (not in domains/ path)
import { sessionService } from '@/backend/services/session.service';

// WRONG: Would violate no-cross-domain-imports
// import { sessionService } from '@/backend/domains/session';
```

### Pattern 4: Dependency-Order File Movement

**What:** Move files in layers from lowest dependency to highest, ensuring each layer compiles before proceeding.

**When to use:** Always, for consolidation phases.

**Batch order for workspace domain:**
1. **Pure state functions** (`flow-state.ts`, `kanban-state.ts`, `init-policy.ts`) -- no internal deps, pure functions
2. **State machine + data layer** (`state-machine.service.ts`, `data.service.ts`, `activity.service.ts`) -- depend on accessors only
3. **Lifecycle + query layer** (`creation.service.ts`, `worktree-lifecycle.service.ts`, `workspace-query.service.ts`) -- depend on state machine, data, flow state, and cross-domain services

### Anti-Patterns to Avoid

- **Renaming/refactoring logic during the move:** Do not change behavior, APIs, or internal logic. Move files, update imports, leave shims. The DOM-04 global state refactoring is the one exception.
- **Importing from `@/backend/domains/session/` directly:** This would violate the no-cross-domain-imports rule. Keep using shim paths.
- **Moving `initializeWorkspaceWorktree` from `init.trpc.ts`:** The `init.trpc.ts` file is a tRPC router, not a service. The `workspace-creation.service.ts` dynamically imports it. Do not move the router into the domain.
- **Flattening worktree helper functions into the class prematurely:** The free functions in `worktree-lifecycle.service.ts` (like `readResumeModes`, `writeResumeModes`, `withResumeModeLock`, `buildInitialPromptFromGitHubIssue`, `startDefaultClaudeSession`) should become private methods on the class as part of the DOM-04 refactor, since they use the module-level state.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Import path updates | Manual search-replace | TypeScript compiler errors (`pnpm typecheck`) | Compiler catches every broken import |
| Circular dependency detection | Manual review | dependency-cruiser (`pnpm deps:check`) | Already configured with no-circular and no-cross-domain-imports rules |
| Re-export validation | Manual checking | `pnpm typecheck` + existing tests | Type system validates all re-exports |
| Concurrency limiting for git ops | Custom solution | p-limit (already in use) | Already battle-tested in workspace-query.service.ts |

**Key insight:** The TypeScript compiler is the primary validation tool for this phase. Every moved file and every re-export shim is validated by `pnpm typecheck`. Run it after every batch.

## Common Pitfalls

### Pitfall 1: Cross-Domain Circular Dependency via Barrel Imports

**What goes wrong:** After moving workspace files into the domain, if you update imports to use `@/backend/domains/session/` instead of the old shim paths, the dependency-cruiser `no-cross-domain-imports` rule fires.
**Why it happens:** Session domain's `chat-event-forwarder.service.ts` imports `workspaceActivityService`, and workspace services import `sessionService`. Both are legitimate dependencies, but direct cross-domain imports are forbidden until Phase 8 (Orchestration).
**How to avoid:** Keep all cross-domain imports going through the old `src/backend/services/` shim paths. The shim files re-export from the domain but are NOT under `src/backend/domains/`, so they don't trigger the rule.
**Warning signs:** `pnpm deps:check` failures mentioning `no-cross-domain-imports`.

### Pitfall 2: WorktreeLifecycleService Free Functions Referencing Module-Level State

**What goes wrong:** `worktree-lifecycle.service.ts` has ~10 free functions (not class methods) that reference module-level `workspaceInitModes` Map, `resumeModeLocks` Map, and `cachedGitHubUsername`. When refactoring for DOM-04, these functions must become instance methods or receive the state as parameters.
**Why it happens:** The file mixes class methods (`WorktreeLifecycleService`) with standalone functions that share module-level state. The standalone functions are called by the class and by external consumers (e.g., `setWorkspaceInitMode` is exported and called by `workspace-creation.service.ts`).
**How to avoid:** Move the exported free functions (`setWorkspaceInitMode`, `getWorkspaceInitMode`, `assertWorktreePathSafe`, `WorktreePathSafetyError`) into the class. `assertWorktreePathSafe` and `WorktreePathSafetyError` don't use module state and can stay as standalone exports, but the init-mode functions must become methods on the class since they need the Map.
**Warning signs:** Tests failing because mock paths change, or runtime errors because the `this` context is lost.

### Pitfall 3: Dynamic Import of `init.trpc.ts` in WorkspaceCreationService

**What goes wrong:** `workspace-creation.service.ts` line 263 uses `import('../trpc/workspace/init.trpc')` dynamically to avoid a circular dependency. After moving the file to `domains/workspace/lifecycle/creation.service.ts`, this relative path changes.
**Why it happens:** The relative path `../trpc/workspace/init.trpc` is relative to `src/backend/services/`. After moving to `src/backend/domains/workspace/lifecycle/`, the relative path would be `../../../trpc/workspace/init.trpc`.
**How to avoid:** Switch to an absolute path alias: `import('@/backend/trpc/workspace/init.trpc')`. This is more robust and doesn't break when files move.
**Warning signs:** Runtime `ERR_MODULE_NOT_FOUND` when creating workspaces (not caught by typecheck since it's a dynamic import).

### Pitfall 4: Test Mocking Paths Change

**What goes wrong:** Tests that `vi.mock('./worktree-lifecycle.service')` or `vi.mock('./workspace-state-machine.service')` will fail when files move because the mock path must match the actual module path.
**Why it happens:** Vitest resolves mock paths relative to the actual file system. When files move, co-located tests that move with them need updated mock paths for their siblings.
**How to avoid:** When moving a file, update its co-located tests at the same time. For tests in other locations that mock moved modules, the re-export shims at old paths mean the old mock paths continue to work until Phase 9.
**Warning signs:** Tests failing with "cannot find module" errors in mock declarations.

### Pitfall 5: `chatEventForwarderService.getAllPendingRequests()` is a Cross-Domain Call

**What goes wrong:** `workspace-query.service.ts` calls `chatEventForwarderService.getAllPendingRequests()` and `sessionService.isAnySessionWorking()`. These are session-domain services. After moving workspace-query into the workspace domain, these become cross-domain calls.
**Why it happens:** Workspace query aggregation inherently needs session activity data to compute the `isWorking` status.
**How to avoid:** During Phase 3, keep importing through the old shim paths. This is explicitly a Phase 8 (Orchestration) concern. The workspace domain legitimately needs to query session state; the orchestration layer will formalize this.
**Warning signs:** None during Phase 3 if shim paths are used.

### Pitfall 6: `kanbanStateService` Imported by `pr-snapshot.service.ts` (Outside Workspace Domain)

**What goes wrong:** `pr-snapshot.service.ts` (which will move to the GitHub domain in Phase 4) imports `kanbanStateService`. After Phase 3, it needs to import through the workspace domain barrel or the old shim.
**Why it happens:** PR state changes trigger kanban column cache updates -- a cross-domain flow.
**How to avoid:** Leave the shim at `src/backend/services/kanban-state.service.ts`. `pr-snapshot.service.ts` continues to import from there.
**Warning signs:** `pnpm typecheck` failure if shim is missing.

## Code Examples

### Workspace Domain Barrel File (Public API)

```typescript
// src/backend/domains/workspace/index.ts
// Domain: workspace
// Public API for the workspace domain module.
// Consumers should import from '@/backend/domains/workspace' only.

// State derivation (pure functions)
export { computeKanbanColumn, type KanbanStateInput, type WorkspaceWithKanbanState } from './state/kanban-state';
export {
  deriveWorkspaceFlowState,
  deriveWorkspaceFlowStateFromWorkspace,
  type WorkspaceFlowPhase,
  type WorkspaceFlowState,
  type WorkspaceFlowStateInput,
  type WorkspaceFlowStateSource,
  type WorkspaceCiObservation,
} from './state/flow-state';
export { getWorkspaceInitPolicy, type WorkspaceInitPolicy, type WorkspaceInitPolicyInput } from './state/init-policy';

// Workspace lifecycle
export {
  workspaceStateMachine,
  WorkspaceStateMachineError,
  type TransitionOptions,
  type StartProvisioningOptions,
} from './lifecycle/state-machine.service';
export {
  WorkspaceCreationService,
  type WorkspaceCreationSource,
  type WorkspaceCreationResult,
  type WorkspaceCreationDependencies,
} from './lifecycle/creation.service';
export { workspaceDataService } from './lifecycle/data.service';
export { workspaceActivityService } from './lifecycle/activity.service';

// Worktree management
export {
  worktreeLifecycleService,
  assertWorktreePathSafe,
  WorktreePathSafetyError,
} from './worktree/worktree-lifecycle.service';

// Workspace query/aggregation
export { workspaceQueryService } from './query/workspace-query.service';

// Kanban state service (class instance for caching operations)
export { kanbanStateService } from './state/kanban-state';
```

### Re-export Shim Example

```typescript
// src/backend/services/workspace-state-machine.service.ts (SHIM after move)
/**
 * @deprecated Import from '@/backend/domains/workspace' instead.
 * This re-export shim will be removed in Phase 9 (Import Rewiring).
 */
export {
  workspaceStateMachine,
  WorkspaceStateMachineError,
  type TransitionOptions,
  type StartProvisioningOptions,
} from '@/backend/domains/workspace';
```

### DOM-04: WorktreeLifecycleService Refactored

```typescript
// src/backend/domains/workspace/worktree/worktree-lifecycle.service.ts (REFACTORED)
export class WorktreeLifecycleService {
  // DOM-04: Module-level state moved to instance fields
  private readonly initModes = new Map<string, boolean>();
  private readonly resumeModeLocks = new Map<string, Promise<void>>();
  private cachedGitHubUsername: string | null | undefined;

  async setInitMode(
    workspaceId: string,
    useExistingBranch: boolean | undefined,
    worktreeBasePath?: string
  ): Promise<void> {
    if (useExistingBranch === undefined) return;
    this.initModes.set(workspaceId, useExistingBranch);
    // ... file persistence logic unchanged
  }

  async getInitMode(workspaceId: string, worktreeBasePath?: string): Promise<boolean | undefined> {
    if (this.initModes.has(workspaceId)) {
      return this.initModes.get(workspaceId);
    }
    // ... database/file fallback unchanged
  }

  // ... all other methods that used module-level state now use this.*
}

export const worktreeLifecycleService = new WorktreeLifecycleService();
```

### Domain Smoke Test

```typescript
// src/backend/domains/workspace/workspace-domain-exports.test.ts
import { describe, expect, it } from 'vitest';
import {
  computeKanbanColumn,
  deriveWorkspaceFlowState,
  getWorkspaceInitPolicy,
  workspaceStateMachine,
  workspaceDataService,
  workspaceActivityService,
  worktreeLifecycleService,
  workspaceQueryService,
  kanbanStateService,
  WorkspaceStateMachineError,
  WorktreePathSafetyError,
  assertWorktreePathSafe,
} from './index';

describe('Workspace domain exports', () => {
  it('exports computeKanbanColumn as a function', () => {
    expect(typeof computeKanbanColumn).toBe('function');
  });
  it('exports deriveWorkspaceFlowState as a function', () => {
    expect(typeof deriveWorkspaceFlowState).toBe('function');
  });
  it('exports getWorkspaceInitPolicy as a function', () => {
    expect(typeof getWorkspaceInitPolicy).toBe('function');
  });
  it('exports workspaceStateMachine as an object', () => {
    expect(workspaceStateMachine).toBeDefined();
  });
  // ... assertions for all exports
});
```

## Consolidation Inventory

### Files Moving Into Domain (with source and target)

| Source | Target Subdirectory | Lines | External Consumers |
|--------|-------------------|-------|-----------|
| `services/workspace-flow-state.service.ts` | `state/flow-state.ts` | 168 | 3 (workspace-query, kanban-state, workspace.trpc) |
| `services/workspace-flow-state.service.test.ts` | `state/flow-state.test.ts` | 140 | 0 |
| `services/kanban-state.service.ts` | `state/kanban-state.ts` | 185 | 3 (pr-snapshot, workspace-query, app-context) |
| `services/kanban-state.service.test.ts` | `state/kanban-state.test.ts` | 238 | 0 |
| `services/workspace-init-policy.service.ts` | `state/init-policy.ts` | 112 | 2 (chat-message-handlers, init.trpc) |
| `services/workspace-init-policy.service.test.ts` | `state/init-policy.test.ts` | 40 | 0 |
| `services/workspace-state-machine.service.ts` | `lifecycle/state-machine.service.ts` | 269 | 5 (app-context, init.trpc, reconciliation, startup-script, worktree-lifecycle) |
| `services/workspace-state-machine.service.test.ts` | `lifecycle/state-machine.service.test.ts` | 518 | 0 |
| `services/workspace-creation.service.ts` | `lifecycle/creation.service.ts` | 288 | 1 (workspace.trpc) |
| `services/workspace-creation.service.test.ts` | `lifecycle/creation.service.test.ts` | 409 | 0 |
| `services/workspace-data.service.ts` | `lifecycle/data.service.ts` | 33 | 9 (terminal.handler, admin.trpc, workspace.trpc, github.trpc, session.trpc, init.trpc, ide.trpc, workspace-helpers, git.trpc) |
| `services/workspace-activity.service.ts` | `lifecycle/activity.service.ts` | 120 | 2 (services/index, chat-event-forwarder) |
| `services/workspace-activity.service.test.ts` | `lifecycle/activity.service.test.ts` | 41 | 0 |
| `services/worktree-lifecycle.service.ts` | `worktree/worktree-lifecycle.service.ts` | 818 | 3 (workspace-creation, workspace.trpc, init.trpc) |
| `services/worktree-lifecycle.service.test.ts` | `worktree/worktree-lifecycle.service.test.ts` | 110 | 0 |
| `services/worktree-lifecycle-init.test.ts` | `worktree/worktree-init.test.ts` | 292 | 0 |
| `services/workspace-query.service.ts` | `query/workspace-query.service.ts` | 361 | 1 (workspace.trpc) |
| **Total** | | **Source: 2,354 + Tests: 1,788** | |

### Global State to Eliminate (DOM-04)

| File | Global State | Replacement |
|------|-------------|-------------|
| `worktree-lifecycle.service.ts` | `const workspaceInitModes = new Map<string, boolean>()` | Instance field `this.initModes` on `WorktreeLifecycleService` |
| `worktree-lifecycle.service.ts` | `const resumeModeLocks = new Map<string, Promise<void>>()` | Instance field `this.resumeModeLocks` on `WorktreeLifecycleService` |
| `worktree-lifecycle.service.ts` | `let cachedGitHubUsername: string \| null \| undefined` | Instance field `this.cachedGitHubUsername` on `WorktreeLifecycleService` |
| `workspace-query.service.ts` | `let cachedReviewCount: {...} \| null = null` | Instance field `this.cachedReviewCount` on `WorkspaceQueryService` |

Note: `workspace-activity.service.ts` already uses instance-based state (`private workspaceStates = new Map()` inside the class). `kanban-state.service.ts` has no module-level state. `workspace-state-machine.service.ts` has no module-level state.

### Cross-Domain Dependencies (Critical for Phase 8 Planning)

| Workspace Service | Imports From Session Domain | Import Used For |
|-------------------|---------------------------|-----------------|
| `workspace-query.service.ts` | `sessionService` | `isAnySessionWorking()` |
| `workspace-query.service.ts` | `chatEventForwarderService` | `getAllPendingRequests()` |
| `worktree-lifecycle.service.ts` | `sessionService` | `startClaudeSession()`, `stopWorkspaceSessions()` |
| `worktree-lifecycle.service.ts` | `sessionDomainService` | `enqueue()`, `emitDelta()` |
| `worktree-lifecycle.service.ts` | `chatMessageHandlerService` | `tryDispatchNextMessage()` |
| `kanban-state.service.ts` | `sessionService` | `isAnySessionWorking()` |

| Session Domain Service | Imports From Workspace | Import Used For |
|-----------------------|----------------------|-----------------|
| `chat-event-forwarder.service.ts` | `workspaceActivityService` | `markSessionRunning()`, `markSessionIdle()` |
| `chat-message-handlers.service.ts` | `getWorkspaceInitPolicy` | `dispatchPolicy` check |

**Strategy:** During Phase 3, all cross-domain imports remain on old `src/backend/services/` shim paths. Phase 8 will introduce an orchestration layer to properly manage these flows.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Workspace logic in flat services/ | Single domain module | Phase 3 (this phase) | All workspace operations in one place |
| Module-level Maps in worktree-lifecycle.ts | Instance-based state on class | Phase 3 (DOM-04) | Testable, no global state |
| Module-level cache in workspace-query.ts | Instance field on class | Phase 3 (DOM-04) | Testable, no global state |
| Direct imports to scattered files | Barrel file at `@/backend/domains/workspace` | Phase 3 | Single import path for consumers |

## Open Questions

1. **Should `workspace-init-policy.service.ts` be included in Phase 3?**
   - What we know: It's not in the ROADMAP's Phase 3 source file list, but it is pure workspace logic (derives init phase from workspace status). It's imported by session domain's `chat-message-handlers.service.ts` and by `init.trpc.ts`.
   - What's unclear: Whether the ROADMAP omission was intentional.
   - Recommendation: Include it. It's a pure workspace concern (takes workspace status, returns workspace init phase). The session domain will continue to import it through the old shim path. This keeps all workspace state derivation co-located.

2. **Should `setWorkspaceInitMode`/`getWorkspaceInitMode` be exported standalone or only as methods on `worktreeLifecycleService`?**
   - What we know: Currently they are free functions exported separately. They're imported by `workspace-creation.service.ts` and `init.trpc.ts`.
   - What's unclear: Whether callers should use `worktreeLifecycleService.setInitMode()` or a standalone function.
   - Recommendation: Make them methods on `WorktreeLifecycleService` (DOM-04 requires this since they use the module-level Map). Export `worktreeLifecycleService` instance from the barrel. The shim at the old path can re-export a wrapper: `export const setWorkspaceInitMode = (...args) => worktreeLifecycleService.setInitMode(...args)`.

3. **How to handle the dynamic import of `init.trpc.ts` in `workspace-creation.service.ts`?**
   - What we know: Line 263 uses `import('../trpc/workspace/init.trpc')` to avoid circular dependencies at module load time. After moving the file, the relative path breaks.
   - What's unclear: Whether switching to `import('@/backend/trpc/workspace/init.trpc')` works for dynamic imports (it should, since TypeScript path aliases are resolved by the bundler).
   - Recommendation: Switch to absolute path alias `import('@/backend/trpc/workspace/init.trpc')`. This is the standard pattern and works with the project's path aliasing.

4. **Should the `computePendingRequestType()` helper function in `workspace-query.service.ts` be extracted?**
   - What we know: It's a module-internal helper function (not exported). It takes session IDs and pending requests, returns a request type.
   - What's unclear: Whether it should be extracted to the state/ subdirectory.
   - Recommendation: Keep it as a private helper in the query service. It's only used there and isn't reusable elsewhere.

## Sources

### Primary (HIGH confidence)
- All 9 source files and 8 test files read and analyzed in full
- `src/backend/domains/session/index.ts` -- barrel file pattern established in Phase 2
- `src/backend/domains/session/session-domain.service.ts` -- domain service pattern
- `.dependency-cruiser.cjs` -- `no-cross-domain-imports` rule (line 100-111)
- `knip.json` -- ignores already include `src/backend/domains/*/index.ts`
- `.planning/phases/02-session-domain-consolidation/02-RESEARCH.md` -- Phase 2 patterns and conventions
- `.planning/phases/02-session-domain-consolidation/02-VERIFICATION.md` -- Phase 2 verified patterns
- `.planning/ROADMAP.md` -- Phase 3 requirements and prior decisions
- Import graph analysis via grep across entire `src/` directory

### Secondary (MEDIUM confidence)
- None needed. All findings from codebase analysis.

### Tertiary (LOW confidence)
- None. All findings verified against codebase.

## Metadata

**Confidence breakdown:**
- File inventory and import graph: HIGH -- every file read and grep-verified
- Directory structure: HIGH -- follows established Phase 2 domain pattern
- Re-export shim pattern: HIGH -- proven in Phase 2
- DOM-04 global state identification: HIGH -- grep-verified all module-level state
- Cross-domain dependency analysis: HIGH -- grep-verified all imports in both directions
- Move ordering: HIGH -- based on actual import graph analysis

**Research date:** 2026-02-10
**Valid until:** 2026-04-10 (stable codebase, no external dependency changes expected)
