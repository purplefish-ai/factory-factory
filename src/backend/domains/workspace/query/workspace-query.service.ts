import pLimit from 'p-limit';
import type {
  WorkspaceGitHubBridge,
  WorkspacePRSnapshotBridge,
  WorkspaceSessionBridge,
} from '@/backend/domains/workspace/bridges';
import { computeKanbanColumn } from '@/backend/domains/workspace/state/kanban-state';
import { computePendingRequestType } from '@/backend/domains/workspace/state/pending-request-type';
import { deriveWorkspaceRuntimeState } from '@/backend/domains/workspace/state/workspace-runtime-state';
import { projectAccessor } from '@/backend/resource_accessors/project.accessor';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import { FactoryConfigService } from '@/backend/services/factory-config.service';
import { gitOpsService } from '@/backend/services/git-ops.service';
import { createLogger } from '@/backend/services/logger.service';
import { type KanbanColumn, WorkspaceStatus } from '@/shared/core';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';

const logger = createLogger('workspace-query');

// Limit concurrent git operations to prevent resource exhaustion.
const DEFAULT_GIT_CONCURRENCY = 3;
const gitConcurrencyLimit = pLimit(DEFAULT_GIT_CONCURRENCY);

// Cache TTL for GitHub review requests (expensive API call)
const REVIEW_CACHE_TTL_MS = 60_000; // 1 minute cache

class WorkspaceQueryService {
  /** Cached GitHub review count (DOM-04: moved from module scope to instance field) */
  private cachedReviewCount: { count: number; fetchedAt: number } | null = null;

  private sessionBridge: WorkspaceSessionBridge | null = null;
  private githubBridge: WorkspaceGitHubBridge | null = null;
  private prSnapshotBridge: WorkspacePRSnapshotBridge | null = null;

  configure(bridges: {
    session: WorkspaceSessionBridge;
    github: WorkspaceGitHubBridge;
    prSnapshot: WorkspacePRSnapshotBridge;
  }): void {
    this.sessionBridge = bridges.session;
    this.githubBridge = bridges.github;
    this.prSnapshotBridge = bridges.prSnapshot;
  }

  private get session(): WorkspaceSessionBridge {
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

  async getProjectSummaryState(projectId: string) {
    const [project, workspaces] = await Promise.all([
      projectAccessor.findById(projectId),
      workspaceAccessor.findByProjectIdWithSessions(projectId, {
        excludeStatuses: [WorkspaceStatus.ARCHIVED],
      }),
    ]);

    const defaultBranch = project?.defaultBranch ?? 'main';

    // Get all pending requests from active sessions
    const allPendingRequests = this.session.getAllPendingRequests();

    const workingStatusByWorkspace = new Map<string, boolean>();
    const flowStateByWorkspace = new Map<
      string,
      ReturnType<typeof deriveWorkspaceRuntimeState>['flowState']
    >();
    const pendingRequestByWorkspace = new Map<
      string,
      'plan_approval' | 'user_question' | 'permission_request' | null
    >();
    for (const workspace of workspaces) {
      const runtimeState = deriveWorkspaceRuntimeState(workspace, (sessionIds) =>
        this.session.isAnySessionWorking(sessionIds)
      );
      const flowState = runtimeState.flowState;
      flowStateByWorkspace.set(workspace.id, flowState);

      workingStatusByWorkspace.set(workspace.id, runtimeState.isWorking);

      const pendingRequestType = computePendingRequestType(
        runtimeState.sessionIds,
        allPendingRequests
      );
      pendingRequestByWorkspace.set(workspace.id, pendingRequestType);
    }

    const gitStatsResults: Record<
      string,
      { total: number; additions: number; deletions: number; hasUncommitted: boolean } | null
    > = {};

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

    let reviewCount = 0;
    const now = Date.now();
    if (this.cachedReviewCount && now - this.cachedReviewCount.fetchedAt < REVIEW_CACHE_TTL_MS) {
      reviewCount = this.cachedReviewCount.count;
    } else {
      try {
        const health = await this.github.checkHealth();
        if (health.isInstalled && health.isAuthenticated) {
          const prs = await this.github.listReviewRequests();
          reviewCount = prs.filter((pr) => pr.reviewDecision !== 'APPROVED').length;
          this.cachedReviewCount = { count: reviewCount, fetchedAt: now };
        }
      } catch (error) {
        logger.debug('Failed to fetch review count', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      workspaces: workspaces.map((w) => {
        const flowState = flowStateByWorkspace.get(w.id);
        const sessionDates = [
          ...(w.agentSessions?.map((s) => s.updatedAt) ?? []),
          ...(w.terminalSessions?.map((s) => s.updatedAt) ?? []),
        ].filter(Boolean) as Date[];
        const lastActivityAt =
          sessionDates.length > 0
            ? sessionDates.reduce((latest, d) => (d > latest ? d : latest)).toISOString()
            : null;

        return {
          id: w.id,
          name: w.name,
          createdAt: w.createdAt,
          branchName: w.branchName,
          prUrl: w.prUrl,
          prNumber: w.prNumber,
          prState: w.prState,
          prCiStatus: w.prCiStatus,
          isWorking: workingStatusByWorkspace.get(w.id) ?? false,
          gitStats: gitStatsResults[w.id] ?? null,
          lastActivityAt,
          ratchetEnabled: w.ratchetEnabled,
          ratchetState: w.ratchetState,
          sidebarStatus: deriveWorkspaceSidebarStatus({
            isWorking: workingStatusByWorkspace.get(w.id) ?? false,
            prUrl: w.prUrl,
            prState: w.prState,
            prCiStatus: w.prCiStatus,
            ratchetState: w.ratchetState,
          }),
          ratchetButtonAnimated: flowState?.shouldAnimateRatchetButton ?? false,
          flowPhase: flowState?.phase ?? 'NO_PR',
          ciObservation: flowState?.ciObservation ?? 'CHECKS_UNKNOWN',
          runScriptStatus: w.runScriptStatus,
          cachedKanbanColumn: w.cachedKanbanColumn,
          stateComputedAt: w.stateComputedAt?.toISOString() ?? null,
          pendingRequestType: pendingRequestByWorkspace.get(w.id) ?? null,
        };
      }),
      reviewCount,
    };
  }

  async listWithKanbanState(input: {
    projectId: string;
    status?: WorkspaceStatus;
    kanbanColumn?: KanbanColumn;
    limit?: number;
    offset?: number;
  }) {
    const { projectId, ...filters } = input;

    const workspaces = await workspaceAccessor.findByProjectIdWithSessions(projectId, {
      ...filters,
      excludeStatuses: [WorkspaceStatus.ARCHIVED],
    });

    // Get all pending requests from active sessions
    const allPendingRequests = this.session.getAllPendingRequests();

    return workspaces
      .map((workspace) => {
        const runtimeState = deriveWorkspaceRuntimeState(workspace, (sessionIds) =>
          this.session.isAnySessionWorking(sessionIds)
        );

        const kanbanColumn = computeKanbanColumn({
          lifecycle: workspace.status,
          isWorking: runtimeState.isWorking,
          prState: workspace.prState,
          hasHadSessions: workspace.hasHadSessions,
        });

        const pendingRequestType = computePendingRequestType(
          runtimeState.sessionIds,
          allPendingRequests
        );

        return {
          ...workspace,
          kanbanColumn,
          isWorking: runtimeState.isWorking,
          ratchetButtonAnimated: runtimeState.flowState.shouldAnimateRatchetButton,
          flowPhase: runtimeState.flowState.phase,
          ciObservation: runtimeState.flowState.ciObservation,
          isArchived: false,
          pendingRequestType,
        };
      })
      .filter((workspace) => {
        // Filter out workspaces with null kanbanColumn (hidden: READY + no sessions)
        return workspace.kanbanColumn !== null;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async listWithRuntimeState(input: {
    projectId: string;
    status?: WorkspaceStatus;
    limit?: number;
    offset?: number;
  }) {
    const { projectId, ...filters } = input;

    const workspaces = await workspaceAccessor.findByProjectIdWithSessions(projectId, filters);

    // Get all pending requests from active sessions
    const allPendingRequests = this.session.getAllPendingRequests();

    return workspaces.map((workspace) => {
      const runtimeState = deriveWorkspaceRuntimeState(workspace, (sessionIds) =>
        this.session.isAnySessionWorking(sessionIds)
      );

      const pendingRequestType = computePendingRequestType(
        runtimeState.sessionIds,
        allPendingRequests
      );

      return {
        ...workspace,
        isWorking: runtimeState.isWorking,
        pendingRequestType,
      };
    });
  }

  async refreshFactoryConfigs(projectId: string) {
    const workspaces = await workspaceAccessor.findByProjectId(projectId);

    let updatedCount = 0;
    const errors: Array<{ workspaceId: string; error: string }> = [];

    for (const workspace of workspaces) {
      if (!workspace.worktreePath) {
        continue;
      }

      try {
        const factoryConfig = await FactoryConfigService.readConfig(workspace.worktreePath);

        await workspaceAccessor.update(workspace.id, {
          runScriptCommand: factoryConfig?.scripts.run ?? null,
          runScriptCleanupCommand: factoryConfig?.scripts.cleanup ?? null,
        });

        updatedCount++;
      } catch (error) {
        errors.push({
          workspaceId: workspace.id,
          error: error instanceof Error ? error.message : String(error),
        });
        logger.error('Failed to refresh factory config for workspace', {
          workspaceId: workspace.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      updatedCount,
      totalWorkspaces: workspaces.length,
      errors,
    };
  }

  async getFactoryConfig(projectId: string) {
    const project = await projectAccessor.findById(projectId);
    if (!project) {
      throw new Error('Project not found');
    }

    try {
      const config = await FactoryConfigService.readConfig(project.repoPath);
      return config;
    } catch (error) {
      logger.error('Failed to read factory config', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async syncPRStatus(workspaceId: string) {
    const workspace = await workspaceAccessor.findById(workspaceId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    if (!workspace.prUrl) {
      return { success: false, reason: 'no_pr_url' as const };
    }

    const prResult = await this.prSnapshot.refreshWorkspace(workspaceId, workspace.prUrl);
    if (!(prResult.success && prResult.snapshot)) {
      return { success: false, reason: 'fetch_failed' as const };
    }

    logger.info('PR status synced manually', {
      workspaceId,
      prNumber: prResult.snapshot.prNumber,
      prState: prResult.snapshot.prState,
    });

    return { success: true, prState: prResult.snapshot.prState };
  }

  async syncAllPRStatuses(projectId: string) {
    const workspaces = await workspaceAccessor.findByProjectIdWithSessions(projectId, {
      excludeStatuses: [WorkspaceStatus.ARCHIVED],
    });

    const workspacesWithPRs = workspaces.filter(
      (w): w is typeof w & { prUrl: string } => w.prUrl !== null
    );

    if (workspacesWithPRs.length === 0) {
      return { synced: 0, failed: 0 };
    }

    let synced = 0;
    let failed = 0;

    await Promise.all(
      workspacesWithPRs.map((workspace) =>
        gitConcurrencyLimit(async () => {
          const prResult = await this.prSnapshot.refreshWorkspace(workspace.id, workspace.prUrl);
          if (!prResult.success) {
            failed++;
            return;
          }
          synced++;
        })
      )
    );

    logger.info('Batch PR status sync completed', { projectId, synced, failed });

    return { synced, failed };
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
