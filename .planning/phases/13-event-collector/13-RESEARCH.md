# Phase 13: Event Collector - Research

**Researched:** 2026-02-11
**Domain:** Event-driven orchestration wiring domain events to snapshot store mutations with coalescing
**Confidence:** HIGH

## Summary

Phase 13 creates a single orchestrator in `src/backend/orchestration/` that subscribes to all five domain event sources (workspace state machine, PR snapshot, ratchet, run-script, workspace activity) and translates each event into a `workspaceSnapshotStore.upsert()` call. The critical challenge is coalescing: rapid-fire events for the same workspace (multiple events within 100-200ms) must produce a single snapshot update, not multiple. This prevents expensive derived-state recomputation and downstream WebSocket pushes for intermediate states.

The codebase already has all the building blocks. Phase 12 added typed EventEmitter events to all five domains, each exported from domain barrels with constant names and typed payloads. Phase 11 created the `WorkspaceSnapshotStore` with its `upsert()` method that handles field-level timestamp merging and derived state recomputation. The orchestration layer (`src/backend/orchestration/`) already follows a clear pattern: `domain-bridges.orchestrator.ts` wires cross-domain bridges at startup and is called from `server.ts` after the server starts. The event collector should follow this exact pattern -- a new `event-collector.orchestrator.ts` that subscribes to domain events and calls the store.

The coalescing strategy is a per-workspace debounce using `setTimeout`/`clearTimeout`. When an event arrives for a workspace, the collector accumulates the `SnapshotUpdateInput` fields and resets a timer. When the timer fires (after 150ms of quiet), it flushes the accumulated fields in a single `upsert()`. This is the same debounce pattern already used by `StartupScriptService.createDebouncedOutputCallback()` in the codebase. The key design consideration is that the collector must translate each domain event payload into the correct `SnapshotUpdateInput` field group -- mapping `WorkspaceStateChangedEvent.toStatus` to `{status}`, `PRSnapshotUpdatedEvent` to `{prState, prCiStatus, prNumber, prReviewState}`, etc.

**Primary recommendation:** Create `event-collector.orchestrator.ts` in `src/backend/orchestration/` with a `configureEventCollector()` function that subscribes to all five domain event emitters and routes events through a per-workspace coalescing buffer before calling `workspaceSnapshotStore.upsert()`. Call it from `server.ts` after `configureDomainBridges()`.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js EventEmitter | built-in | Subscribe to domain events | All domain services already extend EventEmitter |
| Node.js setTimeout/clearTimeout | built-in | Per-workspace debounce/coalescing | Codebase pattern (startup-script.service.ts) |
| TypeScript | (project) | Type-safe event-to-field mapping | Project standard |
| Vitest | (project) | Co-located tests | Project standard |

### Supporting
No additional libraries needed. This is pure orchestration wiring using Node.js built-ins.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| setTimeout debounce | lodash.debounce | Extra dependency for trivial functionality; project has no lodash dependency |
| Per-workspace timer map | Single global timer | Global timer would delay ALL workspaces even when only one has rapid-fire events |
| Accumulate-then-flush | Immediate upsert per event | Violates EVNT-08 (coalescing requirement); causes excessive derived state recomputation |
| Leading-edge + trailing-edge debounce | Trailing-edge only | Leading-edge fires immediately on first event giving faster perceived latency, but the requirement says "coalesced into a single update" which means trailing-edge only |

## Architecture Patterns

### Recommended Project Structure
```
src/backend/orchestration/
  event-collector.orchestrator.ts         # Event subscription + coalescing + store upsert
  event-collector.orchestrator.test.ts    # Co-located tests
  domain-bridges.orchestrator.ts          # EXISTING: bridge wiring
  domain-bridges.orchestrator.test.ts     # EXISTING: bridge tests
  index.ts                                # EXISTING: barrel exports (add configureEventCollector)
```

### Pattern 1: Event Collector Orchestrator Function
**What:** A `configureEventCollector()` function that subscribes to all domain event emitters and translates events into store mutations. Follows the same pattern as `configureDomainBridges()`.
**When to use:** At server startup, called from `server.ts` after `configureDomainBridges()`.
**Example:**
```typescript
// Source: Follows pattern of domain-bridges.orchestrator.ts
import {
  WORKSPACE_STATE_CHANGED,
  type WorkspaceStateChangedEvent,
  workspaceStateMachine,
  workspaceActivityService,
} from '@/backend/domains/workspace';
import {
  PR_SNAPSHOT_UPDATED,
  type PRSnapshotUpdatedEvent,
  prSnapshotService,
} from '@/backend/domains/github';
import {
  RATCHET_STATE_CHANGED,
  type RatchetStateChangedEvent,
  ratchetService,
} from '@/backend/domains/ratchet';
import {
  RUN_SCRIPT_STATUS_CHANGED,
  type RunScriptStatusChangedEvent,
  runScriptStateMachine,
} from '@/backend/domains/run-script';
import {
  workspaceSnapshotStore,
  type SnapshotUpdateInput,
} from '@/backend/services';

export function configureEventCollector(): void {
  const coalescer = new EventCoalescer(workspaceSnapshotStore);

  workspaceStateMachine.on(WORKSPACE_STATE_CHANGED, (event: WorkspaceStateChangedEvent) => {
    coalescer.enqueue(event.workspaceId, { status: event.toStatus }, 'event:workspace_state_changed');
  });

  prSnapshotService.on(PR_SNAPSHOT_UPDATED, (event: PRSnapshotUpdatedEvent) => {
    coalescer.enqueue(event.workspaceId, {
      prNumber: event.prNumber,
      prState: event.prState as any,
      prCiStatus: event.prCiStatus as any,
    }, 'event:pr_snapshot_updated');
  });

  ratchetService.on(RATCHET_STATE_CHANGED, (event: RatchetStateChangedEvent) => {
    coalescer.enqueue(event.workspaceId, {
      ratchetState: event.toState,
    }, 'event:ratchet_state_changed');
  });

  runScriptStateMachine.on(RUN_SCRIPT_STATUS_CHANGED, (event: RunScriptStatusChangedEvent) => {
    coalescer.enqueue(event.workspaceId, {
      runScriptStatus: event.toStatus,
    }, 'event:run_script_status_changed');
  });

  workspaceActivityService.on('workspace_active', ({ workspaceId }: { workspaceId: string }) => {
    coalescer.enqueue(workspaceId, { isWorking: true }, 'event:workspace_active');
  });

  workspaceActivityService.on('workspace_idle', ({ workspaceId }: { workspaceId: string }) => {
    coalescer.enqueue(workspaceId, { isWorking: false }, 'event:workspace_idle');
  });
}
```

### Pattern 2: Per-Workspace Coalescing Buffer
**What:** A class that maintains a `Map<string, PendingUpdate>` where each pending update accumulates `SnapshotUpdateInput` fields and a debounce timer. When the timer fires, it flushes with a single `upsert()`.
**When to use:** For all event-driven snapshot updates -- this is the core of EVNT-08.
**Example:**
```typescript
// Source: Pattern from startup-script.service.ts createDebouncedOutputCallback
const COALESCE_WINDOW_MS = 150; // Within the 100-200ms requirement

interface PendingUpdate {
  fields: SnapshotUpdateInput;
  sources: Set<string>;
  timer: NodeJS.Timeout;
}

class EventCoalescer {
  private pending = new Map<string, PendingUpdate>();

  constructor(
    private store: { upsert: typeof workspaceSnapshotStore.upsert },
    private windowMs = COALESCE_WINDOW_MS,
  ) {}

  enqueue(workspaceId: string, fields: SnapshotUpdateInput, source: string): void {
    let pending = this.pending.get(workspaceId);

    if (pending) {
      // Merge new fields into existing pending update
      clearTimeout(pending.timer);
      Object.assign(pending.fields, fields);
      pending.sources.add(source);
    } else {
      pending = {
        fields: { ...fields },
        sources: new Set([source]),
        timer: null as any,
      };
      this.pending.set(workspaceId, pending);
    }

    // Reset the debounce timer
    pending.timer = setTimeout(() => this.flush(workspaceId), this.windowMs);
  }

  private flush(workspaceId: string): void {
    const pending = this.pending.get(workspaceId);
    if (!pending) return;

    this.pending.delete(workspaceId);

    const source = [...pending.sources].join('+');
    this.store.upsert(workspaceId, pending.fields, source);
  }

  /** Flush all pending updates immediately (for shutdown/testing). */
  flushAll(): void {
    for (const [workspaceId, pending] of this.pending) {
      clearTimeout(pending.timer);
      const source = [...pending.sources].join('+');
      this.store.upsert(workspaceId, pending.fields, source);
    }
    this.pending.clear();
  }

  /** Number of workspaces with pending updates (for testing). */
  get pendingCount(): number {
    return this.pending.size;
  }
}
```

### Pattern 3: Event-to-Field Mapping (Translation Layer)
**What:** Each domain event payload is translated into the specific `SnapshotUpdateInput` fields for that field group. The mapping is explicit, not generic.
**When to use:** In each event handler within `configureEventCollector()`.
**Key mappings:**

| Domain Event | Event Payload Fields | SnapshotUpdateInput Fields | Field Group |
|-------------|---------------------|---------------------------|-------------|
| `WORKSPACE_STATE_CHANGED` | `workspaceId`, `fromStatus`, `toStatus` | `{ status: event.toStatus }` | `workspace` |
| `PR_SNAPSHOT_UPDATED` | `workspaceId`, `prNumber`, `prState`, `prCiStatus`, `prReviewState` | `{ prNumber, prState, prCiStatus }` | `pr` |
| `RATCHET_STATE_CHANGED` | `workspaceId`, `fromState`, `toState` | `{ ratchetState: event.toState }` | `ratchet` |
| `RUN_SCRIPT_STATUS_CHANGED` | `workspaceId`, `fromStatus`, `toStatus` | `{ runScriptStatus: event.toStatus }` | `runScript` |
| `workspace_active` | `workspaceId` | `{ isWorking: true }` | `session` |
| `workspace_idle` | `workspaceId` | `{ isWorking: false }` | `session` |

**Important note on `prReviewState`:** The `PRSnapshotUpdatedEvent` includes `prReviewState` but the `SnapshotUpdateInput` does NOT have a `prReviewState` field (the snapshot entry does not store review state separately -- it is used by the ratchet domain). Only map fields that exist in `SnapshotUpdateInput`.

### Pattern 4: Source String for Debug Metadata
**What:** The `source` parameter passed to `upsert()` identifies which event(s) triggered the update. When coalesced, multiple sources are joined with `+`.
**When to use:** Always -- the store records this for debug observability.
**Examples:**
- Single event: `"event:workspace_state_changed"`
- Coalesced: `"event:workspace_state_changed+event:ratchet_state_changed"`

### Anti-Patterns to Avoid
- **Importing snapshot store inside domains:** The collector lives in `orchestration/`, not in any domain. Domains emit events without knowing about the snapshot store. This is the bridge pattern (EVNT-07).
- **Calling upsert() directly from event handlers without coalescing:** Violates EVNT-08. Always go through the coalescer.
- **Creating snapshot entries on events for unknown workspaces:** The `upsert()` requires `projectId` on first call. Events from workspace state machine only provide `workspaceId`. The collector must either: (a) skip upsert if the workspace doesn't already exist in the store (reconciliation will seed it), or (b) look up projectId from the DB. Option (a) is simpler and correct -- Phase 14 reconciliation will seed all workspace entries with full data on startup.
- **Subscribing to events before configureDomainBridges():** Domain singletons must be configured before their events are meaningful. Call `configureEventCollector()` AFTER `configureDomainBridges()` in server.ts.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Event subscription | Custom pub/sub system | Node.js EventEmitter `.on()` | All domain services already extend EventEmitter |
| Timer-based debounce | Complex scheduling framework | `setTimeout`/`clearTimeout` | Codebase pattern, trivially correct for single-process |
| Field merging | Custom merge logic | `Object.assign()` + store's field-level timestamps | Store already handles concurrent field-group conflicts |
| Derived state | Manual recomputation in collector | Store's built-in `recomputeDerivedState()` | Store recomputes on every `upsert()` -- collector never touches derived fields |

**Key insight:** The collector is a thin translation/coalescing layer. It does NOT compute derived state, handle field conflicts, or manage versions. All that complexity is already in the store (Phase 11). The collector's only job is: listen to events, batch them by workspace, and call `upsert()`.

## Common Pitfalls

### Pitfall 1: Upserting Workspaces That Don't Exist in Store Yet
**What goes wrong:** Event fires for a workspace before reconciliation seeds it. `upsert()` throws because `projectId` is missing on first call.
**Why it happens:** Events start flowing as soon as the server starts, but the store only gets seeded during reconciliation (Phase 14) or when a workspace is first loaded.
**How to avoid:** Guard each coalescer flush with a check: if the workspace doesn't exist in the store and the pending fields don't include `projectId`, skip the upsert and log a debug message. Reconciliation will pick it up.
**Warning signs:** Errors like "Cannot create snapshot for workspace X: projectId is required on first upsert" in logs during startup.

### Pitfall 2: Timer Leaks on Server Shutdown
**What goes wrong:** Pending setTimeout timers prevent clean server shutdown or fire after the store is cleared.
**Why it happens:** `configureEventCollector()` creates timers but has no cleanup path.
**How to avoid:** Export a `stopEventCollector()` function that calls `coalescer.flushAll()` and clears all timers. Call it from `server.ts`'s `performCleanup()`.
**Warning signs:** "Cannot read properties of undefined" errors during shutdown, or Vitest test timeout due to pending timers.

### Pitfall 3: Object.assign Overwrites with Undefined
**What goes wrong:** If a field in the coalesced update is `undefined`, `Object.assign` does NOT overwrite -- but if explicitly set to `undefined`, it does. Need to ensure only defined fields are passed.
**Why it happens:** Mixing event payloads that have different shapes.
**How to avoid:** Always construct explicit `SnapshotUpdateInput` objects from event payloads with only the relevant fields. Never spread the entire event payload into the update.
**Warning signs:** Fields mysteriously becoming `undefined` in snapshot entries.

### Pitfall 4: Coalescing Window Too Small or Too Large
**What goes wrong:** Too small (e.g., 10ms) and events don't actually coalesce -- defeating the purpose. Too large (e.g., 1s) and the UI feels laggy.
**Why it happens:** Miscalibrating the debounce window.
**How to avoid:** Use 150ms as default (middle of the 100-200ms requirement). Make it configurable via constructor parameter for testing. In tests, use a 0ms or very small window to avoid test flakiness.
**Warning signs:** Tests timing out waiting for coalesced updates, or rapid-fire events producing multiple snapshot updates.

### Pitfall 5: Circular Import Between orchestration/ barrel and event-collector
**What goes wrong:** The existing orchestration `index.ts` has a comment warning about circular deps. Adding `configureEventCollector` export could trigger the same issue.
**Why it happens:** `domain-bridges.orchestrator.ts` imports from domain barrels; domain barrels may import from orchestration barrel.
**How to avoid:** Follow the same pattern as `configureDomainBridges` -- do NOT re-export from `index.ts`. Import directly from `./event-collector.orchestrator` in `server.ts`. The existing comment explicitly warns about this.
**Warning signs:** Runtime errors like "Cannot access X before initialization" or "X is not a function".

### Pitfall 6: Type Narrowing Between Event Payloads and SnapshotUpdateInput
**What goes wrong:** Domain event payloads use string unions (e.g., `RatchetState`, `WorkspaceStatus`) from Prisma. `SnapshotUpdateInput` also uses these types. But the event payload type might not be directly assignable.
**Why it happens:** Event payload fields are typed as specific Prisma enums, but the mapping might need explicit casting.
**How to avoid:** Use `satisfies SnapshotUpdateInput` or explicit type annotations in the mapping functions. Test that TypeScript compiles without errors.
**Warning signs:** TypeScript compilation errors at the mapping sites.

## Code Examples

Verified patterns from the codebase:

### Server Startup Wiring
```typescript
// Source: src/backend/server.ts lines 283-284
// EXISTING PATTERN -- add configureEventCollector() after configureDomainBridges()

configureDomainBridges();
configureEventCollector(); // NEW -- Phase 13

try {
  await reconciliationService.cleanupOrphans();
} catch (error) {
  // ...
}
```

### Coalescer Flush Guard (Skip Unknown Workspaces)
```typescript
// Guard against upserting workspaces not yet seeded in store
private flush(workspaceId: string): void {
  const pending = this.pending.get(workspaceId);
  if (!pending) return;

  this.pending.delete(workspaceId);

  // If workspace doesn't exist in store and we don't have projectId,
  // skip -- reconciliation (Phase 14) will seed it
  const existing = this.store.getByWorkspaceId(workspaceId);
  if (!existing && !pending.fields.projectId) {
    logger.debug('Skipping upsert for unknown workspace (awaiting reconciliation)', {
      workspaceId,
      sources: [...pending.sources],
    });
    return;
  }

  const source = [...pending.sources].join('+');
  this.store.upsert(workspaceId, pending.fields, source);
}
```

### Testing Pattern: Fake Timers for Coalescing
```typescript
// Source: Pattern from vitest docs
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('EventCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid-fire events into single upsert', () => {
    const mockStore = { upsert: vi.fn(), getByWorkspaceId: vi.fn(() => ({ projectId: 'p1' })) };
    const coalescer = new EventCoalescer(mockStore, 150);

    coalescer.enqueue('ws-1', { status: 'READY' }, 'event:workspace_state_changed');
    coalescer.enqueue('ws-1', { ratchetState: 'IDLE' }, 'event:ratchet_state_changed');

    // Before timer fires, no upsert
    expect(mockStore.upsert).not.toHaveBeenCalled();

    // Advance past coalescing window
    vi.advanceTimersByTime(150);

    // Single upsert with merged fields
    expect(mockStore.upsert).toHaveBeenCalledTimes(1);
    expect(mockStore.upsert).toHaveBeenCalledWith(
      'ws-1',
      { status: 'READY', ratchetState: 'IDLE' },
      'event:workspace_state_changed+event:ratchet_state_changed'
    );
  });
});
```

### Cleanup Pattern for Server Shutdown
```typescript
// Source: Pattern from server.ts performCleanup
const performCleanup = async () => {
  // ... existing cleanup ...
  stopEventCollector(); // NEW -- flush pending and clear timers
  await ratchetService.stop();
  // ...
};
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Direct polling (getProjectSummaryState) | Event-driven snapshot + poll safety net | v1.1 (now) | Eliminates redundant DB queries; sub-200ms UI updates |
| Per-consumer polling loops | Single materialized view | v1.1 (now) | One source of truth; sidebar + kanban + workspace list all read same data |

**Deprecated/outdated:**
- Nothing deprecated yet. Phase 13 adds new infrastructure. Phase 16-17 will deprecate the old polling paths.

## Open Questions

1. **Should the coalescer handle workspace ARCHIVED events specially?**
   - What we know: `WorkspaceStateChangedEvent` with `toStatus: 'ARCHIVED'` means the workspace should be removed from the store. The store has a `remove()` method for this.
   - What's unclear: Should the collector call `store.remove()` directly on ARCHIVED events, or should reconciliation handle it? The event fires after the DB transition succeeds.
   - Recommendation: Handle it in the collector -- call `store.remove(workspaceId)` when `toStatus === 'ARCHIVED'`. This gives immediate UI feedback. Reconciliation acts as safety net. This makes the collector slightly smarter but avoids stale ARCHIVED entries lingering for up to 60s.

2. **Should the coalescer also handle pending request type changes?**
   - What we know: `chatEventForwarderService` manages pending interactive requests (`plan_approval`, `user_question`). The snapshot has a `pendingRequestType` field.
   - What's unclear: Phase 12 did not add an explicit event for pending request changes. The `workspace_active`/`workspace_idle` events from `WorkspaceActivityService` don't carry pending request information.
   - Recommendation: Defer pending request type to Phase 14 reconciliation. It is already computed during the existing `getProjectSummaryState()` flow. Adding a new event to session domain for this is out of scope for Phase 13. The reconciliation poll (Phase 14) will populate this field every ~60s, which is acceptable latency for this particular UI element.

3. **How should the collector handle the store not being configured yet?**
   - What we know: `workspaceSnapshotStore.configure()` is called inside `configureDomainBridges()`. Events could theoretically fire before configuration.
   - What's unclear: Whether events can fire during startup before the store is configured.
   - Recommendation: Since `configureEventCollector()` is called AFTER `configureDomainBridges()` in server.ts, and event listeners are only registered inside `configureEventCollector()`, this is not a real risk. The coalescing timer adds another layer of safety -- by the time any timer fires (150ms later), the store will be configured.

## Sources

### Primary (HIGH confidence)
- **Codebase analysis:** `src/backend/services/workspace-snapshot-store.service.ts` -- store API, upsert signature, field groups, event emission
- **Codebase analysis:** `src/backend/orchestration/domain-bridges.orchestrator.ts` -- orchestration pattern, import structure, startup wiring
- **Codebase analysis:** `src/backend/server.ts` -- startup sequence, cleanup flow
- **Codebase analysis:** `src/backend/domains/workspace/lifecycle/state-machine.service.ts` -- WORKSPACE_STATE_CHANGED event shape
- **Codebase analysis:** `src/backend/domains/github/pr-snapshot.service.ts` -- PR_SNAPSHOT_UPDATED event shape
- **Codebase analysis:** `src/backend/domains/ratchet/ratchet.service.ts` -- RATCHET_STATE_CHANGED event shape
- **Codebase analysis:** `src/backend/domains/run-script/run-script-state-machine.service.ts` -- RUN_SCRIPT_STATUS_CHANGED event shape
- **Codebase analysis:** `src/backend/domains/workspace/lifecycle/activity.service.ts` -- workspace_active/workspace_idle event shapes
- **Codebase analysis:** `.planning/phases/12-domain-event-emission/12-VERIFICATION.md` -- confirmed all 5 event sources working
- **Codebase analysis:** `.planning/phases/11-snapshot-store/11-RESEARCH.md` -- store design decisions
- **Codebase analysis:** `.planning/REQUIREMENTS.md` -- EVNT-06, EVNT-07, EVNT-08 requirement definitions

### Secondary (MEDIUM confidence)
- **Codebase analysis:** `src/backend/domains/run-script/startup-script.service.ts` -- debounce pattern using setTimeout/clearTimeout (lines 336-385)
- **Codebase analysis:** `.dependency-cruiser.cjs` -- no-cross-domain-imports and no-domains-importing-orchestration rules

### Tertiary (LOW confidence)
None. All findings are from direct codebase analysis.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- Pure Node.js built-ins, no new dependencies
- Architecture: HIGH -- Follows established orchestration pattern exactly
- Pitfalls: HIGH -- Derived from actual codebase constraints and testing patterns
- Event-to-field mapping: HIGH -- All event types and store types are known and verified

**Research date:** 2026-02-11
**Valid until:** 2026-03-11 (stable domain -- no external dependencies to change)
