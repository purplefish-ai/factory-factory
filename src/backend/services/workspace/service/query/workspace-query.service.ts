import pLimit from 'p-limit';
import { toError } from '@/backend/lib/error-utils';
import { buildWorkspaceSessionSummaries } from '@/backend/lib/session-summaries';
import { assembleWorkspaceDerivedState } from '@/backend/lib/workspace-derived-state';
import { createLogger } from '@/backend/services/logger.service';
import { projectAccessor } from '@/backend/services/workspace/resources/project.accessor';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import { workspacePrAccessor } from '@/backend/services/workspace/resources/workspace-pr.accessor';
import type {
  WorkspaceGitHubBridge,
  WorkspacePRSnapshotBridge,
  WorkspaceQuerySessionBridge,
} from '@/backend/services/workspace/service/bridges';
import { computeKanbanColumn } from '@/backend/services/workspace/service/state/kanban-state';
import { computePendingRequestType } from '@/backend/services/workspace/service/state/pending-request-type';
import { deriveWorkspaceRuntimeState } from '@/backend/services/workspace/service/state/workspace-runtime-state';
import { gitOpsService } from '@/backend/services/workspace/service/worktree/git-ops.service';
import { type KanbanColumn, WorkspaceStatus } from '@/shared/core';
import {
  findWorkspaceSessionRuntimeError,
  hasWorkingSessionSummary,
} from '@/shared/session-runtime';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';

const logger = createLogger('workspace-query');

// Limit concurrent git operations to prevent resource exhaustion.
const DEFAULT_GIT_CONCURRENCY = 3;
const gitConcurrencyLimit = pLimit(DEFAULT_GIT_CONCURRENCY);

// Cache TTL for GitHub review requests (expensive API call)
const REVIEW_CACHE_TTL_MS = 60_000; // 1 minute cache

export interface WorkspaceGitStats {
  total: number;
  additions: number;
  deletions: number;
  hasUncommitted: boolean;
}

/** Most recent update across a workspace's agent and terminal sessions. */
function deriveLastActivityAt(workspace: {
  agentSessions?: Array<{ updatedAt: Date }> | null;
  terminalSessions?: Array<{ updatedAt: Date }> | null;
}): string | null {
  const sessionDates = [
    ...(workspace.agentSessions?.map((session) => session.updatedAt) ?? []),
    ...(workspace.terminalSessions?.map((session) => session.updatedAt) ?? []),
  ].filter(Boolean);

  if (sessionDates.length === 0) {
    return null;
  }

  return sessionDates.reduce((latest, date) => (date > latest ? date : latest)).toISOString();
}

class WorkspaceQueryService {
  /** Cached GitHub review count (DOM-04: moved from module scope to instance field) */
  private cachedReviewCount: { count: number; fetchedAt: number } | null = null;
  private reviewCountRefreshPromise: Promise<number> | null = null;
  private readonly prStatusSyncProjectsInFlight = new Set<string>();

  private sessionBridge: WorkspaceQuerySessionBridge | null = null;
  private githubBridge: WorkspaceGitHubBridge | null = null;
  private prSnapshotBridge: WorkspacePRSnapshotBridge | null = null;

  configure(bridges: {
    session: WorkspaceQuerySessionBridge;
    github: WorkspaceGitHubBridge;
    prSnapshot: WorkspacePRSnapshotBridge;
  }): void {
    this.sessionBridge = bridges.session;
    this.githubBridge = bridges.github;
    this.prSnapshotBridge = bridges.prSnapshot;
  }

  private get session(): WorkspaceQuerySessionBridge {
    if (!this.sessionBridge) {
      throw new Error(
        'WorkspaceQueryService not configured: session bridge missing. Call configure() first.'
      );
    }
    return this.sessionBridge;
  }

  private get github(): WorkspaceGitHubBridge {
    if (!this.githubBridge) {
      throw new Error(
        'WorkspaceQueryService not configured: github bridge missing. Call configure() first.'
      );
    }
    return this.githubBridge;
  }

  private get prSnapshot(): WorkspacePRSnapshotBridge {
    if (!this.prSnapshotBridge) {
      throw new Error(
        'WorkspaceQueryService not configured: prSnapshot bridge missing. Call configure() first.'
      );
    }
    return this.prSnapshotBridge;
  }

  refreshReviewCount(): Promise<number> {
    if (this.reviewCountRefreshPromise !== null) {
      return this.reviewCountRefreshPromise;
    }

    const refreshPromise = Promise.resolve()
      .then(() => this.github.checkHealth())
      .then(async (health) => {
        if (!(health.isInstalled && health.isAuthenticated)) {
          return this.cachedReviewCount?.count ?? 0;
        }

        const prs = await this.github.listReviewRequests();
        const count = prs.filter((pr) => pr.reviewDecision !== 'APPROVED').length;
        this.cachedReviewCount = {
          count,
          fetchedAt: Date.now(),
        };
        return count;
      })
      .catch((error) => {
        logger.debug('Failed to fetch review count', {
          error: error instanceof Error ? error.message : String(error),
        });
        return this.cachedReviewCount?.count ?? 0;
      })
      .finally(() => {
        this.reviewCountRefreshPromise = null;
      });

    this.reviewCountRefreshPromise = refreshPromise;
    return refreshPromise;
  }

  getCachedReviewCount(): number | undefined {
    return this.cachedReviewCount?.count;
  }

  refreshReviewCountIfStale(): void {
    const now = Date.now();
    const isStale =
      !this.cachedReviewCount || now - this.cachedReviewCount.fetchedAt >= REVIEW_CACHE_TTL_MS;
    if (isStale) {
      void this.refreshReviewCount();
    }
  }

  /**
   * Load a project's live workspaces together with everything derived from
   * them, newest first.
   *
   * One accessor call and one derivation pass behind every project-scoped
   * list. The sidebar and the board each used to run their own copy of this
   * over the same rows, which paid for the query twice on every project view
   * and left two places for the derived state to drift apart.
   */
  private async deriveProjectWorkspaces(projectId: string) {
    const workspaces = await workspaceAccessor.findByProjectIdWithSessions(projectId, {
      excludeStatuses: [WorkspaceStatus.ARCHIVING, WorkspaceStatus.ARCHIVED],
    });

    // Get all pending requests from active sessions
    const allPendingRequests = this.session.getAllPendingRequests();

    return workspaces
      .map((workspace) => {
        // `hasWorkingSessionSummary` is the predicate the snapshot store and
        // reconciliation use. A narrower signal here (prompt-in-flight alone,
        // say) would make this query and the live snapshot stream disagree
        // about a session that is alive between prompts.
        const sessionSummaries = buildWorkspaceSessionSummaries(
          workspace.agentSessions ?? [],
          (sessionId) => this.session.getRuntimeSnapshot(sessionId)
        );
        const runtimeState = deriveWorkspaceRuntimeState(workspace, () =>
          hasWorkingSessionSummary(sessionSummaries)
        );
        const pendingRequestType = computePendingRequestType(
          runtimeState.sessionIds,
          allPendingRequests
        );
        const derivedState = assembleWorkspaceDerivedState(
          {
            lifecycle: workspace.status,
            prUrl: workspace.prUrl,
            prState: workspace.prState,
            prCiStatus: workspace.prCiStatus,
            ratchetState: workspace.ratchetState,
            hasHadSessions: workspace.hasHadSessions,
            sessionIsWorking: runtimeState.isSessionWorking,
            pendingRequestType,
            hasSessionRuntimeError: Boolean(findWorkspaceSessionRuntimeError(sessionSummaries)),
            ratchetDispatchOutcome: workspace.ratchetDispatchOutcome,
            ratchetDispatchRetryCount: workspace.ratchetDispatchRetryCount,
            runScriptStatus: workspace.runScriptStatus,
            flowState: runtimeState.flowState,
          },
          {
            computeKanbanColumn,
            deriveSidebarStatus: deriveWorkspaceSidebarStatus,
          }
        );

        return { workspace, sessionSummaries, pendingRequestType, derivedState };
      })
      .sort((a, b) => b.workspace.createdAt.getTime() - a.workspace.createdAt.getTime());
  }

  private async loadGitStats(
    workspaces: Array<{ id: string; worktreePath: string | null }>,
    defaultBranch: string
  ): Promise<Record<string, WorkspaceGitStats | null>> {
    const gitStatsResults: Record<string, WorkspaceGitStats | null> = {};

    await Promise.all(
      workspaces.map((workspace) =>
        gitConcurrencyLimit(async () => {
          if (!workspace.worktreePath) {
            gitStatsResults[workspace.id] = null;
            return;
          }
          try {
            gitStatsResults[workspace.id] = await gitOpsService.getWorkspaceGitStats(
              workspace.worktreePath,
              defaultBranch
            );
          } catch (error) {
            logger.debug('Failed to get git stats for workspace', {
              workspaceId: workspace.id,
              error: error instanceof Error ? error.message : String(error),
            });
            gitStatsResults[workspace.id] = null;
          }
        })
      )
    );

    return gitStatsResults;
  }

  /**
   * The single project-scoped workspace list, shared by the sidebar and the
   * Kanban board.
   *
   * Returns one row per live workspace carrying the union of what those
   * surfaces render; each picks its own fields client-side. In particular the
   * list is not pre-filtered by Kanban column — `kanbanColumn` is null for a
   * workspace the board excludes, and the board filters on it — so both
   * surfaces stay views of the same array instead of separate fetches that can
   * disagree.
   */
  async listForProject(projectId: string) {
    const [project, derived] = await Promise.all([
      projectAccessor.findById(projectId),
      this.deriveProjectWorkspaces(projectId),
    ]);

    const gitStatsByWorkspace = await this.loadGitStats(
      derived.map(({ workspace }) => workspace),
      project?.defaultBranch ?? 'main'
    );

    // Stale-while-revalidate: return cached count immediately, refresh in background if stale.
    const reviewCount = this.getCachedReviewCount() ?? 0;
    this.refreshReviewCountIfStale();

    return {
      workspaces: derived.map(
        ({ workspace: w, sessionSummaries, pendingRequestType, derivedState }) => ({
          id: w.id,
          projectId: w.projectId,
          name: w.name,
          status: w.status,
          createdAt: w.createdAt,
          branchName: w.branchName,
          initErrorMessage: w.initErrorMessage,
          mode: w.mode,
          autoIterationStatus: w.autoIterationStatus,
          autoIterationConfig: w.autoIterationConfig,
          autoIterationProgress: w.autoIterationProgress,
          prUrl: w.prUrl,
          prNumber: w.prNumber,
          prState: w.prState,
          prCiStatus: w.prCiStatus,
          ratchetEnabled: w.ratchetEnabled,
          ratchetState: w.ratchetState,
          runScriptStatus: w.runScriptStatus,
          githubIssueNumber: w.githubIssueNumber,
          githubIssueUrl: w.githubIssueUrl,
          linearIssueId: w.linearIssueId,
          linearIssueIdentifier: w.linearIssueIdentifier,
          linearIssueUrl: w.linearIssueUrl,
          creationSource: w.creationSource,
          sessionSummaries,
          pendingRequestType,
          gitStats: gitStatsByWorkspace[w.id] ?? null,
          lastActivityAt: deriveLastActivityAt(w),
          isWorking: derivedState.isWorking,
          kanbanColumn: derivedState.kanbanColumn,
          sidebarStatus: derivedState.sidebarStatus,
          ratchetButtonAnimated: derivedState.ratchetButtonAnimated,
          flowPhase: derivedState.flowPhase,
          ciObservation: derivedState.ciObservation,
          statusReason: derivedState.statusReason,
        })
      ),
      reviewCount,
    };
  }

  /**
   * Workspace ids whose live Kanban column is `kanbanColumn`, for column-wide
   * actions.
   *
   * The column depends on session state the database cannot see, so this
   * derives it rather than filtering in SQL.
   */
  async findWorkspaceIdsInKanbanColumn(
    projectId: string,
    kanbanColumn: KanbanColumn
  ): Promise<string[]> {
    const derived = await this.deriveProjectWorkspaces(projectId);
    return derived
      .filter(({ derivedState }) => derivedState.kanbanColumn === kanbanColumn)
      .map(({ workspace }) => workspace.id);
  }

  async syncPRStatus(workspaceId: string) {
    const workspace = await workspaceAccessor.findById(workspaceId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    if (!workspace.prUrl) {
      await workspacePrAccessor.resetDiscoveryBackoff(workspaceId);
      return { success: false, reason: 'no_pr_url' as const };
    }

    const previousPrState = workspace.prState;
    const prResult = await this.prSnapshot.refreshWorkspace(workspaceId, workspace.prUrl);
    if (!(prResult.success && prResult.snapshot)) {
      return { success: false, reason: 'fetch_failed' as const };
    }

    logger.info('PR status synced manually', {
      workspaceId,
      prNumber: prResult.snapshot.prNumber,
      prState: prResult.snapshot.prState,
    });

    return { success: true, prState: prResult.snapshot.prState, previousPrState };
  }

  async syncAllPRStatuses(projectId: string) {
    if (this.prStatusSyncProjectsInFlight.has(projectId)) {
      logger.info('Batch PR status sync already in flight for project, skipping', { projectId });
      return { queued: 0 };
    }

    this.prStatusSyncProjectsInFlight.add(projectId);

    try {
      const workspaces = await workspaceAccessor.findByProjectIdWithSessions(projectId, {
        excludeStatuses: [WorkspaceStatus.ARCHIVING, WorkspaceStatus.ARCHIVED],
      });

      const workspacesWithPRs = workspaces.filter(
        (w): w is typeof w & { prUrl: string } => w.prUrl !== null
      );

      if (workspacesWithPRs.length === 0) {
        this.prStatusSyncProjectsInFlight.delete(projectId);
        return { queued: 0 };
      }

      // Fire-and-forget: results are pushed to clients via WebSocket as each call completes.
      Promise.all(
        workspacesWithPRs.map((workspace) =>
          gitConcurrencyLimit(() => this.prSnapshot.refreshWorkspace(workspace.id, workspace.prUrl))
        )
      )
        .then(() => logger.info('Batch PR status sync completed', { projectId }))
        .catch((err) => logger.error('Batch PR status sync failed', toError(err), { projectId }))
        .finally(() => {
          this.prStatusSyncProjectsInFlight.delete(projectId);
        });

      return { queued: workspacesWithPRs.length };
    } catch (error) {
      this.prStatusSyncProjectsInFlight.delete(projectId);
      throw error;
    }
  }

  async hasChanges(workspaceId: string): Promise<boolean> {
    const workspace = await workspaceAccessor.findByIdWithProject(workspaceId);
    if (!(workspace?.worktreePath && workspace.project)) {
      return false;
    }

    try {
      const stats = await gitOpsService.getWorkspaceGitStats(
        workspace.worktreePath,
        workspace.project.defaultBranch ?? 'main'
      );
      return stats !== null && (stats.total > 0 || stats.hasUncommitted);
    } catch {
      return false;
    }
  }
}

export const workspaceQueryService = new WorkspaceQueryService();
