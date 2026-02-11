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
 * - Domain singletons from domain barrels (orchestration layer is allowed)
 * - Store from @/backend/services
 * - NOT re-exported from orchestration/index.ts (circular dep avoidance)
 */

import { isDeepStrictEqual } from 'node:util';
import pLimit from 'p-limit';
import { chatEventForwarderService, sessionService } from '@/backend/domains/session';
import {
  buildWorkspaceSessionSummaries,
  hasWorkingSessionSummary,
} from '@/backend/lib/session-summaries';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import {
  createLogger,
  type SnapshotUpdateInput,
  type WorkspaceSnapshotEntry,
  workspaceSnapshotStore,
} from '@/backend/services';
import { gitOpsService } from '@/backend/services/git-ops.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECONCILIATION_INTERVAL_MS = 60_000;
const GIT_CONCURRENCY = 3;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = createLogger('snapshot-reconciliation');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconciliationBridges {
  session: {
    getRuntimeSnapshot(sessionId: string): ReturnType<typeof sessionService.getRuntimeSnapshot>;
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

interface DriftEntry {
  field: string;
  group: string;
  snapshotValue: unknown;
  authoritativeValue: unknown;
}

// ---------------------------------------------------------------------------
// Drift detection (pure function, exported for testing)
// ---------------------------------------------------------------------------

const DRIFT_FIELD_GROUPS: { group: string; fields: string[] }[] = [
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
      const authValue = (authoritative as Record<string, unknown>)[field];
      if (authValue === undefined) {
        continue;
      }
      const snapValue = (existing as unknown as Record<string, unknown>)[field];
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

// ---------------------------------------------------------------------------
// Pending request type computation (replicated from workspace-query.service.ts)
// ---------------------------------------------------------------------------

function computePendingRequestType(
  sessionIds: string[],
  pendingRequests: Map<string, { toolName: string }>
): 'plan_approval' | 'user_question' | null {
  for (const sessionId of sessionIds) {
    const request = pendingRequests.get(sessionId);
    if (!request) {
      continue;
    }
    if (request.toolName === 'ExitPlanMode') {
      return 'plan_approval';
    }
    if (request.toolName === 'AskUserQuestion') {
      return 'user_question';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// SnapshotReconciliationService
// ---------------------------------------------------------------------------

export class SnapshotReconciliationService {
  private interval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private reconcileInProgress: Promise<ReconciliationResult> | null = null;
  private _bridges: ReconciliationBridges | null = null;

  private get bridges(): ReconciliationBridges {
    if (!this._bridges) {
      throw new Error('SnapshotReconciliationService not configured: call configure() first.');
    }
    return this._bridges;
  }

  configure(bridges: ReconciliationBridges): void {
    this._bridges = bridges;
  }

  start(): void {
    if (this.interval) {
      return; // Already started
    }
    this.isShuttingDown = false;

    // Run initial reconciliation immediately
    this.reconcileInProgress = this.reconcile()
      .catch((err) => {
        logger.error('Initial reconciliation failed', { error: String(err) });
        return {
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
          logger.error('Reconciliation tick failed', { error: String(err) });
          return {
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
   * Build authoritative snapshot fields for a single workspace.
   */
  private buildAuthoritativeFields(
    ws: Awaited<
      ReturnType<typeof workspaceAccessor.findAllNonArchivedWithSessionsAndProject>
    >[number],
    allPendingRequests: Map<string, { toolName: string }>,
    gitStatsMap: Map<
      string,
      { total: number; additions: number; deletions: number; hasUncommitted: boolean } | null
    >
  ): SnapshotUpdateInput {
    const sessionIds = [...(ws.claudeSessions?.map((s) => s.id) ?? [])];
    const sessionSummaries = buildWorkspaceSessionSummaries(ws.claudeSessions ?? [], (sessionId) =>
      this.bridges.session.getRuntimeSnapshot(sessionId)
    );
    const isWorking = hasWorkingSessionSummary(sessionSummaries);
    const pendingRequestType = computePendingRequestType(sessionIds, allPendingRequests);

    // Compute lastActivityAt from session timestamps
    const sessionDates = [
      ...(ws.claudeSessions?.map((s) => s.updatedAt) ?? []),
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
  private removeStaleEntries(dbWorkspaceIds: Set<string>): number {
    const storeWorkspaceIds = workspaceSnapshotStore.getAllWorkspaceIds();
    let removed = 0;

    for (const storeId of storeWorkspaceIds) {
      if (!dbWorkspaceIds.has(storeId)) {
        workspaceSnapshotStore.remove(storeId);
        removed++;
        logger.info('Removed stale snapshot entry', { workspaceId: storeId });
      }
    }

    return removed;
  }

  async reconcile(): Promise<ReconciliationResult> {
    const pollStartTs = Date.now();

    // 1. Fetch all non-archived workspaces from DB
    const workspaces = await workspaceAccessor.findAllNonArchivedWithSessionsAndProject();

    // 2. Get pending requests from bridges
    const allPendingRequests = this.bridges.session.getAllPendingRequests();

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
            const stats = await gitOpsService.getWorkspaceGitStats(ws.worktreePath, defaultBranch);
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
      const existing = workspaceSnapshotStore.getByWorkspaceId(ws.id);
      if (existing) {
        const drifts = detectDrift(existing, authoritativeFields);
        if (drifts.length > 0) {
          driftsDetected += drifts.length;
          logger.warn('Snapshot drift detected', {
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
      workspaceSnapshotStore.upsert(ws.id, authoritativeFields, 'reconciliation', pollStartTs);
    }

    // 5. Stale entry cleanup
    const staleEntriesRemoved = this.removeStaleEntries(new Set(workspaces.map((w) => w.id)));

    // 6. Log summary
    const durationMs = Date.now() - pollStartTs;
    logger.info('Reconciliation complete', {
      workspacesReconciled: workspaces.length,
      driftsDetected,
      staleEntriesRemoved,
      gitStatsComputed,
      durationMs,
    });

    return {
      workspacesReconciled: workspaces.length,
      driftsDetected,
      staleEntriesRemoved,
      gitStatsComputed,
      durationMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton + configure function
// ---------------------------------------------------------------------------

export const snapshotReconciliationService = new SnapshotReconciliationService();

/**
 * Configure and start the snapshot reconciliation service.
 * Must be called AFTER configureDomainBridges() in server startup.
 */
export function configureSnapshotReconciliation(): void {
  snapshotReconciliationService.configure({
    session: {
      getRuntimeSnapshot: (sessionId) => sessionService.getRuntimeSnapshot(sessionId),
      getAllPendingRequests: () => chatEventForwarderService.getAllPendingRequests(),
    },
  });
  snapshotReconciliationService.start();
}
