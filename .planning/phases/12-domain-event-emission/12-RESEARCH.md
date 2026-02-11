# Phase 12: Domain Event Emission - Research

**Researched:** 2026-02-11
**Domain:** Adding EventEmitter-based domain events to 5 backend domains
**Confidence:** HIGH

## Summary

Phase 12 adds typed EventEmitter events to five backend domains (workspace, github, ratchet, run-script, session) so that state transitions can be observed by downstream consumers without the domains knowing who listens. The critical constraint is that domains must have zero imports related to the snapshot service (success criteria #5), and events must be emitted AFTER mutations complete (not before).

The codebase already has a strong precedent: `WorkspaceActivityService` extends `EventEmitter` and emits `workspace_active` and `workspace_idle` events. This pattern should be replicated across the other four domains. Each domain service that performs state-changing mutations will extend `EventEmitter` (or have an EventEmitter composed into it) and emit events after successful state transitions.

The key design decision is whether each service class extends EventEmitter directly, or whether a standalone per-domain event bus is used. Analysis of the codebase shows that `WorkspaceActivityService` already extends EventEmitter directly, and the services that need events (`workspaceStateMachine`, `prSnapshotService`, `ratchetService`, `runScriptStateMachine`) are all singleton class instances. The cleanest approach is to make each of these classes extend EventEmitter, matching the existing `WorkspaceActivityService` pattern. The class instances are already singletons, so consumers can import and subscribe directly via the domain barrel.

Phase 13 (Event Collector) will subscribe to these events and translate them into snapshot store `upsert()` calls. Phase 12 only needs to emit events -- no consumption logic.

**Primary recommendation:** Make each state-mutating domain service extend `EventEmitter` and emit typed events after successful mutations. Export event name constants and payload types from each domain barrel. Do not add any snapshot-related imports to domains.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js EventEmitter | built-in | Event emission within each domain | Already used by WorkspaceActivityService, ClaudeClient, ChatEventForwarderService |
| TypeScript | (project) | Typed event payloads | Project standard |
| Vitest | (project) | Co-located test files | Project standard |

### Supporting
No additional libraries needed. This is pure Node.js EventEmitter work.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| EventEmitter on each service class | Shared domain event bus | More indirection, no codebase precedent; EventEmitter-per-service matches WorkspaceActivityService pattern |
| Class `extends EventEmitter` | Composed EventEmitter property | Composition adds `.events.on()` boilerplate; extends is simpler and matches existing pattern |
| String event names | Symbol event names | Symbols prevent string matching; string names with constants are the codebase pattern |

## Architecture Patterns

### Recommended Changes Per Domain

```
src/backend/domains/workspace/lifecycle/state-machine.service.ts  -- extends EventEmitter, emits on transition()
src/backend/domains/github/pr-snapshot.service.ts                 -- extends EventEmitter, emits on applySnapshot()
src/backend/domains/ratchet/ratchet.service.ts                    -- extends EventEmitter, emits on processWorkspace()
src/backend/domains/run-script/run-script-state-machine.service.ts -- extends EventEmitter, emits on transition()
src/backend/domains/workspace/lifecycle/activity.service.ts       -- ALREADY DONE (workspace_active, workspace_idle)
```

### Pattern 1: Service Extends EventEmitter with Typed Event Constants

**What:** Each domain service class extends EventEmitter. Event name constants and payload interfaces are defined in the same file and exported from the domain barrel.
**When to use:** For every domain service that performs state mutations relevant to the snapshot store.
**Example (workspace state machine):**
```typescript
// In state-machine.service.ts
import { EventEmitter } from 'node:events';

// Event constants
export const WORKSPACE_STATE_CHANGED = 'workspace_state_changed' as const;

// Event payload type
export interface WorkspaceStateChangedEvent {
  workspaceId: string;
  fromStatus: WorkspaceStatus;
  toStatus: WorkspaceStatus;
}

class WorkspaceStateMachineService extends EventEmitter {
  // ... existing code ...

  async transition(workspaceId, targetStatus, options): Promise<Workspace> {
    // ... existing validation, CAS update, re-read ...
    const updated = await workspaceAccessor.findRawByIdOrThrow(workspaceId);

    // Emit AFTER successful mutation
    this.emit(WORKSPACE_STATE_CHANGED, {
      workspaceId,
      fromStatus: currentStatus,
      toStatus: targetStatus,
    } satisfies WorkspaceStateChangedEvent);

    return updated;
  }
}
```

### Pattern 2: Emit After Mutation Completes (Not Before)

**What:** Events are emitted only after the DB write (or in-memory mutation) has succeeded. If the CAS fails or the mutation throws, no event is emitted.
**When to use:** Always -- this is success criteria #5.
**Example (run-script state machine):**
```typescript
async transition(workspaceId, targetStatus, options): Promise<Workspace> {
  // ... validation ...
  const result = await workspaceAccessor.casRunScriptStatusUpdate(...);

  if (result.count === 0) {
    throw new RunScriptStateMachineError(...); // No event emitted
  }

  const updated = await workspaceAccessor.findRawByIdOrThrow(workspaceId);

  // Only emit after successful CAS
  this.emit(RUN_SCRIPT_STATUS_CHANGED, {
    workspaceId,
    fromStatus: currentStatus,
    toStatus: targetStatus,
  } satisfies RunScriptStatusChangedEvent);

  return updated;
}
```

### Pattern 3: PR Snapshot Emits Change Events with State Data

**What:** The PR snapshot service emits events containing the new PR state and CI status after a successful refresh. The event includes both the workspace ID and the new snapshot values so the collector does not need to query the DB.
**When to use:** In `prSnapshotService.applySnapshot()` after successful DB write.
**Example:**
```typescript
export const PR_SNAPSHOT_UPDATED = 'pr_snapshot_updated' as const;

export interface PRSnapshotUpdatedEvent {
  workspaceId: string;
  prNumber: number;
  prState: string;       // PRState enum value as string
  prCiStatus: string;    // CIStatus enum value as string
  prReviewState: string | null;
}

// In applySnapshot():
await workspaceAccessor.update(workspaceId, updateData);
await this.kanban.updateCachedKanbanColumn(workspaceId);

this.emit(PR_SNAPSHOT_UPDATED, {
  workspaceId,
  prNumber: snapshot.prNumber,
  prState: snapshot.prState,
  prCiStatus: snapshot.prCiStatus,
  prReviewState: snapshot.prReviewState,
} satisfies PRSnapshotUpdatedEvent);
```

### Pattern 4: Ratchet Service Emits After State Persistence

**What:** The ratchet service emits events when the workspace ratchet state changes. The event includes the workspace ID and both old/new ratchet states. The emit happens after `updateWorkspaceAfterCheck()` persists the new state.
**When to use:** At the end of `processWorkspace()` when a state change occurred.
**Example:**
```typescript
export const RATCHET_STATE_CHANGED = 'ratchet_state_changed' as const;

export interface RatchetStateChangedEvent {
  workspaceId: string;
  fromState: RatchetState;
  toState: RatchetState;
}

// In processWorkspace(), after updateWorkspaceAfterCheck():
if (decisionContext.previousState !== decisionContext.finalState) {
  this.emit(RATCHET_STATE_CHANGED, {
    workspaceId: workspace.id,
    fromState: decisionContext.previousState,
    toState: decisionContext.finalState,
  } satisfies RatchetStateChangedEvent);
}
```

### Pattern 5: Export Events from Domain Barrels

**What:** Event constants and payload types are exported from each domain's `index.ts` barrel file so that the orchestration layer (Phase 13 Event Collector) can import and subscribe.
**When to use:** For every new event constant and type.
**Example (workspace/index.ts additions):**
```typescript
export {
  WORKSPACE_STATE_CHANGED,
  type WorkspaceStateChangedEvent,
  // ... existing exports ...
  workspaceStateMachine,
} from './lifecycle/state-machine.service';
```

### Anti-Patterns to Avoid
- **Emitting before mutation:** Events must fire AFTER the DB write succeeds. Emitting before risks consumers seeing state that was never persisted.
- **Importing snapshot service in domains:** Domains must have zero knowledge of the snapshot store. Event consumers are wired in the orchestration layer (Phase 13).
- **Emitting on failed transitions:** If a CAS operation fails or a transition is invalid, no event should be emitted. The event represents a confirmed state change.
- **Including heavy payloads:** Event payloads should be lightweight -- IDs, enum values, and essential state. Do not include full Prisma model objects.
- **Skipping events on code paths that bypass transition():** The `startProvisioning()` and `resetToNew()` methods in workspace state machine use separate CAS operations that bypass `transition()`. These MUST also emit events.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Event emission | Custom pub/sub or callback registries | Node.js EventEmitter | Already the codebase standard (WorkspaceActivityService, ClaudeClient); well-tested, zero dependencies |
| Typed event validation | Runtime schema validation on events | TypeScript `satisfies` + interface types | Events are internal (same process), runtime validation adds overhead without benefit |
| Event deduplication | Custom dedup logic in emitters | Nothing -- leave dedup to Phase 13 (Event Collector coalescing) | Phase 12 emits raw events; Phase 13 coalesces them |

**Key insight:** Phase 12 is purely about adding `.emit()` calls to existing services. No new infrastructure, libraries, or event bus is needed. The EventEmitter pattern is already proven in this codebase.

## Common Pitfalls

### Pitfall 1: Forgetting Non-Standard Code Paths in Workspace State Machine
**What goes wrong:** `startProvisioning()` and `resetToNew()` bypass `transition()` and use separate CAS operations. If events are only added to `transition()`, these paths silently skip event emission.
**Why it happens:** The state machine has two patterns: standard `transition()` and specialized atomic methods that combine validation + CAS + retry-count logic.
**How to avoid:** Add explicit `this.emit(WORKSPACE_STATE_CHANGED, ...)` calls in `startProvisioning()` (after successful CAS for FAILED->PROVISIONING) and `resetToNew()` (after successful CAS for FAILED->NEW). The `startProvisioning()` NEW->PROVISIONING path delegates to `transition()` and is already covered.
**Warning signs:** Workspace snapshots not updating when a workspace retries provisioning from FAILED state.

### Pitfall 2: Breaking Existing Event Consumers When Extending EventEmitter
**What goes wrong:** Making `WorkspaceStateMachineService` extend `EventEmitter` adds a constructor requirement (`super()`). If the existing singleton is constructed without calling `super()`, it will throw.
**Why it happens:** Currently the class has no parent class and no explicit constructor. Adding `extends EventEmitter` requires a `super()` call.
**How to avoid:** Add `constructor() { super(); }` to each modified class. Since these classes already have no constructor, adding one is straightforward. Alternatively, since the default class constructor automatically calls `super()` in ES2022+, simply adding `extends EventEmitter` may be sufficient, but explicit is better.
**Warning signs:** Runtime error `Must call super constructor in derived class before accessing 'this'` on service initialization.

### Pitfall 3: Emitting in Error/Catch Paths
**What goes wrong:** Events are emitted inside catch blocks or after error recovery, emitting events for states that were rolled back or never actually committed.
**Why it happens:** Copy-paste of the emit call into error-handling code.
**How to avoid:** Only emit in the success path, after the DB mutation is confirmed (CAS returned count > 0) and the re-read succeeded.
**Warning signs:** Snapshot store receiving phantom state changes that don't match DB state.

### Pitfall 4: Ratchet Service Has Multiple State Write Points
**What goes wrong:** The ratchet service writes state changes in several places: `processWorkspace()` -> `updateWorkspaceAfterCheck()` for normal flow, but also directly in the disabled-workspace early return (line 265). Missing the early return means no event is emitted when ratchet is disabled.
**Why it happens:** The ratchet service has complex control flow with early returns.
**How to avoid:** Emit after `updateWorkspaceAfterCheck()` in the main path AND after the disabled-workspace early return in `processWorkspace()`. Both write `ratchetState` to DB.
**Warning signs:** Ratchet state changes not reflected in snapshot when workspace has `ratchetEnabled: false`.

### Pitfall 5: PR Snapshot Events Emitted Even When Nothing Changed
**What goes wrong:** `applySnapshot()` always writes to DB (even if values are unchanged), so the event fires on every refresh even when PR state is the same.
**Why it happens:** The PR snapshot service unconditionally writes to DB on every refresh.
**How to avoid:** Two options: (1) Compare old vs new state before emitting (preferred), or (2) Always emit and let the Phase 13 coalescer handle dedup. Option 2 is simpler and Phase 13 already must handle rapid-fire events (EVNT-08 requirement). **Recommendation: always emit.** The cost is negligible (in-process EventEmitter) and avoids missing edge cases where subtle field differences matter.
**Warning signs:** N/A if always-emit approach is taken.

### Pitfall 6: Session Domain EVNT-05 -- Already Done
**What goes wrong:** Unnecessary work implementing session activity events that already exist.
**Why it happens:** Not reading the existing code carefully.
**How to avoid:** EVNT-05 says "Session domain activity events (workspace_active, workspace_idle) flow through WorkspaceActivityService to any subscriber." The `WorkspaceActivityService` already extends `EventEmitter` and already emits `workspace_active` and `workspace_idle`. This requirement is already satisfied. Phase 12 only needs to verify it works and ensure the events are properly exported from the workspace barrel (they already are -- `workspaceActivityService` is exported from `workspace/index.ts`).
**Warning signs:** Creating duplicate event emission for session activity.

## Code Examples

### EVNT-01: Workspace State Machine Events

```typescript
// Source: state-machine.service.ts -- modifications needed

import { EventEmitter } from 'node:events';
import type { WorkspaceStatus } from '@prisma-gen/client';

export const WORKSPACE_STATE_CHANGED = 'workspace_state_changed' as const;

export interface WorkspaceStateChangedEvent {
  workspaceId: string;
  fromStatus: WorkspaceStatus;
  toStatus: WorkspaceStatus;
}

class WorkspaceStateMachineService extends EventEmitter {
  constructor() {
    super();
  }

  async transition(workspaceId, targetStatus, options): Promise<Workspace> {
    // ... existing validation, CAS, re-read (lines 81-152) ...
    const updated = await workspaceAccessor.findRawByIdOrThrow(workspaceId);

    this.emit(WORKSPACE_STATE_CHANGED, {
      workspaceId,
      fromStatus: currentStatus,
      toStatus: targetStatus,
    } satisfies WorkspaceStateChangedEvent);

    logger.debug('Workspace status transitioned', { ... });
    return updated;
  }

  async startProvisioning(workspaceId, options): Promise<Workspace | null> {
    // NEW -> PROVISIONING path delegates to this.transition() -- already covered
    // FAILED -> PROVISIONING path uses separate CAS -- needs explicit emit:
    if (currentStatus === 'FAILED') {
      const result = await workspaceAccessor.startProvisioningRetryIfAllowed(...);
      if (result.count === 0) return null;
      const updated = await workspaceAccessor.findRawById(workspaceId);

      this.emit(WORKSPACE_STATE_CHANGED, {
        workspaceId,
        fromStatus: 'FAILED' as WorkspaceStatus,
        toStatus: 'PROVISIONING' as WorkspaceStatus,
      } satisfies WorkspaceStateChangedEvent);

      return updated;
    }
  }

  async resetToNew(workspaceId, maxRetries): Promise<Workspace | null> {
    // Uses separate CAS -- needs explicit emit:
    const result = await workspaceAccessor.resetToNewIfAllowed(...);
    if (result.count === 0) return null;
    const updated = await workspaceAccessor.findRawById(workspaceId);

    this.emit(WORKSPACE_STATE_CHANGED, {
      workspaceId,
      fromStatus: 'FAILED' as WorkspaceStatus,
      toStatus: 'NEW' as WorkspaceStatus,
    } satisfies WorkspaceStateChangedEvent);

    return updated;
  }
}
```

### EVNT-02: PR Snapshot Events

```typescript
// Source: pr-snapshot.service.ts -- modifications needed

import { EventEmitter } from 'node:events';

export const PR_SNAPSHOT_UPDATED = 'pr_snapshot_updated' as const;

export interface PRSnapshotUpdatedEvent {
  workspaceId: string;
  prNumber: number;
  prState: string;
  prCiStatus: string;
  prReviewState: string | null;
}

class PRSnapshotService extends EventEmitter {
  constructor() {
    super();
    // ... existing kanbanBridge initialization
  }

  async applySnapshot(workspaceId, snapshot, prUrl?): Promise<void> {
    // ... existing DB update (lines 160-176) ...
    await workspaceAccessor.update(workspaceId, updateData);
    await this.kanban.updateCachedKanbanColumn(workspaceId);

    // Emit after successful mutation
    this.emit(PR_SNAPSHOT_UPDATED, {
      workspaceId,
      prNumber: snapshot.prNumber,
      prState: snapshot.prState,
      prCiStatus: snapshot.prCiStatus,
      prReviewState: snapshot.prReviewState,
    } satisfies PRSnapshotUpdatedEvent);
  }
}
```

### EVNT-03: Ratchet State Events

```typescript
// Source: ratchet.service.ts -- modifications needed

import { EventEmitter } from 'node:events';

export const RATCHET_STATE_CHANGED = 'ratchet_state_changed' as const;

export interface RatchetStateChangedEvent {
  workspaceId: string;
  fromState: RatchetState;
  toState: RatchetState;
}

class RatchetService extends EventEmitter {
  constructor() {
    super();
    // ... existing field initialization
  }

  private async processWorkspace(workspace): Promise<WorkspaceRatchetResult> {
    // Disabled early return path:
    if (!workspace.ratchetEnabled) {
      const newState = RatchetState.IDLE;
      await workspaceAccessor.update(workspace.id, { ... });

      if (workspace.ratchetState !== newState) {
        this.emit(RATCHET_STATE_CHANGED, {
          workspaceId: workspace.id,
          fromState: workspace.ratchetState,
          toState: newState,
        } satisfies RatchetStateChangedEvent);
      }
      return { ... };
    }

    // Main path: after updateWorkspaceAfterCheck()
    await this.updateWorkspaceAfterCheck(workspace, prStateInfo, action, decisionContext.finalState);

    if (decisionContext.previousState !== decisionContext.finalState) {
      this.emit(RATCHET_STATE_CHANGED, {
        workspaceId: workspace.id,
        fromState: decisionContext.previousState,
        toState: decisionContext.finalState,
      } satisfies RatchetStateChangedEvent);
    }

    return { ... };
  }
}
```

### EVNT-04: Run-Script State Events

```typescript
// Source: run-script-state-machine.service.ts -- modifications needed

import { EventEmitter } from 'node:events';

export const RUN_SCRIPT_STATUS_CHANGED = 'run_script_status_changed' as const;

export interface RunScriptStatusChangedEvent {
  workspaceId: string;
  fromStatus: RunScriptStatus;
  toStatus: RunScriptStatus;
}

class RunScriptStateMachineService extends EventEmitter {
  constructor() {
    super();
  }

  async transition(workspaceId, targetStatus, options): Promise<Workspace> {
    // ... existing validation, CAS (lines 79-153) ...
    const updated = await workspaceAccessor.findRawByIdOrThrow(workspaceId);

    this.emit(RUN_SCRIPT_STATUS_CHANGED, {
      workspaceId,
      fromStatus: currentStatus,
      toStatus: targetStatus,
    } satisfies RunScriptStatusChangedEvent);

    logger.debug('Run script status transitioned', { ... });
    return updated;
  }
}
```

### EVNT-05: Session Activity Events (Already Implemented)

```typescript
// Source: activity.service.ts -- ALREADY DONE, no changes needed

// WorkspaceActivityService already extends EventEmitter and emits:
// - 'workspace_active' with { workspaceId }
// - 'workspace_idle' with { workspaceId, finishedAt }
// - 'request_notification' with { workspaceId, workspaceName, sessionCount, finishedAt }

// Already exported from workspace/index.ts:
// export { workspaceActivityService } from './lifecycle/activity.service';

// Phase 13 Event Collector will subscribe to these events on the
// workspaceActivityService singleton, which is accessible via the workspace barrel.
```

### Test Pattern: Verify Events After Successful Transitions

```typescript
// Source: Following existing test patterns from state-machine.service.test.ts

import { EventEmitter } from 'node:events';

describe('WorkspaceStateMachineService events', () => {
  it('emits workspace_state_changed after successful transition', async () => {
    const workspace = { id: 'ws-1', status: 'PROVISIONING' };
    mockFindUnique.mockResolvedValue(workspace);
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockFindUniqueOrThrow.mockResolvedValue({ ...workspace, status: 'READY' });

    const events: WorkspaceStateChangedEvent[] = [];
    workspaceStateMachine.on(WORKSPACE_STATE_CHANGED, (e) => events.push(e));

    await workspaceStateMachine.transition('ws-1', 'READY');

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      workspaceId: 'ws-1',
      fromStatus: 'PROVISIONING',
      toStatus: 'READY',
    });

    workspaceStateMachine.removeAllListeners(WORKSPACE_STATE_CHANGED);
  });

  it('does NOT emit event on CAS failure', async () => {
    mockFindUnique.mockResolvedValue({ id: 'ws-1', status: 'PROVISIONING' });
    mockUpdateMany.mockResolvedValue({ count: 0 }); // CAS failed

    const events: WorkspaceStateChangedEvent[] = [];
    workspaceStateMachine.on(WORKSPACE_STATE_CHANGED, (e) => events.push(e));

    await expect(workspaceStateMachine.transition('ws-1', 'READY')).rejects.toThrow();
    expect(events).toHaveLength(0);

    workspaceStateMachine.removeAllListeners(WORKSPACE_STATE_CHANGED);
  });

  it('does NOT emit event on invalid transition', async () => {
    mockFindUnique.mockResolvedValue({ id: 'ws-1', status: 'NEW' });

    const events: WorkspaceStateChangedEvent[] = [];
    workspaceStateMachine.on(WORKSPACE_STATE_CHANGED, (e) => events.push(e));

    await expect(workspaceStateMachine.transition('ws-1', 'READY')).rejects.toThrow();
    expect(events).toHaveLength(0);

    workspaceStateMachine.removeAllListeners(WORKSPACE_STATE_CHANGED);
  });
});
```

## Event-to-Snapshot-Field Mapping

This table shows how each domain event maps to the snapshot store's `SnapshotFieldGroup` and `SnapshotUpdateInput` fields. Phase 13 (Event Collector) will use this mapping.

| Domain Event | Snapshot Field Group | Fields Updated |
|--------------|---------------------|----------------|
| `workspace_state_changed` | `workspace` | `status` |
| `pr_snapshot_updated` | `pr` | `prNumber`, `prState`, `prCiStatus`, `prUpdatedAt` |
| `ratchet_state_changed` | `ratchet` | `ratchetState` |
| `run_script_status_changed` | `runScript` | `runScriptStatus` |
| `workspace_active` | `session` | `isWorking: true` |
| `workspace_idle` | `session` | `isWorking: false` |

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No events; consumers poll DB | EventEmitter on domain services | Phase 12 (this phase) | Enables event-driven snapshot updates (Phase 13) |
| Session activity is the only EventEmitter service | All state-changing domains emit events | Phase 12 | Consistent observability across all domains |

**Existing event patterns preserved:**
- `WorkspaceActivityService` -- already extends EventEmitter, already emits `workspace_active`/`workspace_idle`. No changes needed.
- `ClaudeClient` -- extends EventEmitter for session-level events. Different use case (session internals), not affected by this phase.

## Open Questions

1. **Should `prSnapshotService.applySnapshot()` compare old vs new state before emitting?**
   - What we know: `applySnapshot()` always writes to DB regardless of whether values changed. Emitting every time means duplicate events when PR state hasn't actually changed.
   - What's unclear: Whether this causes performance issues in Phase 13 coalescing.
   - Recommendation: **Always emit.** Phase 13 must handle rapid-fire events anyway (EVNT-08). The EventEmitter overhead is negligible (same-process function calls). Avoids edge cases where subtle field differences are missed by comparison logic.

2. **Should ratchet events include the `ratchetEnabled` flag?**
   - What we know: When `ratchetEnabled` changes, the ratchet state may also change (e.g., to IDLE when disabled). The `ratchetEnabled` field is in the `ratchet` field group in the snapshot store.
   - What's unclear: Whether the ratchet service is the right place to emit `ratchetEnabled` changes, since `ratchetEnabled` is set by user action via workspace update, not by the ratchet service itself.
   - Recommendation: **Do not include `ratchetEnabled` in ratchet events.** The `ratchetEnabled` toggle is a workspace-level field change. It will be handled by the safety-net reconciliation poll (Phase 14) or by adding a separate workspace field update event later. The ratchet service only emits when `ratchetState` changes.

3. **Should workspace state machine events include the full workspace object?**
   - What we know: The event collector (Phase 13) will need the workspace ID to call `snapshotStore.upsert()`. It only needs the new status value for the `workspace` field group.
   - What's unclear: Whether additional fields (like `branchName` set during READY transition) should be included.
   - Recommendation: **Keep payloads minimal.** Include only `workspaceId`, `fromStatus`, `toStatus`. If the collector needs additional fields, it can query the DB. This keeps events decoupled and lightweight. Phase 14 reconciliation will catch any missing fields.

## Sources

### Primary (HIGH confidence)
- Codebase analysis: `src/backend/domains/workspace/lifecycle/activity.service.ts` -- EventEmitter pattern precedent, lines 1-120
- Codebase analysis: `src/backend/domains/workspace/lifecycle/state-machine.service.ts` -- workspace state transitions, lines 67-287
- Codebase analysis: `src/backend/domains/github/pr-snapshot.service.ts` -- PR snapshot mutations, lines 31-180
- Codebase analysis: `src/backend/domains/ratchet/ratchet.service.ts` -- ratchet state transitions, lines 92-1071
- Codebase analysis: `src/backend/domains/run-script/run-script-state-machine.service.ts` -- run-script state transitions, lines 66-281
- Codebase analysis: `src/backend/services/workspace-snapshot-store.service.ts` -- snapshot field groups and update input types, lines 37-166
- Codebase analysis: `src/backend/orchestration/domain-bridges.orchestrator.ts` -- bridge wiring pattern, lines 1-154
- Codebase analysis: `.dependency-cruiser.cjs` -- no-cross-domain-imports rule enforcement
- Codebase analysis: `src/backend/domains/*/index.ts` -- barrel file export patterns for all 6 domains
- Codebase analysis: `.planning/ROADMAP.md` -- Phase 12-13 requirements and dependencies

### Secondary (MEDIUM confidence)
- Codebase analysis: `src/backend/domains/workspace/lifecycle/state-machine.service.test.ts` -- test patterns for mocking and assertions
- Codebase analysis: `src/backend/domains/workspace/lifecycle/activity.service.test.ts` -- EventEmitter test pattern
- Node.js documentation: EventEmitter is stable API, no version concerns

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new libraries, just Node.js EventEmitter already used in codebase
- Architecture: HIGH -- directly extends existing WorkspaceActivityService pattern; all modification points identified from codebase analysis
- Pitfalls: HIGH -- identified by tracing all code paths in each service (startProvisioning bypass, ratchet disabled early return, etc.)
- Event payloads: HIGH -- derived from snapshot store field groups and existing service method signatures
- EVNT-05 status: HIGH -- verified by reading activity.service.ts that events already exist

**Research date:** 2026-02-11
**Valid until:** 2026-03-11 (stable domain -- no external dependencies to go stale)
