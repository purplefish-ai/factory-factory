/**
 * Snapshot Reconciliation Orchestrator
 *
 * Periodically recomputes workspace snapshots from authoritative DB and git
 * sources. This is the safety net that catches any events missed by the
 * event-driven pipeline (Phase 12-13), seeds the snapshot store on startup,
 * and is the only path for expensive git stats computation.
 *
 * Key behaviors:
 * - RCNL-02: Git stats computed with p-limit(3) concurrency
 * - RCNL-03: pollStartTs passed to every upsert for field-timestamp safety
 * - RCNL-04: Drift detection compares existing snapshot against authoritative values
 *
 * Import rules (same as event-collector.orchestrator.ts):
 * - Dependency types and pure helpers from domain barrels
 * - Runtime accessors, stores, Git, logging, and session ports supplied at construction
 * - NOT re-exported from orchestration/index.ts (circular dep avoidance)
 */

import { isDeepStrictEqual } from 'node:util';
import pLimit from 'p-limit';
import {
  buildWorkspaceSessionSummaries,
  hasWorkingSessionSummary,
} from '@/backend/lib/session-summaries';
import type { gitOpsService } from '@/backend/services/git-ops.service';
import type { createLogger } from '@/backend/services/logger.service';
import type { sessionService } from '@/backend/services/session';
import { computePendingRequestType, type workspaceAccessor } from '@/backend/services/workspace';
import type {
  SnapshotUpdateInput,
  WorkspaceSnapshotEntry,
  workspaceSnapshotStore,
} from '@/backend/services/workspace-snapshot-store.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECONCILIATION_INTERVAL_MS = 60_000;
const GIT_CONCURRENCY = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconciliationBridges {
  session: {
    getRuntimeSnapshot(sessionId: string): ReturnType<typeof sessionService.getRuntimeSnapshot>;
    getAllPendingRequests(): Map<string, { toolName: string; input?: Record<string, unknown> }>;
  };
}

export interface SnapshotReconciliationDependencies extends ReconciliationBridges {
  createLogger(
    component: string
  ): Pick<ReturnType<typeof createLogger>, 'debug' | 'error' | 'info' | 'warn'>;
  gitOpsService: Pick<typeof gitOpsService, 'getWorkspaceGitStats'>;
  workspaceAccessor: Pick<typeof workspaceAccessor, 'findAllNonArchivedWithSessionsAndProject'>;
  workspaceSnapshotStore: Pick<
    typeof workspaceSnapshotStore,
    'getAllWorkspaceIds' | 'getByWorkspaceId' | 'remove' | 'upsert'
  >;
}

export interface ReconciliationResult {
  workspacesScanned: number;
  workspacesChanged: number;
  deltasEmitted: number;
  workspacesReconciled: number;
  driftsDetected: number;
  staleEntriesRemoved: number;
  gitStatsComputed: number;
  durationMs: number;
}

interface DriftEntry {
  field: string;
  group: string;
  snapshotValue: unknown;
  authoritativeValue: unknown;
}

// ---------------------------------------------------------------------------
// Drift detection (pure function, exported for testing)
// ---------------------------------------------------------------------------

type DriftComparableField =
  | 'status'
  | 'name'
  | 'branchName'
  | 'prState'
  | 'prCiStatus'
  | 'prNumber'
  | 'ratchetEnabled'
  | 'ratchetState'
  | 'runScriptStatus'
  | 'isWorking'
  | 'pendingRequestType'
  | 'sessionSummaries';

const DRIFT_FIELD_GROUPS: { group: string; fields: DriftComparableField[] }[] = [
  { group: 'workspace', fields: ['status', 'name', 'branchName'] },
  { group: 'pr', fields: ['prState', 'prCiStatus', 'prNumber'] },
  { group: 'ratchet', fields: ['ratchetEnabled', 'ratchetState'] },
  { group: 'runScript', fields: ['runScriptStatus'] },
  { group: 'session', fields: ['isWorking', 'pendingRequestType', 'sessionSummaries'] },
];

/**
 * Compare an existing snapshot entry against authoritative values and return
 * a list of fields that have drifted.
 */
export function detectDrift(
  existing: WorkspaceSnapshotEntry,
  authoritative: SnapshotUpdateInput
): DriftEntry[] {
  const drifts: DriftEntry[] = [];

  for (const { group, fields } of DRIFT_FIELD_GROUPS) {
    for (const field of fields) {
      const authValue = authoritative[field];
      if (authValue === undefined) {
        continue;
      }
      const snapValue = existing[field];
      if (!isDeepStrictEqual(authValue, snapValue)) {
        drifts.push({
          field,
          group,
          snapshotValue: snapValue,
          authoritativeValue: authValue,
        });
      }
    }
  }

  return drifts;
}

// SnapshotReconciliationService
// ---------------------------------------------------------------------------

export class SnapshotReconciliationService {
  private readonly logger: Pick<
    ReturnType<typeof createLogger>,
    'debug' | 'error' | 'info' | 'warn'
  >;
  private interval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private reconcileInProgress: Promise<ReconciliationResult> | null = null;

  constructor(private readonly dependencies: Readonly<SnapshotReconciliationDependencies>) {
    this.logger = dependencies.createLogger('snapshot-reconciliation');
  }

  start(): void {
    if (this.interval) {
      return; // Already started
    }
    this.isShuttingDown = false;

    // Run initial reconciliation immediately
    this.reconcileInProgress = this.reconcile()
      .catch((err) => {
        this.logger.error('Initial reconciliation failed', { error: String(err) });
        return {
          workspacesScanned: 0,
          workspacesChanged: 0,
          deltasEmitted: 0,
          workspacesReconciled: 0,
          driftsDetected: 0,
          staleEntriesRemoved: 0,
          gitStatsComputed: 0,
          durationMs: 0,
        };
      })
      .finally(() => {
        this.reconcileInProgress = null;
      });

    // Set up periodic reconciliation
    this.interval = setInterval(() => {
      if (this.isShuttingDown || this.reconcileInProgress !== null) {
        return;
      }
      this.reconcileInProgress = this.reconcile()
        .catch((err) => {
          this.logger.error('Reconciliation tick failed', { error: String(err) });
          return {
            workspacesScanned: 0,
            workspacesChanged: 0,
            deltasEmitted: 0,
            workspacesReconciled: 0,
            driftsDetected: 0,
            staleEntriesRemoved: 0,
            gitStatsComputed: 0,
            durationMs: 0,
          };
        })
        .finally(() => {
          this.reconcileInProgress = null;
        });
    }, RECONCILIATION_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.reconcileInProgress !== null) {
      await this.reconcileInProgress;
    }
  }

  /**
   * If a reconciliation is currently in progress, waits for it to finish.
   * Used by the /snapshots WebSocket handler to defer the initial snapshot_full
   * message until the store is populated on startup.
   */
  waitForInProgress(): Promise<void> {
    if (this.reconcileInProgress !== null) {
      return this.reconcileInProgress.then(() => undefined);
    }
    return Promise.resolve();
  }

  /**
   * Build authoritative snapshot fields for a single workspace.
   */
  private buildAuthoritativeFields(
    ws: Awaited<
      ReturnType<
        SnapshotReconciliationDependencies['workspaceAccessor']['findAllNonArchivedWithSessionsAndProject']
      >
    >[number],
    allPendingRequests: Map<string, { toolName: string; input?: Record<string, unknown> }>,
    gitStatsMap: Map<
      string,
      { total: number; additions: number; deletions: number; hasUncommitted: boolean } | null
    >
  ): SnapshotUpdateInput {
    const sessionIds = [...(ws.agentSessions?.map((s) => s.id) ?? [])];
    const sessionSummaries = buildWorkspaceSessionSummaries(ws.agentSessions ?? [], (sessionId) =>
      this.dependencies.session.getRuntimeSnapshot(sessionId)
    );
    const isWorking = hasWorkingSessionSummary(sessionSummaries);
    const pendingRequestType = computePendingRequestType(sessionIds, allPendingRequests);

    // Compute lastActivityAt from session timestamps
    const sessionDates = [
      ...(ws.agentSessions?.map((s) => s.updatedAt) ?? []),
      ...(ws.terminalSessions?.map((s) => s.updatedAt) ?? []),
    ].filter(Boolean) as Date[];

    const lastActivityAt =
      sessionDates.length > 0
        ? sessionDates.reduce((latest, d) => (d > latest ? d : latest)).toISOString()
        : null;

    return {
      projectId: ws.projectId,
      name: ws.name,
      status: ws.status,
      createdAt: ws.createdAt.toISOString(),
      branchName: ws.branchName,
      hasHadSessions: ws.hasHadSessions,
      prUrl: ws.prUrl,
      prNumber: ws.prNumber,
      prState: ws.prState,
      prCiStatus: ws.prCiStatus,
      prUpdatedAt: ws.prUpdatedAt?.toISOString() ?? null,
      ratchetEnabled: ws.ratchetEnabled,
      ratchetState: ws.ratchetState,
      runScriptStatus: ws.runScriptStatus,
      isWorking,
      pendingRequestType,
      sessionSummaries,
      gitStats: gitStatsMap.get(ws.id) ?? null,
      lastActivityAt,
    };
  }

  /**
   * Remove snapshot entries for workspaces no longer in the DB.
   */
  private removeStaleEntries(dbWorkspaceIds: Set<string>): {
    staleEntriesRemoved: number;
    deltasEmitted: number;
  } {
    const storeWorkspaceIds = this.dependencies.workspaceSnapshotStore.getAllWorkspaceIds();
    let removed = 0;

    for (const storeId of storeWorkspaceIds) {
      if (
        !dbWorkspaceIds.has(storeId) &&
        this.dependencies.workspaceSnapshotStore.remove(storeId)
      ) {
        removed++;
        this.logger.info('Removed stale snapshot entry', { workspaceId: storeId });
      }
    }

    return { staleEntriesRemoved: removed, deltasEmitted: removed };
  }

  async reconcile(): Promise<ReconciliationResult> {
    const pollStartTs = Date.now();

    // 1. Fetch all non-archived workspaces from DB
    const workspaces =
      await this.dependencies.workspaceAccessor.findAllNonArchivedWithSessionsAndProject();

    // 2. Get pending requests from bridges
    const allPendingRequests = this.dependencies.session.getAllPendingRequests();

    // 3. Compute git stats with concurrency limit (RCNL-02)
    const gitLimit = pLimit(GIT_CONCURRENCY);
    const gitStatsMap = new Map<
      string,
      { total: number; additions: number; deletions: number; hasUncommitted: boolean } | null
    >();

    await Promise.all(
      workspaces.map((ws) =>
        gitLimit(async () => {
          if (!ws.worktreePath) {
            gitStatsMap.set(ws.id, null);
            return;
          }
          const defaultBranch = ws.project?.defaultBranch ?? 'main';
          try {
            const stats = await this.dependencies.gitOpsService.getWorkspaceGitStats(
              ws.worktreePath,
              defaultBranch
            );
            gitStatsMap.set(ws.id, stats);
          } catch {
            gitStatsMap.set(ws.id, null);
          }
        })
      )
    );

    // 4. Reconcile each workspace
    let driftsDetected = 0;
    let gitStatsComputed = 0;
    let workspacesChanged = 0;
    let deltasEmitted = 0;

    for (const ws of workspaces) {
      const authoritativeFields = this.buildAuthoritativeFields(
        ws,
        allPendingRequests,
        gitStatsMap
      );

      if (authoritativeFields.gitStats) {
        gitStatsComputed++;
      }

      // Drift detection (RCNL-04)
      const existing = this.dependencies.workspaceSnapshotStore.getByWorkspaceId(ws.id);
      if (existing) {
        const drifts = detectDrift(existing, authoritativeFields);
        if (drifts.length > 0) {
          driftsDetected += drifts.length;
          this.logger.warn('Snapshot drift detected', {
            workspaceId: ws.id,
            driftCount: drifts.length,
            drifts: drifts.map((d) => ({
              field: d.field,
              group: d.group,
              snapshot: d.snapshotValue,
              authoritative: d.authoritativeValue,
            })),
          });
        }
      }

      // Upsert with pollStartTs (RCNL-03)
      const upsertResult = this.dependencies.workspaceSnapshotStore.upsert(
        ws.id,
        authoritativeFields,
        'reconciliation',
        pollStartTs
      );
      if (upsertResult.changed) {
        workspacesChanged++;
      }
      if (upsertResult.emitted) {
        deltasEmitted++;
      }
    }

    // 5. Stale entry cleanup
    const staleCleanup = this.removeStaleEntries(new Set(workspaces.map((w) => w.id)));
    deltasEmitted += staleCleanup.deltasEmitted;

    // 6. Log summary
    const durationMs = Date.now() - pollStartTs;
    this.logger.info('Reconciliation complete', {
      workspacesScanned: workspaces.length,
      workspacesChanged,
      deltasEmitted,
      workspacesReconciled: workspaces.length,
      driftsDetected,
      staleEntriesRemoved: staleCleanup.staleEntriesRemoved,
      gitStatsComputed,
      durationMs,
    });

    return {
      workspacesScanned: workspaces.length,
      workspacesChanged,
      deltasEmitted,
      workspacesReconciled: workspaces.length,
      driftsDetected,
      staleEntriesRemoved: staleCleanup.staleEntriesRemoved,
      gitStatsComputed,
      durationMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Compatibility for transport integration fixtures that only require the
// read-only startup wait port. Runtime composition creates a fully injected
// SnapshotReconciliationService in app-context.ts.
export const snapshotReconciliationService = Object.freeze({
  waitForInProgress: () => Promise.resolve(),
});
