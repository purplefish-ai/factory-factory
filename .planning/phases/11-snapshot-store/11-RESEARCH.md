# Phase 11: Snapshot Store - Research

**Researched:** 2026-02-11
**Domain:** In-memory materialized view service for workspace state
**Confidence:** HIGH

## Summary

Phase 11 creates a per-workspace in-memory snapshot store as an infrastructure service in `src/backend/services/`. The store holds one entry per workspace keyed by `workspaceId`, scoped by `projectId`, with monotonically increasing version counters and debug metadata. Each entry includes derived state fields (sidebarStatus, kanbanColumn, flowPhase, ciObservation) that recompute when underlying fields change. The store must have zero imports from `@/backend/domains/` (ARCH-02).

The codebase already has all the pure derivation functions needed: `deriveWorkspaceFlowState()` in `src/backend/domains/workspace/state/flow-state.ts`, `computeKanbanColumn()` in `src/backend/domains/workspace/state/kanban-state.ts`, and `deriveWorkspaceSidebarStatus()` in `src/shared/workspace-sidebar-status.ts`. These are pure functions with no side effects and no domain imports of their own (flow-state imports only Prisma enums; kanban-state imports Prisma enums + workspace accessor for the service class but `computeKanbanColumn` itself is pure; sidebar-status imports only from `@prisma-gen/browser` and `@/shared/`). The challenge is that ARCH-02 says the snapshot service cannot import from `@/backend/domains/`, so the derivation functions must either be relocated to `src/shared/` or injected via a configuration callback.

The existing `getProjectSummaryState()` in `workspace-query.service.ts` produces the exact shape the snapshot should materialize. It currently recomputes everything on each call (DB queries + git stats + session working status + flow state + kanban + sidebar status + pending requests). The snapshot store replaces this with a pre-computed, event-updated cache.

**Primary recommendation:** Build a class-based `WorkspaceSnapshotStore` in `src/backend/services/workspace-snapshot-store.service.ts` using a `Map<string, WorkspaceSnapshotEntry>` with a `Map<string, Map<string, WorkspaceSnapshotEntry>>` index for project-level lookups. Inject derivation functions via a `configure()` call (matching the bridge pattern used throughout the codebase) to satisfy ARCH-02. Expose `upsert()`, `remove()`, `getByWorkspaceId()`, `getByProjectId()`, and `getVersion()` methods. Emit events on change for downstream consumers (Phase 15 WebSocket transport).

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | (project version) | Type-safe snapshot entry shapes | Already used everywhere |
| Node.js EventEmitter | built-in | Change notification for downstream consumers | Already used by WorkspaceActivityService |
| Vitest | (project version) | Co-located unit tests | Project standard |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Zod | (project version) | Optional: validate snapshot entry shape at boundaries | If runtime validation is desired |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Plain Map | WeakMap | WeakMap cannot be iterated -- need `getByProjectId()`, so Map is required |
| EventEmitter | Callback registry | EventEmitter is already the codebase pattern (WorkspaceActivityService), no reason to diverge |
| Class singleton | Module-level functions | Class singleton is the codebase convention (see `schedulerService`, `notificationService`, `kanbanStateService`) |

## Architecture Patterns

### Recommended Project Structure
```
src/backend/services/
  workspace-snapshot-store.service.ts       # The store + types + singleton export
  workspace-snapshot-store.service.test.ts   # Co-located tests
```

### Pattern 1: Singleton Class with Bridge-Style Configuration
**What:** A class exported as a singleton, with a `configure()` method for injecting derivation functions
**When to use:** When the service needs external capabilities but cannot import them directly (ARCH-02)
**Example:**
```typescript
// Source: Existing pattern in src/backend/domains/workspace/state/kanban-state.ts
class KanbanStateService {
  private sessionBridge: WorkspaceSessionBridge | null = null;

  configure(bridges: { session: WorkspaceSessionBridge }): void {
    this.sessionBridge = bridges.session;
  }

  private get session(): WorkspaceSessionBridge {
    if (!this.sessionBridge) {
      throw new Error('KanbanStateService not configured');
    }
    return this.sessionBridge;
  }
}
export const kanbanStateService = new KanbanStateService();
```

### Pattern 2: Field-Level Timestamps for Concurrent Update Safety
**What:** Each updatable field in a snapshot entry has an `updatedAt` timestamp. On `upsert()`, only fields with a newer timestamp overwrite existing values.
**When to use:** When event-driven updates and reconciliation polls may race (Phase 14 will write from poll results)
**Example:**
```typescript
interface FieldWithTimestamp<T> {
  value: T;
  updatedAt: number; // Date.now() for fast comparison
}

// On upsert, for each field:
if (incoming.field.updatedAt > existing.field.updatedAt) {
  existing.field = incoming.field;
}
```

### Pattern 3: Monotonically Increasing Version Counter
**What:** Each snapshot entry has a `version` number that increments on every mutation. Consumers use this for staleness detection.
**When to use:** Always -- every `upsert()` and `remove()` bumps the entry version
**Example:**
```typescript
interface WorkspaceSnapshotEntry {
  workspaceId: string;
  projectId: string;
  version: number;         // Monotonically increasing
  computedAt: string;      // ISO timestamp of last computation
  source: string;          // e.g., 'event:workspace_state_change', 'reconciliation', 'initial_load'
  // ... data fields
}
```

### Pattern 4: Derived State Recomputation on Mutation
**What:** After raw fields are merged, derived fields (sidebarStatus, kanbanColumn, flowPhase, ciObservation) are recomputed from the current raw field values
**When to use:** On every `upsert()` that changes any field that feeds into derivation
**Example:**
```typescript
// After merging raw fields into entry:
entry.derived = {
  sidebarStatus: this.deriveFns.sidebarStatus(entry.raw),
  kanbanColumn: this.deriveFns.kanbanColumn(entry.raw),
  flowPhase: this.deriveFns.flowState(entry.raw).phase,
  ciObservation: this.deriveFns.flowState(entry.raw).ciObservation,
};
```

### Pattern 5: Project-Scoped Index
**What:** Maintain a secondary `Map<projectId, Set<workspaceId>>` for O(1) project-level lookups
**When to use:** `getByProjectId()` is the primary read path (sidebar, kanban, workspace list all query by project)
**Example:**
```typescript
private entries = new Map<string, WorkspaceSnapshotEntry>();
private projectIndex = new Map<string, Set<string>>(); // projectId -> workspaceIds

getByProjectId(projectId: string): WorkspaceSnapshotEntry[] {
  const ids = this.projectIndex.get(projectId);
  if (!ids) return [];
  return [...ids].map(id => this.entries.get(id)).filter(Boolean);
}
```

### Anti-Patterns to Avoid
- **Importing domain modules directly:** The snapshot service MUST NOT import from `@/backend/domains/`. The existing `schedulerService` violates this (imports from `@/backend/domains/github`), but the snapshot service has an explicit ARCH-02 constraint. Use `configure()` injection instead.
- **Storing Prisma model objects in the snapshot:** The snapshot should hold plain data (strings, numbers, enums-as-strings). Do not store Prisma `Workspace` objects -- they carry ORM metadata and create coupling.
- **Global version counter across all entries:** Each workspace entry has its own version counter. A global counter would cause false cache invalidation.
- **Recomputing derived state on read:** Derived state must be recomputed on write (when underlying fields change), not on read. Reads should be O(1) map lookups.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Event emission | Custom pub/sub | Node.js EventEmitter | Already the codebase standard; WorkspaceActivityService uses it |
| Logging | Custom logger | `createLogger('workspace-snapshot-store')` | Codebase convention, structured logging |
| Derivation logic | New computation functions | Existing `deriveWorkspaceFlowState`, `computeKanbanColumn`, `deriveWorkspaceSidebarStatus` | These are already tested and correct (see `flow-state.test.ts`, `kanban-state.test.ts`, `workspace-sidebar-status.test.ts`) |
| Project scoping | Custom collection | Simple `Map<string, Set<string>>` secondary index | The workspace count per project is small (10s, not 1000s); a simple index is sufficient |

**Key insight:** The snapshot store is fundamentally a `Map` with versioning, field-level timestamps, and derived state recomputation. No external libraries are needed. The complexity is in the contract design (what goes in, what comes out, how updates merge), not in the data structure.

## Common Pitfalls

### Pitfall 1: Importing Derivation Functions Directly
**What goes wrong:** The snapshot service imports `deriveWorkspaceFlowState` from `@/backend/domains/workspace`, violating ARCH-02 and creating a coupling dependency.
**Why it happens:** The derivation functions live in domain modules, and it's tempting to import them directly.
**How to avoid:** Two valid approaches:
1. **Preferred: Relocate pure functions to `src/shared/`**. The `deriveWorkspaceSidebarStatus` function already lives in `src/shared/workspace-sidebar-status.ts`. The `deriveWorkspaceFlowState` and `computeKanbanColumn` are pure functions that only depend on Prisma enums. They can be moved to `src/shared/` and re-exported from domain barrels for backward compatibility. This is the simplest approach.
2. **Alternative: Inject via configure()** using a `DerivationFunctions` interface, wired in `domain-bridges.orchestrator.ts`. More indirection but zero relocation needed.
**Warning signs:** Any `import ... from '@/backend/domains/'` in the new service file.

### Pitfall 2: Forgetting Cleanup on Archive/Delete
**What goes wrong:** Workspace snapshot entries leak memory when workspaces are archived or deleted.
**Why it happens:** The store has no automatic lifecycle -- cleanup must be triggered externally.
**How to avoid:** Export a `remove(workspaceId)` method. The orchestration layer (`workspace-archive.orchestrator.ts`) already coordinates archive cleanup -- add snapshot removal there. The `archiveWorkspace()` function is the right integration point (Phase 13 will wire this, but the store method must exist in Phase 11).
**Warning signs:** After archiving workspaces, `entries.size` keeps growing. Add a test that verifies `remove()` deletes both the entry and the project index reference.

### Pitfall 3: Race Between Event-Driven and Reconciliation Updates
**What goes wrong:** A reconciliation poll reads DB state at time T1, then writes to snapshot at T3. Meanwhile, an event-driven update wrote fresher state at T2. The reconciliation overwrites the fresher state.
**Why it happens:** Without field-level timestamps, the last writer wins regardless of data freshness.
**How to avoid:** Field-level timestamps on every updatable field. The `upsert()` method compares timestamps per-field and only overwrites if the incoming value is newer. This is STORE-06 requirement ("concurrent updates preserve newest data via field-level timestamps").
**Warning signs:** State flickering in the UI after reconciliation runs.

### Pitfall 4: Snapshot Entry Shape Diverging from Query Service Output
**What goes wrong:** The snapshot entry has different field names or types than `getProjectSummaryState()` output, requiring translation layers everywhere.
**Why it happens:** Designing the snapshot shape in isolation without referencing the existing query output.
**How to avoid:** Model the snapshot entry shape to match the `getProjectSummaryState()` output as closely as possible. The existing output includes: `id`, `name`, `createdAt`, `branchName`, `prUrl`, `prNumber`, `prState`, `prCiStatus`, `isWorking`, `gitStats`, `lastActivityAt`, `ratchetEnabled`, `ratchetState`, `sidebarStatus`, `ratchetButtonAnimated`, `flowPhase`, `ciObservation`, `runScriptStatus`, `cachedKanbanColumn`, `stateComputedAt`, `pendingRequestType`. The snapshot should include all of these.
**Warning signs:** Consumers needing to transform snapshot data before use.

### Pitfall 5: Emitting Change Events Before Derived State Is Recomputed
**What goes wrong:** A change event is emitted after raw fields are updated but before derived fields are recomputed. Downstream consumers (Phase 15 WebSocket) see stale derived state.
**Why it happens:** Event emission placed between raw field merge and derivation step.
**How to avoid:** Always recompute derived state before emitting the change event. The sequence must be: merge raw fields -> recompute derived fields -> bump version -> emit event.
**Warning signs:** WebSocket consumers receiving entries where `kanbanColumn` doesn't match the raw fields.

## Code Examples

### Snapshot Entry Type Definition
```typescript
// Source: Based on existing getProjectSummaryState() output shape
// in src/backend/domains/workspace/query/workspace-query.service.ts lines 187-215

import type { CIStatus, KanbanColumn, PRState, RatchetState, RunScriptStatus, WorkspaceStatus } from '@prisma-gen/client';
import type { WorkspaceCiObservation, WorkspaceFlowPhase } from '@/shared/workspace-flow-state'; // after relocation
import type { WorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';

export interface WorkspaceSnapshotEntry {
  // Identity
  workspaceId: string;
  projectId: string;

  // Versioning & debug metadata (STORE-02, STORE-03)
  version: number;
  computedAt: string;   // ISO timestamp
  source: string;       // e.g., 'event:pr_state_change', 'reconciliation'

  // Raw workspace state (updatable fields with timestamps)
  name: string;
  status: WorkspaceStatus;
  createdAt: string;
  branchName: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prState: PRState;
  prCiStatus: CIStatus;
  prUpdatedAt: string | null;
  ratchetEnabled: boolean;
  ratchetState: RatchetState;
  runScriptStatus: RunScriptStatus;
  hasHadSessions: boolean;

  // In-memory-only state (from session domain, not DB)
  isWorking: boolean;
  pendingRequestType: 'plan_approval' | 'user_question' | null;

  // Computed during reconciliation only (expensive, not event-driven)
  gitStats: { total: number; additions: number; deletions: number; hasUncommitted: boolean } | null;
  lastActivityAt: string | null;

  // Derived state (STORE-05, STORE-06) -- recomputed on raw field changes
  sidebarStatus: WorkspaceSidebarStatus;
  kanbanColumn: KanbanColumn | null;
  flowPhase: WorkspaceFlowPhase;
  ciObservation: WorkspaceCiObservation;
  ratchetButtonAnimated: boolean;

  // Field-level timestamps for concurrent update safety (STORE-06 success criteria 5)
  fieldTimestamps: Record<string, number>;
}
```

### Store Class Skeleton
```typescript
// Source: Following codebase patterns from scheduler.service.ts, kanban-state.ts

import { EventEmitter } from 'node:events';
import { createLogger } from './logger.service';

const logger = createLogger('workspace-snapshot-store');

export interface SnapshotDerivationFns {
  // Injected at startup to avoid domain imports (ARCH-02)
  deriveFlowState: (input: FlowStateInput) => FlowStateOutput;
  computeKanbanColumn: (input: KanbanInput) => KanbanColumn | null;
  deriveSidebarStatus: (input: SidebarInput) => SidebarStatusOutput;
}

class WorkspaceSnapshotStore extends EventEmitter {
  private entries = new Map<string, WorkspaceSnapshotEntry>();
  private projectIndex = new Map<string, Set<string>>();
  private deriveFns: SnapshotDerivationFns | null = null;

  configure(fns: SnapshotDerivationFns): void {
    this.deriveFns = fns;
  }

  upsert(workspaceId: string, update: Partial<SnapshotUpdateInput>, source: string): void {
    // 1. Get or create entry
    // 2. Merge fields using field-level timestamp comparison
    // 3. Recompute derived state
    // 4. Bump version
    // 5. Update project index
    // 6. Emit 'snapshot_changed' event with { workspaceId, projectId, entry }
  }

  remove(workspaceId: string): void {
    // 1. Delete from entries map
    // 2. Remove from project index
    // 3. Emit 'snapshot_removed' event with { workspaceId, projectId }
  }

  getByWorkspaceId(workspaceId: string): WorkspaceSnapshotEntry | undefined {
    return this.entries.get(workspaceId);
  }

  getByProjectId(projectId: string): WorkspaceSnapshotEntry[] {
    const ids = this.projectIndex.get(projectId);
    if (!ids) return [];
    const results: WorkspaceSnapshotEntry[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry) results.push(entry);
    }
    return results;
  }

  getVersion(workspaceId: string): number | undefined {
    return this.entries.get(workspaceId)?.version;
  }

  /** For testing and debugging */
  size(): number {
    return this.entries.size;
  }
}

export const workspaceSnapshotStore = new WorkspaceSnapshotStore();
```

### Wiring Derivation Functions at Startup
```typescript
// In src/backend/orchestration/domain-bridges.orchestrator.ts (or a new file)
// This wires the pure functions into the snapshot store without the store importing domains

import { deriveWorkspaceFlowState, computeKanbanColumn } from '@/backend/domains/workspace';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';
import { workspaceSnapshotStore } from '@/backend/services';

workspaceSnapshotStore.configure({
  deriveFlowState: deriveWorkspaceFlowState,
  computeKanbanColumn: computeKanbanColumn,
  deriveSidebarStatus: deriveWorkspaceSidebarStatus,
});
```

### Test Pattern
```typescript
// Source: Following existing test patterns from activity.service.test.ts, scheduler.service.test.ts

import { beforeEach, describe, expect, it } from 'vitest';

// Mock logger
vi.mock('./logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

import { WorkspaceSnapshotStore } from './workspace-snapshot-store.service';

describe('WorkspaceSnapshotStore', () => {
  let store: WorkspaceSnapshotStore;

  beforeEach(() => {
    store = new WorkspaceSnapshotStore(); // Fresh instance per test
    store.configure({
      deriveFlowState: (input) => ({ phase: 'NO_PR', ciObservation: 'NOT_FETCHED', ... }),
      computeKanbanColumn: (input) => 'WORKING',
      deriveSidebarStatus: (input) => ({ activityState: 'IDLE', ciState: 'NONE' }),
    });
  });

  it('creates entry on first upsert', () => { ... });
  it('increments version on each upsert', () => { ... });
  it('removes entry and project index on remove', () => { ... });
  it('returns entries by projectId', () => { ... });
  it('preserves newer field values on concurrent update', () => { ... });
  it('recomputes derived state when raw fields change', () => { ... });
  it('emits snapshot_changed event on upsert', () => { ... });
  it('emits snapshot_removed event on remove', () => { ... });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Recompute on every query (`getProjectSummaryState`) | Pre-computed snapshot with event updates | Phase 11 (this phase) | Reads become O(1) map lookup instead of DB query + computation |
| Multiple independent polling loops (sidebar 2s, kanban 15s) | Single materialized view with WebSocket push | Phase 11-17 | Consistent state across all UI surfaces |
| `cachedKanbanColumn` in DB | In-memory derived kanbanColumn in snapshot | Phase 11 | Faster updates, no DB write for column changes |

**Existing patterns preserved:**
- `deriveWorkspaceFlowState()` -- pure function, already tested, reused as-is
- `computeKanbanColumn()` -- pure function, already tested, reused as-is
- `deriveWorkspaceSidebarStatus()` -- pure function in `src/shared/`, already tested, reused as-is
- `configure()` bridge pattern -- used by 5+ services already (kanbanStateService, workspaceQueryService, ratchetService, etc.)
- Singleton class export -- used by every service in the codebase

## Open Questions

1. **Where to locate pure derivation functions for ARCH-02 compliance?**
   - What we know: `deriveWorkspaceSidebarStatus` already lives in `src/shared/`. `deriveWorkspaceFlowState` and `computeKanbanColumn` live in `src/backend/domains/workspace/state/`. Both are pure functions that only depend on Prisma enums.
   - What's unclear: Should we relocate flow-state and kanban-column pure functions to `src/shared/` (matching sidebar-status), or inject them via `configure()`?
   - Recommendation: **Use `configure()` injection.** This avoids moving files (which is a larger change that could affect 10+ import sites) and matches the existing bridge pattern. The orchestration layer (`domain-bridges.orchestrator.ts`) already wires bridges at startup -- adding derivation function injection there is natural. The pure functions stay in their current domain locations, and the snapshot service receives them as callbacks.

2. **Should the store emit typed events or use a callback?**
   - What we know: `WorkspaceActivityService` extends `EventEmitter` and emits string-typed events like `'workspace_idle'`. Phase 15 will need to subscribe to snapshot changes.
   - What's unclear: Whether to use EventEmitter (string-based, existing pattern) or typed callbacks (stricter but different pattern).
   - Recommendation: **Use EventEmitter.** It matches the existing codebase pattern and provides the pub/sub decoupling needed for Phase 15. Define event names as constants.

3. **How granular should field-level timestamps be?**
   - What we know: STORE-06 success criteria says "concurrent updates preserve newest data via field-level timestamps."
   - What's unclear: Whether every individual field needs a timestamp, or if field groups (e.g., "pr_fields", "session_fields") are sufficient.
   - Recommendation: **Group timestamps by update source** (e.g., `prFieldsUpdatedAt`, `sessionFieldsUpdatedAt`, `workspaceFieldsUpdatedAt`, `reconciliationUpdatedAt`). Individual field timestamps add complexity without proportional benefit. Updates from a single event always update a coherent group of fields together.

4. **Initial population of the store**
   - What we know: Phase 11 creates the store. Phase 13 wires events. Phase 14 adds reconciliation.
   - What's unclear: How the store gets its initial data on server startup.
   - Recommendation: **Do not solve initial population in Phase 11.** The store starts empty. Phase 14 (Safety-Net Reconciliation) will do the initial full load. Phase 11 only needs the data structures and mutation methods. Tests should verify the store works with manual `upsert()` calls.

## Sources

### Primary (HIGH confidence)
- Codebase analysis: `src/backend/services/` -- existing service patterns (scheduler, notification, config)
- Codebase analysis: `src/backend/domains/workspace/state/` -- existing derivation functions (flow-state.ts, kanban-state.ts)
- Codebase analysis: `src/shared/workspace-sidebar-status.ts` -- shared pure derivation function
- Codebase analysis: `src/backend/domains/workspace/query/workspace-query.service.ts` -- existing `getProjectSummaryState()` output shape (the "target" shape for snapshot entries)
- Codebase analysis: `src/backend/orchestration/domain-bridges.orchestrator.ts` -- bridge wiring pattern
- Codebase analysis: `src/backend/domains/workspace/lifecycle/activity.service.ts` -- EventEmitter + in-memory state pattern
- Codebase analysis: `.dependency-cruiser.cjs` -- architectural rules (no existing rule blocking services->domains, but ARCH-02 is explicit for this service)
- Codebase analysis: `prisma/schema.prisma` -- workspace model fields and enums
- Codebase analysis: `.planning/ROADMAP.md` -- Phase 11-18 requirements and dependencies

### Secondary (MEDIUM confidence)
- Codebase analysis: `.planning/PROJECT.md` -- overall milestone goals and constraints
- Codebase analysis: `.planning/codebase/ARCHITECTURE.md` -- architectural patterns documentation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no external libraries needed, pure TypeScript + Node.js built-ins
- Architecture: HIGH -- patterns derived directly from existing codebase (configure(), EventEmitter, singleton class, co-located tests)
- Pitfalls: HIGH -- identified from direct analysis of existing code and the specific ARCH-02 constraint
- Snapshot entry shape: HIGH -- derived directly from existing `getProjectSummaryState()` output in workspace-query.service.ts
- Field-level timestamps: MEDIUM -- the grouping strategy is a design recommendation, not codebase-verified

**Research date:** 2026-02-11
**Valid until:** 2026-03-11 (stable domain -- no external dependencies to go stale)
