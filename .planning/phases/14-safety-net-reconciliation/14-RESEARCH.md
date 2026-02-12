# Phase 14: Safety-Net Reconciliation - Research

**Researched:** 2026-02-11
**Domain:** Periodic full-state reconciliation with drift detection for in-memory snapshot store
**Confidence:** HIGH

## Summary

Phase 14 creates a periodic reconciliation service that recomputes workspace snapshots from authoritative DB and git sources every ~60 seconds. This is the "safety net" that catches any events missed by the event-driven pipeline (Phase 12-13) and is also responsible for initial population of the snapshot store on server startup. The reconciliation service computes expensive git stats (diff size, uncommitted changes) that are explicitly excluded from event-driven updates (RCNL-02), and logs observable drift when the event-driven snapshot state diverges from authoritative sources (RCNL-04).

The critical design constraint is RCNL-03: reconciliation must not overwrite event-driven updates that arrived after the poll started. The snapshot store already has field-level timestamp merging (implemented in Phase 11). The reconciliation records its poll-start timestamp and passes it to `upsert()`, so that any event-driven updates that wrote fields during the poll window (with a newer timestamp) are preserved. This is the exact mechanism the store was designed for -- the 6 field groups (`workspace`, `pr`, `session`, `ratchet`, `runScript`, `reconciliation`) each have independent timestamps.

The codebase has a clear model for this: `getProjectSummaryState()` in `workspace-query.service.ts` already computes the exact data the reconciliation needs -- DB workspace fields, session working status, pending request type, git stats, and derived state. The reconciliation service follows this logic but writes to the snapshot store instead of returning directly. It lives in `src/backend/orchestration/` because it needs to read from multiple domain modules (workspace accessor, session service, git ops) and write to the snapshot store -- this is cross-domain coordination, the orchestration layer's purpose.

**Primary recommendation:** Create `snapshot-reconciliation.orchestrator.ts` in `src/backend/orchestration/` with a `SnapshotReconciliationService` class that uses `setInterval` for the ~60s poll cadence. On each tick: record timestamp, query all non-archived workspaces with sessions from DB, compute session working status and pending requests via bridge, compute git stats with concurrency limiting, diff against current snapshot state and log drift, then upsert all fields with the recorded timestamp. Initial population (first run) seeds all workspaces. Wire start/stop into `server.ts`.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | (project) | Type-safe reconciliation logic | Project standard |
| Node.js setInterval/clearInterval | built-in | Periodic ~60s poll cadence | Codebase pattern (schedulerService uses setInterval) |
| p-limit | ^7.2.0 | Concurrent git stats computation (3 at a time) | Already used in workspace-query.service.ts and scheduler.service.ts |
| Vitest | (project) | Co-located unit tests | Project standard |

### Supporting
No additional libraries needed. All dependencies are already in the project.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| setInterval | Continuous loop with sleep (ratchet pattern) | Continuous loop supports backoff/wake-on-demand, but reconciliation doesn't need either -- fixed cadence is simpler |
| Single setInterval | Per-project separate timers | Over-engineering; workspace count is small (10s-100s), single loop is sufficient |
| Orchestration layer | Infrastructure service | The reconciliation reads from domains (session, workspace) and writes to services (snapshot store) -- this is cross-domain coordination, so orchestration is the right home |

## Architecture Patterns

### Recommended Project Structure
```
src/backend/orchestration/
  snapshot-reconciliation.orchestrator.ts       # Reconciliation service + types
  snapshot-reconciliation.orchestrator.test.ts  # Co-located tests
  event-collector.orchestrator.ts               # EXISTING: event wiring (Phase 13)
  domain-bridges.orchestrator.ts                # EXISTING: bridge wiring
  index.ts                                      # EXISTING: barrel (do NOT add reconciliation here)
```

### Pattern 1: Reconciliation Service with Bridge-Style Injection
**What:** A class that receives domain capabilities through a `configure()` call, matching the codebase pattern. The service needs session working status and pending request info from the session domain, but should not hardcode these imports -- they should be injected.
**When to use:** At server startup, configured from `domain-bridges.orchestrator.ts` or directly in `server.ts`.
**Example:**
```typescript
export interface ReconciliationBridges {
  session: {
    isAnySessionWorking(sessionIds: string[]): boolean;
    getAllPendingRequests(): Map<string, { toolName: string }>;
  };
}

class SnapshotReconciliationService {
  private interval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private reconcileInProgress: Promise<unknown> | null = null;
  private bridges: ReconciliationBridges | null = null;

  configure(bridges: ReconciliationBridges): void {
    this.bridges = bridges;
  }

  start(): void {
    if (this.interval) return;
    this.isShuttingDown = false;

    // Run initial reconciliation immediately (seeds the store)
    this.reconcileInProgress = this.reconcile().catch((err) =>
      logger.error('Initial reconciliation failed', err)
    );

    this.interval = setInterval(() => {
      if (this.isShuttingDown || this.reconcileInProgress) return;
      this.reconcileInProgress = this.reconcile()
        .catch((err) => logger.error('Reconciliation failed', err))
        .finally(() => { this.reconcileInProgress = null; });
    }, RECONCILIATION_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.reconcileInProgress) {
      await this.reconcileInProgress;
    }
  }
}
```

### Pattern 2: Field-Level Timestamp Comparison for Drift Detection (RCNL-03 + RCNL-04)
**What:** Before upserting, compare the reconciled authoritative state against the current snapshot entry. For each field group, if the reconciled value differs from the snapshot value, log it as drift. Then pass the poll-start timestamp to upsert, so the store's field-level timestamp merge preserves any event-driven updates that arrived after the poll started.
**When to use:** On every reconciliation tick for every workspace.
**Example:**
```typescript
async reconcile(): Promise<ReconciliationResult> {
  const pollStartTs = Date.now();
  // ... fetch all workspaces from DB ...
  // ... compute session status, git stats ...

  for (const workspace of workspaces) {
    const authoritativeFields: SnapshotUpdateInput = {
      projectId: workspace.projectId,
      name: workspace.name,
      status: workspace.status,
      // ... all DB fields ...
      gitStats: computedGitStats,
      lastActivityAt: computedLastActivity,
      isWorking: effectiveIsWorking,
      pendingRequestType: computedPendingRequest,
    };

    // Check for drift (RCNL-04)
    const existing = workspaceSnapshotStore.getByWorkspaceId(workspace.id);
    if (existing) {
      const drifts = detectDrift(existing, authoritativeFields);
      if (drifts.length > 0) {
        logger.warn('Reconciliation drift detected', {
          workspaceId: workspace.id,
          drifts,
        });
      }
    }

    // Upsert with pollStartTs -- store's field-level merge preserves
    // any event-driven updates that arrived after pollStartTs (RCNL-03)
    workspaceSnapshotStore.upsert(
      workspace.id,
      authoritativeFields,
      'reconciliation',
      pollStartTs
    );
  }
}
```

### Pattern 3: Store Cleanup for Removed Workspaces
**What:** After reconciling all active workspaces, check the snapshot store for entries that no longer exist in the DB (workspace was archived between polls). Remove stale entries.
**When to use:** At the end of every reconciliation tick.
**Example:**
```typescript
// After upserting all DB workspaces, clean up stale entries
// Get all workspace IDs currently in the store
// Compare against DB workspace IDs -- remove any that are missing
const dbWorkspaceIds = new Set(workspaces.map(w => w.id));
const allStoreEntries = /* all entries from store */;
for (const entry of allStoreEntries) {
  if (!dbWorkspaceIds.has(entry.workspaceId)) {
    workspaceSnapshotStore.remove(entry.workspaceId);
    logger.info('Removed stale snapshot entry', { workspaceId: entry.workspaceId });
  }
}
```

Note: The store currently has `getByProjectId()` but no `getAll()` method. The reconciliation will need either: (a) a new `getAllWorkspaceIds()` method on the store, or (b) iterate by project. Option (a) is simpler and more reliable.

### Pattern 4: Git Stats Computed Only During Reconciliation (RCNL-02)
**What:** Git stats (diff size, additions, deletions, hasUncommitted) are expensive (spawns git processes). They are NEVER computed in event-driven paths -- only during reconciliation. The `reconciliation` field group in the store contains `gitStats` and `lastActivityAt`.
**When to use:** Only in the reconciliation service, never in the event collector.
**Example:**
```typescript
// Use p-limit for concurrent git operations (matching workspace-query.service.ts)
const GIT_CONCURRENCY = 3;
const gitLimit = pLimit(GIT_CONCURRENCY);

const gitStatsResults = await Promise.all(
  workspaces.map((workspace) =>
    gitLimit(async () => {
      if (!workspace.worktreePath) return { id: workspace.id, stats: null };
      try {
        const stats = await gitOpsService.getWorkspaceGitStats(
          workspace.worktreePath,
          defaultBranch
        );
        return { id: workspace.id, stats };
      } catch {
        return { id: workspace.id, stats: null };
      }
    })
  )
);
```

### Pattern 5: Drift Detection Function
**What:** A pure function that compares an existing snapshot entry against authoritative reconciled values and returns a list of drifted fields with old/new values.
**When to use:** Called for each workspace during reconciliation when an existing entry exists.
**Example:**
```typescript
interface DriftEntry {
  field: string;
  group: SnapshotFieldGroup;
  snapshotValue: unknown;
  authoritativeValue: unknown;
}

function detectDrift(
  existing: WorkspaceSnapshotEntry,
  authoritative: SnapshotUpdateInput
): DriftEntry[] {
  const drifts: DriftEntry[] = [];

  // Compare workspace fields
  if (authoritative.status !== undefined && authoritative.status !== existing.status) {
    drifts.push({ field: 'status', group: 'workspace', snapshotValue: existing.status, authoritativeValue: authoritative.status });
  }
  // ... similar for all raw fields in all field groups ...

  return drifts;
}
```

### Anti-Patterns to Avoid
- **Skipping the pollStartTs on upsert:** If reconciliation calls `upsert()` without passing the poll-start timestamp, the store uses `Date.now()` which is AFTER the poll. This would make reconciliation always win over concurrent event-driven updates, violating RCNL-03. Always pass `pollStartTs` explicitly.
- **Computing git stats in event handlers:** Git stats are expensive (shell spawns). They MUST only be computed during reconciliation, never in the event collector. The `reconciliation` field group exists specifically for this.
- **Re-exporting from orchestration/index.ts:** Same circular dep risk as the event collector. Import directly in `server.ts`.
- **Running reconciliation before bridges are configured:** The reconciliation needs session bridges. Start it AFTER `configureDomainBridges()` and `configureEventCollector()`.
- **Blocking the setInterval callback with await:** The callback should fire-and-forget with error catching, and skip if a previous reconciliation is still in progress. Never `await` inside `setInterval`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Git stats computation | Custom git parsing | `gitOpsService.getWorkspaceGitStats()` | Already implemented, tested, handles edge cases (missing worktree, git errors) |
| Session working status | Custom session lookup | Bridge to `sessionService.isAnySessionWorking()` | Session domain owns this data |
| Pending request detection | Custom session scanning | Bridge to `chatEventForwarderService.getAllPendingRequests()` | Chat domain owns pending requests |
| Field-level timestamp merge | Manual field comparison on write | `workspaceSnapshotStore.upsert()` with timestamp parameter | Store already implements this (Phase 11) |
| Derived state computation | Manual flow state / kanban / sidebar | Store's `recomputeDerivedState()` triggered by `upsert()` | Store recomputes on every upsert automatically |
| Concurrency limiting | Custom semaphore | `p-limit` | Already a project dependency, used in 4+ places |

**Key insight:** The reconciliation service is essentially `getProjectSummaryState()` restructured to write to the snapshot store instead of returning data. Almost all the computation logic already exists. The new parts are: (a) the periodic poll loop, (b) drift detection + logging, (c) passing poll-start timestamp to upsert for RCNL-03 compliance.

## Common Pitfalls

### Pitfall 1: Not Passing pollStartTs to upsert (RCNL-03 Violation)
**What goes wrong:** Reconciliation reads DB at T1, computes for 2 seconds, then calls `upsert()` at T3 without a timestamp. The store uses `Date.now()` (T3) which is newer than any event-driven update at T2. Reconciliation overwrites fresher event-driven data.
**Why it happens:** The `upsert()` `timestamp` parameter is optional and defaults to `Date.now()`. It's easy to forget.
**How to avoid:** Always capture `const pollStartTs = Date.now()` at the beginning of `reconcile()` and pass it to every `upsert()` call. This ensures the store's field-level merge correctly preserves any event-driven updates that arrived during the reconciliation window.
**Warning signs:** Snapshot state flickering back to stale values after reconciliation runs, especially visible in the UI as brief regressions.

### Pitfall 2: Missing Workspace Accessor Method for Cross-Project Query
**What goes wrong:** Reconciliation needs ALL non-archived workspaces across ALL projects. The existing `findByProjectIdWithSessions()` requires a `projectId`, so reconciliation would need to query all projects first, then query workspaces per project. This is N+1 queries.
**Why it happens:** The current accessor was designed for per-project views (sidebar, kanban), not global operations.
**How to avoid:** Add a `findAllNonArchivedWithSessions()` method to `WorkspaceAccessor` that fetches all non-archived workspaces with sessions in a single query. Alternatively, query all projects then batch workspace queries, but a single method is cleaner.
**Warning signs:** Reconciliation taking much longer than expected due to serial per-project queries.

### Pitfall 3: Git Stats Blocking Reconciliation
**What goes wrong:** Git stats computation spawns shell processes. If 50 workspaces all have worktrees, running git stats serially takes 50 * ~200ms = 10 seconds. This blocks the reconciliation loop.
**Why it happens:** Not applying concurrency limiting to git operations.
**How to avoid:** Use `p-limit(3)` (matching the `DEFAULT_GIT_CONCURRENCY` in workspace-query.service.ts) to limit concurrent git operations. Also, consider a total timeout for git stats -- if a workspace's git stats takes too long, skip it and use the previous value.
**Warning signs:** Reconciliation taking >10 seconds, reported in logs.

### Pitfall 4: Reconciliation Running During Startup Before Store is Configured
**What goes wrong:** If `start()` is called before `workspaceSnapshotStore.configure()`, the first `upsert()` call throws "WorkspaceSnapshotStore not configured."
**Why it happens:** Incorrect startup ordering in `server.ts`.
**How to avoid:** Call in this order: `configureDomainBridges()` (configures store) -> `configureEventCollector()` -> `snapshotReconciliationService.configure()` -> `snapshotReconciliationService.start()`. The bridges must be wired first.
**Warning signs:** "WorkspaceSnapshotStore not configured" error on startup.

### Pitfall 5: Not Handling Default Branch per Project
**What goes wrong:** Git stats require the project's `defaultBranch` to compute merge-base diffs. If reconciliation uses a hardcoded 'main', it produces wrong stats for projects with different default branches (e.g., 'master', 'develop').
**Why it happens:** The workspace accessor doesn't include project data by default.
**How to avoid:** Either: (a) fetch workspaces with project relation included, or (b) build a project ID -> default branch lookup map from the project list. The existing `getProjectSummaryState()` already does this: `const defaultBranch = project?.defaultBranch ?? 'main'`.
**Warning signs:** Git stats showing 0 changes for projects that use non-'main' default branches.

### Pitfall 6: Timer Leak on Server Shutdown
**What goes wrong:** `setInterval` keeps firing after the server starts shutting down, causing "Cannot read properties" errors.
**Why it happens:** `stop()` not called or called after `clearInterval` already done.
**How to avoid:** Follow the `schedulerService` pattern: set `isShuttingDown = true`, `clearInterval()`, then `await` any in-progress reconciliation. Wire `stop()` into `performCleanup()` in `server.ts`.
**Warning signs:** Error logs during shutdown, Vitest tests timing out due to pending timers.

### Pitfall 7: Logging Too Much Drift on First Run
**What goes wrong:** On the very first reconciliation (initial population), every workspace is "drifted" because the store is empty. This produces hundreds of noisy drift log entries.
**Why it happens:** Drift detection runs on the first tick when no snapshot entries exist yet.
**How to avoid:** Skip drift detection when the entry doesn't exist in the store yet (this is initial seeding, not drift). Only log drift for entries that already exist.
**Warning signs:** Massive log spam on server startup.

## Code Examples

### Reconciliation Service Skeleton
```typescript
// Source: Following patterns from scheduler.service.ts and workspace-query.service.ts

import pLimit from 'p-limit';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import { projectAccessor } from '@/backend/resource_accessors/project.accessor';
import { gitOpsService } from '@/backend/services/git-ops.service';
import {
  createLogger,
  workspaceSnapshotStore,
  type SnapshotUpdateInput,
} from '@/backend/services';

const logger = createLogger('snapshot-reconciliation');
const RECONCILIATION_INTERVAL_MS = 60_000; // ~60 seconds
const GIT_CONCURRENCY = 3;

export interface ReconciliationBridges {
  session: {
    isAnySessionWorking(sessionIds: string[]): boolean;
    getAllPendingRequests(): Map<string, { toolName: string }>;
  };
}

export interface ReconciliationResult {
  workspacesReconciled: number;
  driftsDetected: number;
  staleEntriesRemoved: number;
  gitStatsComputed: number;
  durationMs: number;
}
```

### Drift Detection
```typescript
// Source: Custom for Phase 14 RCNL-04

interface DriftEntry {
  field: string;
  group: string;
  snapshotValue: unknown;
  authoritativeValue: unknown;
}

function detectDrift(
  existing: WorkspaceSnapshotEntry,
  authoritative: SnapshotUpdateInput
): DriftEntry[] {
  const drifts: DriftEntry[] = [];

  const checks: Array<{
    field: string;
    group: string;
    existingVal: unknown;
    authVal: unknown;
  }> = [
    { field: 'status', group: 'workspace', existingVal: existing.status, authVal: authoritative.status },
    { field: 'name', group: 'workspace', existingVal: existing.name, authVal: authoritative.name },
    { field: 'branchName', group: 'workspace', existingVal: existing.branchName, authVal: authoritative.branchName },
    { field: 'prState', group: 'pr', existingVal: existing.prState, authVal: authoritative.prState },
    { field: 'prCiStatus', group: 'pr', existingVal: existing.prCiStatus, authVal: authoritative.prCiStatus },
    { field: 'prNumber', group: 'pr', existingVal: existing.prNumber, authVal: authoritative.prNumber },
    { field: 'ratchetEnabled', group: 'ratchet', existingVal: existing.ratchetEnabled, authVal: authoritative.ratchetEnabled },
    { field: 'ratchetState', group: 'ratchet', existingVal: existing.ratchetState, authVal: authoritative.ratchetState },
    { field: 'runScriptStatus', group: 'runScript', existingVal: existing.runScriptStatus, authVal: authoritative.runScriptStatus },
    { field: 'isWorking', group: 'session', existingVal: existing.isWorking, authVal: authoritative.isWorking },
    { field: 'pendingRequestType', group: 'session', existingVal: existing.pendingRequestType, authVal: authoritative.pendingRequestType },
  ];

  for (const check of checks) {
    if (check.authVal !== undefined && check.authVal !== check.existingVal) {
      drifts.push({
        field: check.field,
        group: check.group,
        snapshotValue: check.existingVal,
        authoritativeValue: check.authVal,
      });
    }
  }

  return drifts;
}
```

### Pending Request Type Computation (from workspace-query.service.ts)
```typescript
// Source: workspace-query.service.ts lines 32-50

function computePendingRequestType(
  sessionIds: string[],
  pendingRequests: Map<string, { toolName: string }>
): 'plan_approval' | 'user_question' | null {
  for (const sessionId of sessionIds) {
    const request = pendingRequests.get(sessionId);
    if (!request) continue;
    if (request.toolName === 'ExitPlanMode') return 'plan_approval';
    if (request.toolName === 'AskUserQuestion') return 'user_question';
  }
  return null;
}
```

### Server Startup Wiring
```typescript
// In server.ts, inside server.listen callback:
configureDomainBridges();          // Configures snapshot store derivation fns
configureEventCollector();         // Wires events -> store
configureSnapshotReconciliation(); // Wires session bridges + starts poll

// In performCleanup:
stopEventCollector();
await snapshotReconciliationService.stop(); // Wait for in-flight reconciliation
```

### Adding getAllWorkspaceIds to Store
```typescript
// Small addition to WorkspaceSnapshotStore for cleanup support
getAllWorkspaceIds(): string[] {
  return [...this.entries.keys()];
}
```

### Test Pattern: Verifying Drift Detection
```typescript
describe('drift detection', () => {
  it('detects field differences between snapshot and authoritative state', () => {
    const existing = createMockEntry({ status: 'READY', prState: 'OPEN' });
    const authoritative: SnapshotUpdateInput = {
      status: 'READY',    // Same -- no drift
      prState: 'MERGED',  // Different -- drift!
    };

    const drifts = detectDrift(existing, authoritative);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toEqual({
      field: 'prState',
      group: 'pr',
      snapshotValue: 'OPEN',
      authoritativeValue: 'MERGED',
    });
  });

  it('returns empty array when no drift', () => {
    const existing = createMockEntry({ status: 'READY' });
    const authoritative: SnapshotUpdateInput = { status: 'READY' };

    expect(detectDrift(existing, authoritative)).toHaveLength(0);
  });
});
```

### Test Pattern: pollStartTs Prevents Overwriting Fresher Events
```typescript
it('does not overwrite event-driven updates that arrived after poll started', () => {
  const store = new WorkspaceSnapshotStore();
  store.configure(mockDeriveFns);

  // Seed entry
  store.upsert('ws-1', { projectId: 'p1', status: 'NEW' }, 'initial', 1000);

  // Event-driven update at T=2000
  store.upsert('ws-1', { status: 'READY' }, 'event:workspace_state_changed', 2000);

  // Reconciliation started at T=1500, finishes now, writes with pollStartTs=1500
  store.upsert('ws-1', { status: 'NEW' }, 'reconciliation', 1500);

  // Event-driven update should win (2000 > 1500)
  const entry = store.getByWorkspaceId('ws-1')!;
  expect(entry.status).toBe('READY');
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `getProjectSummaryState()` called on every API request | Event-driven updates + periodic reconciliation safety net | v1.1 (Phase 11-14) | Reads become O(1) Map lookup; stale data corrected within 60s |
| Git stats computed on every sidebar load | Git stats computed only during reconciliation (~60s) | v1.1 (Phase 14) | Eliminates shell spawns from hot paths; git stats max 60s stale |
| No drift detection | Reconciliation logs drift between event-driven and DB state | v1.1 (Phase 14) | Observable correctness metric; catches missed events |

**Existing patterns preserved:**
- `setInterval` for periodic tasks (schedulerService)
- `p-limit` for git concurrency (workspace-query.service.ts)
- `configure()` bridge injection (throughout codebase)
- `isShuttingDown` + `await inProgress` for clean shutdown (schedulerService, ratchetService)

## Open Questions

1. **Should the reconciliation service live in orchestration/ or services/?**
   - What we know: It reads from multiple domains (workspace accessor, session service via bridge) and writes to infrastructure (snapshot store). The event collector lives in orchestration/ for the same reason.
   - What's unclear: Whether ARCH-02 (zero domain imports from services/) applies here.
   - Recommendation: **Use orchestration/.** ARCH-02 specifically targets the snapshot store service, not all services. But since reconciliation needs domain data (session bridges), placing it in orchestration follows the event collector precedent and keeps the import graph clean: orchestration -> domains + services.

2. **How should the reconciliation query workspaces across all projects?**
   - What we know: `findByProjectIdWithSessions()` requires a `projectId`. There's no `findAll` method on workspace accessor. `projectAccessor.list()` returns all projects.
   - What's unclear: Whether to add a new accessor method or compose existing ones.
   - Recommendation: **Add `findAllNonArchivedWithSessions()` to workspace accessor.** A single query is more efficient than N+1 per-project queries. The method is: `prisma.workspace.findMany({ where: { status: { not: 'ARCHIVED' } }, include: { claudeSessions: true, terminalSessions: true, project: true } })`. Including `project` gives us `defaultBranch` for git stats.

3. **Should reconciliation compute `lastActivityAt` from session timestamps?**
   - What we know: `getProjectSummaryState()` computes `lastActivityAt` from the max `updatedAt` across all claude and terminal sessions. This requires the `claudeSessions` and `terminalSessions` relations.
   - What's unclear: Whether this is worth the extra data fetched in the reconciliation query.
   - Recommendation: **Yes, include sessions in the query.** The session data is already needed for `isAnySessionWorking()` (to get session IDs), and `lastActivityAt` is a field in the snapshot entry. Computing it during reconciliation is the only path since there's no event for "session timestamp updated."

4. **How to handle the `getAllWorkspaceIds()` gap in the store?**
   - What we know: The store has `getByProjectId()` but no way to iterate all entries. Reconciliation needs to find stale entries (workspaces archived between polls).
   - What's unclear: Whether to add `getAllWorkspaceIds()` to the store or track reconciled IDs differently.
   - Recommendation: **Add `getAllWorkspaceIds(): string[]` to the store.** It's a simple `[...this.entries.keys()]` getter. This is the cleanest approach for the reconciliation cleanup step.

## Sources

### Primary (HIGH confidence)
- **Codebase analysis:** `src/backend/services/workspace-snapshot-store.service.ts` -- store API, `upsert()` with optional timestamp parameter, field groups, merge logic
- **Codebase analysis:** `src/backend/orchestration/event-collector.orchestrator.ts` -- orchestration layer pattern, import structure, server wiring
- **Codebase analysis:** `src/backend/domains/workspace/query/workspace-query.service.ts` -- `getProjectSummaryState()` computing all reconciliation data: DB fields, session status, git stats, derived state, pending requests
- **Codebase analysis:** `src/backend/services/scheduler.service.ts` -- `setInterval` + `isShuttingDown` + `syncInProgress` pattern for periodic services
- **Codebase analysis:** `src/backend/domains/ratchet/ratchet.service.ts` -- continuous loop + graceful shutdown pattern (alternative approach)
- **Codebase analysis:** `src/backend/services/git-ops.service.ts` -- `getWorkspaceGitStats()` API for git diff computation
- **Codebase analysis:** `src/backend/resource_accessors/workspace.accessor.ts` -- DB query methods, `findByProjectIdWithSessions()`, available query patterns
- **Codebase analysis:** `src/backend/resource_accessors/project.accessor.ts` -- `list()` for enumerating projects, `defaultBranch` field
- **Codebase analysis:** `src/backend/orchestration/domain-bridges.orchestrator.ts` -- bridge wiring pattern, session bridge structure
- **Codebase analysis:** `src/backend/server.ts` -- startup sequence (`configureDomainBridges` -> `configureEventCollector` -> services), cleanup sequence
- **Codebase analysis:** `src/backend/services/constants.ts` -- existing SERVICE_INTERVAL_MS patterns (ratchet: 2min, scheduler: 3min, reconciliation cleanup: 5min)
- **Codebase analysis:** `.planning/ROADMAP.md` -- Phase 14 requirements (RCNL-01 through RCNL-04)
- **Codebase analysis:** `.planning/REQUIREMENTS.md` -- RCNL requirement definitions
- **Codebase analysis:** `.planning/STATE.md` -- accumulated decisions from Phases 11-13

### Secondary (MEDIUM confidence)
- **Codebase analysis:** `src/backend/domains/workspace/bridges.ts` -- `WorkspaceSessionBridge` interface shape
- **Codebase analysis:** `src/backend/lib/git-helpers.ts` -- `getWorkspaceGitStats()` implementation (shell spawns, merge-base computation)
- **Prior research:** `.planning/phases/11-snapshot-store/11-RESEARCH.md` -- store design decisions, field-level timestamps, field groups
- **Prior research:** `.planning/phases/13-event-collector/13-RESEARCH.md` -- event collector patterns, circular dep avoidance, unknown workspace handling

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, reuses all existing patterns
- Architecture: HIGH -- follows established orchestration patterns (event-collector, domain-bridges), store API already supports timestamp-based merge
- Pitfalls: HIGH -- identified from direct code analysis of existing service patterns and known RCNL constraints
- Drift detection: HIGH -- straightforward field comparison, well-defined success criteria
- Git stats integration: HIGH -- `gitOpsService.getWorkspaceGitStats()` already exists and is battle-tested

**Research date:** 2026-02-11
**Valid until:** 2026-03-11 (stable domain -- no external dependencies to change)
