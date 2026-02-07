import { type KanbanColumn, WorkspaceStatus } from '@prisma-gen/client';
import pLimit from 'p-limit';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';
import { projectAccessor } from '../resource_accessors/project.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { chatEventForwarderService } from './chat-event-forwarder.service';
import { FactoryConfigService } from './factory-config.service';
import { gitOpsService } from './git-ops.service';
import { githubCLIService } from './github-cli.service';
import { computeKanbanColumn } from './kanban-state.service';
import { createLogger } from './logger.service';
import { prSnapshotService } from './pr-snapshot.service';
import { sessionService } from './session.service';
import { deriveWorkspaceFlowStateFromWorkspace } from './workspace-flow-state.service';

const logger = createLogger('workspace-query');

// Limit concurrent git operations to prevent resource exhaustion.
const DEFAULT_GIT_CONCURRENCY = 3;
const gitConcurrencyLimit = pLimit(DEFAULT_GIT_CONCURRENCY);

// Cache for GitHub review requests (expensive API call)
let cachedReviewCount: { count: number; fetchedAt: number } | null = null;
const REVIEW_CACHE_TTL_MS = 60_000; // 1 minute cache

/**
 * Determine the pending request type for a workspace based on its active sessions.
 * Returns 'plan_approval' if any session has a pending ExitPlanMode request,
 * 'user_question' if any session has a pending AskUserQuestion request,
 * or null if no pending requests.
 */
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

class WorkspaceQueryService {
  async getProjectSummaryState(projectId: string) {
    const [project, workspaces] = await Promise.all([
      projectAccessor.findById(projectId),
      workspaceAccessor.findByProjectIdWithSessions(projectId, {
        excludeStatuses: [WorkspaceStatus.ARCHIVED],
      }),
    ]);

    const defaultBranch = project?.defaultBranch ?? 'main';

    // Get all pending requests from active sessions
    const allPendingRequests = chatEventForwarderService.getAllPendingRequests();

    const workingStatusByWorkspace = new Map<string, boolean>();
    const flowStateByWorkspace = new Map<
      string,
      ReturnType<typeof deriveWorkspaceFlowStateFromWorkspace>
    >();
    const pendingRequestByWorkspace = new Map<string, 'plan_approval' | 'user_question' | null>();
    for (const workspace of workspaces) {
      const flowState = deriveWorkspaceFlowStateFromWorkspace(workspace);
      flowStateByWorkspace.set(workspace.id, flowState);

      const sessionIds = workspace.claudeSessions?.map((s) => s.id) ?? [];
      const isSessionWorking = sessionService.isAnySessionWorking(sessionIds);
      workingStatusByWorkspace.set(workspace.id, isSessionWorking || flowState.isWorking);

      const pendingRequestType = computePendingRequestType(sessionIds, allPendingRequests);
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
    if (cachedReviewCount && now - cachedReviewCount.fetchedAt < REVIEW_CACHE_TTL_MS) {
      reviewCount = cachedReviewCount.count;
    } else {
      try {
        const health = await githubCLIService.checkHealth();
        if (health.isInstalled && health.isAuthenticated) {
          const prs = await githubCLIService.listReviewRequests();
          reviewCount = prs.filter((pr) => pr.reviewDecision !== 'APPROVED').length;
          cachedReviewCount = { count: reviewCount, fetchedAt: now };
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
          ...(w.claudeSessions?.map((s) => s.updatedAt) ?? []),
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
    const allPendingRequests = chatEventForwarderService.getAllPendingRequests();

    return workspaces
      .map((workspace) => {
        const sessionIds = workspace.claudeSessions?.map((s) => s.id) ?? [];
        const isSessionWorking = sessionService.isAnySessionWorking(sessionIds);
        const flowState = deriveWorkspaceFlowStateFromWorkspace(workspace);
        const isWorking = isSessionWorking || flowState.isWorking;

        const kanbanColumn = computeKanbanColumn({
          lifecycle: workspace.status,
          isWorking,
          prState: workspace.prState,
          hasHadSessions: workspace.hasHadSessions,
        });

        const pendingRequestType = computePendingRequestType(sessionIds, allPendingRequests);

        return {
          ...workspace,
          kanbanColumn,
          isWorking,
          ratchetButtonAnimated: flowState.shouldAnimateRatchetButton,
          flowPhase: flowState.phase,
          ciObservation: flowState.ciObservation,
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

    const prResult = await prSnapshotService.refreshWorkspace(workspaceId, workspace.prUrl);
    if (!prResult.success) {
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
          const prResult = await prSnapshotService.refreshWorkspace(workspace.id, workspace.prUrl);
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
