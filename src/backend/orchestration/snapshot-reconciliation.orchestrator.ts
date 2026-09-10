/**
 * Snapshot Reconciliation Orchestrator
 *
 * Periodically recomputes workspace snapshots from authoritative DB and git
 * sources. This is the safety net that catches any events missed by the
 * event-driven pipeline (Phase 12-13), seeds the snapshot store on startup,
 * and is the only path for expensive git stats computation.
 *
 * Key behaviors:
 * - RCNL-02: Git stats computed with bounded p-limit concurrency
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
import { SERVICE_INTERVAL_MS } from '@/backend/services/constants';
import {
  type JobRunner,
  jobRunner as sharedJobRunner,
} from '@/backend/services/job-runner.service';
import type { createLogger } from '@/backend/services/logger.service';
import type { sessionLifecycleService } from '@/backend/services/session';
import {
  computePendingRequestType,
  type gitOpsService,
  type SnapshotUpdateInput,
  sessionSummariesEqual,
  type WorkspaceSnapshotEntry,
  type workspaceMaintenanceService,
  type workspaceSnapshotStore,
} from '@/backend/services/workspace';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GIT_CONCURRENCY = 10;

/** Job name this service registers with the shared runner. */
const SNAPSHOT_RECONCILIATION_JOB = 'snapshot-reconciliation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconciliationBridges {
  session: {
    getRuntimeSnapshot(
      sessionId: string
    ): ReturnType<typeof sessionLifecycleService.getRuntimeSnapshot>;
    getAllPendingRequests(): Map<string, { toolName: string; input?: Record<string, unknown> }>;
  };
}

export interface SnapshotReconciliationDependencies extends ReconciliationBridges {
  createLogger(
    component: string
  ): Pick<ReturnType<typeof createLogger>, 'debug' | 'error' | 'info' | 'warn'>;
  gitOpsService: Pick<typeof gitOpsService, 'getWorkspaceGitStats'>;
  workspaceMaintenanceService: Pick<
    typeof workspaceMaintenanceService,
    'findActiveWithSessionsAndProject'
  >;
  workspaceSnapshotStore: Pick<
    typeof workspaceSnapshotStore,
    'getAllWorkspaceIds' | 'getByWorkspaceId' | 'remove' | 'upsert'
  >;
  /**
   * Defaults to the process-wide runner. Injected so a test can drive this
   * service's loop without touching the jobs the rest of the app registered.
   */
  jobRunner?: JobRunner;
}

export interface ReconciliationResult {
  workspacesScanned: number;
  workspacesChanged: number;
  deltasEmitted: number;
  workspacesReconciled: number;
  workspacesSkipped: number;
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
  | 'ratchetDispatchOutcome'
  | 'ratchetDispatchRetryCount'
  | 'runScriptStatus'
  | 'isWorking'
  | 'pendingRequestType'
  | 'sessionSummaries';

const DRIFT_FIELD_GROUPS: { group: string; fields: DriftComparableField[] }[] = [
  { group: 'workspace', fields: ['status', 'name', 'branchName'] },
  { group: 'pr', fields: ['prState', 'prCiStatus', 'prNumber'] },
  {
    group: 'ratchet',
    fields: [
      'ratchetEnabled',
      'ratchetState',
      'ratchetDispatchOutcome',
      'ratchetDispatchRetryCount',
    ],
  },
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
      const valuesEqual =
        field === 'sessionSummaries'
          ? authoritative.sessionSummaries !== undefined &&
            sessionSummariesEqual(authoritative.sessionSummaries, existing.sessionSummaries)
          : isDeepStrictEqual(authValue, snapValue);
      if (!valuesEqual) {
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
  private readonly jobRunner: JobRunner;
  private seedInProgress: Promise<void> | null = null;

  constructor(private readonly dependencies: Readonly<SnapshotReconciliationDependencies>) {
    this.logger = dependencies.createLogger('snapshot-reconciliation');
    this.jobRunner = dependencies.jobRunner ?? sharedJobRunner;
    this.jobRunner.register({
      name: SNAPSHOT_RECONCILIATION_JOB,
      intervalMs: SERVICE_INTERVAL_MS.snapshotReconciliation,
      // Seeds the snapshot store; the /snapshots handler waits on the seed phase.
      runImmediately: true,
      run: () => this.reconcile(),
    });
  }

  start(): void {
    this.jobRunner.start(SNAPSHOT_RECONCILIATION_JOB);
  }

  async stop(): Promise<void> {
    await this.jobRunner.stop(SNAPSHOT_RECONCILIATION_JOB);
  }

  /**
   * Wait for the database/runtime seed phase of the active reconciliation.
   * Git stats continue streaming after this resolves.
   */
  waitForSeed(): Promise<void> {
    return this.seedInProgress ?? Promise.resolve();
  }

  /**
   * Build authoritative snapshot fields for a single workspace.
   */
  private buildAuthoritativeFields(
    ws: Awaited<
      ReturnType<
        SnapshotReconciliationDependencies['workspaceMaintenanceService']['findActiveWithSessionsAndProject']
      >
    >[number],
    allPendingRequests: Map<string, { toolName: string; input?: Record<string, unknown> }>
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
      mode: ws.mode,
      autoIterationStatus: ws.autoIterationStatus,
      prUrl: ws.prUrl,
      prNumber: ws.prNumber,
      prState: ws.prState,
      prCiStatus: ws.prCiStatus,
      prUpdatedAt: ws.prUpdatedAt?.toISOString() ?? null,
      hasMergeConflict: ws.prHasMergeConflict,
      ratchetEnabled: ws.ratchetEnabled,
      ratchetState: ws.ratchetState,
      ratchetDispatchOutcome: ws.ratchetDispatchOutcome,
      ratchetDispatchRetryCount: ws.ratchetDispatchRetryCount,
      ratchetDispatchStalled: ws.ratchetDispatchStalled,
      runScriptStatus: ws.runScriptStatus,
      isWorking,
      pendingRequestType,
      sessionSummaries,
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
    let resolveSeed!: () => void;
    const seedInProgress = new Promise<void>((resolve) => {
      resolveSeed = resolve;
    });
    this.seedInProgress = seedInProgress;

    try {
      // 1. Fetch all non-archived workspaces from DB
      const workspaces =
        await this.dependencies.workspaceMaintenanceService.findActiveWithSessionsAndProject();

      // 2. Get pending requests from bridges
      const allPendingRequests = this.dependencies.session.getAllPendingRequests();

      let driftsDetected = 0;
      let deltasEmitted = 0;
      let staleEntriesRemoved = 0;
      let gitStatsComputed = 0;
      const changedWorkspaceIds = new Set<string>();
      const failedWorkspaceIds = new Set<string>();

      const recordUpsert = (
        workspaceId: string,
        result: { changed: boolean; emitted: boolean }
      ) => {
        if (result.changed) {
          changedWorkspaceIds.add(workspaceId);
        }
        if (result.emitted) {
          deltasEmitted++;
        }
      };

      // 3. Seed DB and runtime fields without waiting for git. Omitting gitStats
      // preserves an existing cached value until this pass computes a replacement.
      for (const ws of workspaces) {
        let authoritativeFields: SnapshotUpdateInput;
        try {
          authoritativeFields = this.buildAuthoritativeFields(ws, allPendingRequests);
        } catch (error) {
          failedWorkspaceIds.add(ws.id);
          this.logger.warn('Failed to build authoritative fields for workspace', {
            workspaceId: ws.id,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (!ws.worktreePath) {
          authoritativeFields.gitStats = null;
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

        recordUpsert(
          ws.id,
          this.dependencies.workspaceSnapshotStore.upsert(
            ws.id,
            authoritativeFields,
            'reconciliation',
            pollStartTs
          )
        );
      }

      // Stale entries are part of the authoritative seed and must be removed
      // before a client receives its initial snapshot_full baseline.
      const staleCleanup = this.removeStaleEntries(new Set(workspaces.map((w) => w.id)));
      staleEntriesRemoved = staleCleanup.staleEntriesRemoved;
      deltasEmitted += staleCleanup.deltasEmitted;
      resolveSeed();

      // 4. Compute and publish git stats independently with bounded concurrency.
      const gitLimit = pLimit(GIT_CONCURRENCY);
      await Promise.all(
        workspaces.map((ws) => {
          const worktreePath = ws.worktreePath;
          if (!worktreePath || failedWorkspaceIds.has(ws.id)) {
            return Promise.resolve();
          }
          return gitLimit(async () => {
            const defaultBranch = ws.project?.defaultBranch ?? 'main';
            let gitStats: Awaited<
              ReturnType<
                SnapshotReconciliationDependencies['gitOpsService']['getWorkspaceGitStats']
              >
            > | null = null;
            try {
              gitStats = await this.dependencies.gitOpsService.getWorkspaceGitStats(
                worktreePath,
                defaultBranch
              );
            } catch {
              gitStats = null;
            }
            const cachedGitStats = this.dependencies.workspaceSnapshotStore.getByWorkspaceId(
              ws.id
            )?.gitStats;
            if (gitStats === null && cachedGitStats != null) {
              return;
            }
            if (gitStats) {
              gitStatsComputed++;
            }
            recordUpsert(
              ws.id,
              this.dependencies.workspaceSnapshotStore.upsert(
                ws.id,
                { gitStats },
                'reconciliation',
                pollStartTs
              )
            );
          });
        })
      );

      // 5. Log summary after every streamed git update has settled.
      const durationMs = Date.now() - pollStartTs;
      const workspacesChanged = changedWorkspaceIds.size;
      const workspacesSkipped = failedWorkspaceIds.size;
      const workspacesReconciled = workspaces.length - workspacesSkipped;
      this.logger.info('Reconciliation complete', {
        workspacesScanned: workspaces.length,
        workspacesChanged,
        deltasEmitted,
        workspacesReconciled,
        workspacesSkipped,
        driftsDetected,
        staleEntriesRemoved,
        gitStatsComputed,
        durationMs,
      });

      return {
        workspacesScanned: workspaces.length,
        workspacesChanged,
        deltasEmitted,
        workspacesReconciled,
        workspacesSkipped,
        driftsDetected,
        staleEntriesRemoved,
        gitStatsComputed,
        durationMs,
      };
    } finally {
      resolveSeed();
      if (this.seedInProgress === seedInProgress) {
        this.seedInProgress = null;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Compatibility for transport integration fixtures that only require the
// read-only startup wait port. Runtime composition creates a fully injected
// SnapshotReconciliationService in app-context.ts.
export const snapshotReconciliationService = Object.freeze({
  waitForSeed: () => Promise.resolve(),
});
