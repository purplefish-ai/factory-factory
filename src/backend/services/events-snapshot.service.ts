/**
 * Events Snapshot Service
 *
 * Produces snapshot payloads for the global /events WebSocket.
 */

import { SessionStatus, WorkspaceStatus } from '@prisma-gen/client';
import pLimit from 'p-limit';
import { getWorkspaceGitStats } from '../lib/git-helpers';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import { projectAccessor } from '../resource_accessors/project.accessor';
import { terminalSessionAccessor } from '../resource_accessors/terminal-session.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { configService } from './config.service';
import { computeKanbanColumn } from './kanban-state.service';
import { createLogger } from './logger.service';
import { rateLimiter } from './rate-limiter.service';
import { sessionService } from './session.service';
import { terminalService } from './terminal.service';

const logger = createLogger('events-snapshot');

const DEFAULT_GIT_CONCURRENCY = 3;
const gitConcurrencyLimit = pLimit(DEFAULT_GIT_CONCURRENCY);

export interface ProjectSummarySnapshot {
  type: 'project_summary_snapshot';
  projectId: string;
  workspaces: Array<{
    id: string;
    name: string;
    branchName: string | null;
    prUrl: string | null;
    prNumber: number | null;
    prState: string | null;
    prCiStatus: string | null;
    isWorking: boolean;
    gitStats: {
      total: number;
      additions: number;
      deletions: number;
      hasUncommitted: boolean;
    } | null;
    lastActivityAt: string | null;
  }>;
  reviewCount: number;
}

export interface WorkspaceInitStatusSnapshot {
  type: 'workspace_init_status_snapshot';
  workspaceId: string;
  status: string;
  initErrorMessage: string | null;
  initStartedAt: string | null;
  initCompletedAt: string | null;
  hasStartupScript: boolean;
}

export interface ReviewsSnapshot {
  type: 'reviews_snapshot';
  prs: unknown[];
  health: { isInstalled: boolean; isAuthenticated: boolean };
  error: string | null;
}

export interface WorkspaceListSnapshot {
  type: 'workspace_list_snapshot';
  projectId: string;
  workspaces: unknown[];
}

export interface KanbanSnapshot {
  type: 'kanban_snapshot';
  projectId: string;
  workspaces: unknown[];
}

export interface ProjectListSnapshot {
  type: 'project_list_snapshot';
  projects: unknown[];
}

export interface WorkspaceDetailSnapshot {
  type: 'workspace_detail_snapshot';
  workspaceId: string;
  workspace: unknown;
}

export interface SessionListSnapshot {
  type: 'session_list_snapshot';
  workspaceId: string;
  sessions: unknown[];
}

export interface AdminStatsSnapshot {
  type: 'admin_stats_snapshot';
  stats: unknown;
}

export interface AdminProcessesSnapshot {
  type: 'admin_processes_snapshot';
  processes: unknown;
}

export type EventsSnapshot =
  | ProjectSummarySnapshot
  | WorkspaceInitStatusSnapshot
  | ReviewsSnapshot
  | WorkspaceListSnapshot
  | KanbanSnapshot
  | ProjectListSnapshot
  | WorkspaceDetailSnapshot
  | SessionListSnapshot
  | AdminStatsSnapshot
  | AdminProcessesSnapshot;

class EventsSnapshotService {
  async getProjectListSnapshot(): Promise<ProjectListSnapshot> {
    const projects = await projectAccessor.list({ isArchived: false });
    return {
      type: 'project_list_snapshot',
      projects,
    };
  }

  async getProjectSummarySnapshot(
    projectId: string,
    reviewCount: number
  ): Promise<ProjectSummarySnapshot> {
    const [project, workspaces] = await Promise.all([
      projectAccessor.findById(projectId),
      workspaceAccessor.findByProjectIdWithSessions(projectId, {
        excludeStatuses: [WorkspaceStatus.ARCHIVED],
      }),
    ]);

    const defaultBranch = project?.defaultBranch ?? 'main';

    const workingStatusByWorkspace = new Map<string, boolean>();
    for (const workspace of workspaces) {
      const sessionIds = workspace.claudeSessions?.map((s) => s.id) ?? [];
      workingStatusByWorkspace.set(workspace.id, sessionService.isAnySessionWorking(sessionIds));
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
            gitStatsResults[workspace.id] = await getWorkspaceGitStats(
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

    const snapshots = workspaces.map((workspace) => {
      const sessionDates = [
        ...(workspace.claudeSessions?.map((s) => s.updatedAt) ?? []),
        ...(workspace.terminalSessions?.map((s) => s.updatedAt) ?? []),
      ].filter(Boolean) as Date[];
      const lastActivityAt =
        sessionDates.length > 0
          ? sessionDates.reduce((latest, d) => (d > latest ? d : latest)).toISOString()
          : null;

      return {
        id: workspace.id,
        name: workspace.name,
        branchName: workspace.branchName,
        prUrl: workspace.prUrl,
        prNumber: workspace.prNumber,
        prState: workspace.prState,
        prCiStatus: workspace.prCiStatus,
        isWorking: workingStatusByWorkspace.get(workspace.id) ?? false,
        gitStats: gitStatsResults[workspace.id] ?? null,
        lastActivityAt,
      };
    });

    return {
      type: 'project_summary_snapshot',
      projectId,
      workspaces: snapshots,
      reviewCount,
    };
  }

  async getWorkspaceInitStatusSnapshot(
    workspaceId: string
  ): Promise<WorkspaceInitStatusSnapshot | null> {
    const workspace = await workspaceAccessor.findByIdWithProject(workspaceId);
    if (!workspace) {
      return null;
    }

    return {
      type: 'workspace_init_status_snapshot',
      workspaceId,
      status: workspace.status,
      initErrorMessage: workspace.initErrorMessage,
      initStartedAt: workspace.initStartedAt ? workspace.initStartedAt.toISOString() : null,
      initCompletedAt: workspace.initCompletedAt ? workspace.initCompletedAt.toISOString() : null,
      hasStartupScript: !!(
        workspace.project?.startupScriptCommand || workspace.project?.startupScriptPath
      ),
    };
  }

  async getWorkspaceListSnapshot(projectId: string): Promise<WorkspaceListSnapshot> {
    const workspaces = await workspaceAccessor.findByProjectId(projectId, {});
    return {
      type: 'workspace_list_snapshot',
      projectId,
      workspaces,
    };
  }

  async getWorkspaceDetailSnapshot(workspaceId: string): Promise<WorkspaceDetailSnapshot | null> {
    const workspace = await workspaceAccessor.findById(workspaceId);
    if (!workspace) {
      return null;
    }
    return {
      type: 'workspace_detail_snapshot',
      workspaceId,
      workspace,
    };
  }

  async getSessionListSnapshot(workspaceId: string): Promise<SessionListSnapshot> {
    const sessions = await claudeSessionAccessor.findByWorkspaceId(workspaceId);
    const sessionsWithStatus = sessions.map((session) => ({
      ...session,
      isWorking: sessionService.isSessionWorking(session.id),
    }));
    return {
      type: 'session_list_snapshot',
      workspaceId,
      sessions: sessionsWithStatus,
    };
  }

  getAdminStatsSnapshot(): AdminStatsSnapshot {
    const apiUsage = rateLimiter.getApiUsageStats();
    const config = configService.getSystemConfig();
    return {
      type: 'admin_stats_snapshot',
      stats: {
        apiUsage,
        environment: config.nodeEnv,
        features: config.features,
      },
    };
  }

  async getAdminProcessesSnapshot(): Promise<AdminProcessesSnapshot> {
    const activeClaudeProcesses = sessionService.getAllActiveProcesses();
    const activeTerminals = terminalService.getAllTerminals();

    const claudeSessionsWithPid = await claudeSessionAccessor.findWithPid();
    const terminalSessionsWithPid = await terminalSessionAccessor.findWithPid();

    const workspaceIds = new Set([
      ...claudeSessionsWithPid.map((s) => s.workspaceId),
      ...terminalSessionsWithPid.map((s) => s.workspaceId),
      ...activeTerminals.map((t) => t.workspaceId),
    ]);
    const workspaces = await workspaceAccessor.findByIdsWithProject(Array.from(workspaceIds));
    const workspaceMap = new Map(workspaces.map((w) => [w.id, w]));

    const dbSessionIds = new Set(claudeSessionsWithPid.map((s) => s.id));
    const claudeProcesses = claudeSessionsWithPid.map((session) => {
      const memProcess = activeClaudeProcesses.find((p) => p.sessionId === session.id);
      const workspace = workspaceMap.get(session.workspaceId);
      return {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workspaceName: workspace?.name ?? 'Unknown',
        workspaceBranch: workspace?.branchName ?? null,
        projectSlug: workspace?.project.slug ?? null,
        name: session.name,
        workflow: session.workflow,
        model: session.model,
        pid: session.claudeProcessPid,
        status: session.status,
        inMemory: !!memProcess,
        memoryStatus: memProcess?.status ?? null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        cpuPercent: memProcess?.resourceUsage?.cpu ?? null,
        memoryBytes: memProcess?.resourceUsage?.memory ?? null,
        idleTimeMs: memProcess?.idleTimeMs ?? null,
      };
    });

    for (const memProcess of activeClaudeProcesses) {
      if (!dbSessionIds.has(memProcess.sessionId)) {
        const statusMap: Record<string, SessionStatus> = {
          starting: SessionStatus.RUNNING,
          ready: SessionStatus.IDLE,
          running: SessionStatus.RUNNING,
          exited: SessionStatus.COMPLETED,
        };
        claudeProcesses.push({
          sessionId: memProcess.sessionId,
          workspaceId: 'unknown',
          workspaceName: 'Unknown (orphan)',
          workspaceBranch: null,
          projectSlug: null,
          name: null,
          workflow: 'unknown',
          model: 'unknown',
          pid: memProcess.pid ?? null,
          status: statusMap[memProcess.status] ?? SessionStatus.RUNNING,
          inMemory: true,
          memoryStatus: memProcess.status,
          createdAt: new Date(),
          updatedAt: new Date(),
          cpuPercent: memProcess.resourceUsage?.cpu ?? null,
          memoryBytes: memProcess.resourceUsage?.memory ?? null,
          idleTimeMs: memProcess.idleTimeMs ?? null,
        });
      }
    }

    const terminalProcesses = activeTerminals.map((terminal) => {
      const terminalSession = terminalSessionsWithPid.find(
        (t) => t.workspaceId === terminal.workspaceId && t.pid === terminal.pid
      );
      const workspace = workspaceMap.get(terminal.workspaceId);
      return {
        terminalId: terminal.id,
        workspaceId: terminal.workspaceId,
        workspaceName: workspace?.name ?? 'Unknown',
        workspaceBranch: workspace?.branchName ?? null,
        projectSlug: workspace?.project.slug ?? null,
        pid: terminal.pid,
        cols: terminal.cols,
        rows: terminal.rows,
        createdAt: terminal.createdAt,
        dbSessionId: terminalSession?.id ?? null,
        cpuPercent: terminal.resourceUsage?.cpu ?? null,
        memoryBytes: terminal.resourceUsage?.memory ?? null,
      };
    });

    return {
      type: 'admin_processes_snapshot',
      processes: {
        claude: claudeProcesses,
        terminal: terminalProcesses,
        summary: {
          totalClaude: claudeProcesses.length,
          totalTerminal: terminalProcesses.length,
          total: claudeProcesses.length + terminalProcesses.length,
        },
      },
    };
  }

  async getKanbanSnapshot(projectId: string): Promise<KanbanSnapshot> {
    const workspaces = await workspaceAccessor.findByProjectIdWithSessions(projectId, {
      excludeStatuses: [WorkspaceStatus.ARCHIVED],
    });

    const workspacesWithKanban = workspaces.map((workspace) => {
      const sessionIds = workspace.claudeSessions?.map((s) => s.id) ?? [];
      const isWorking = sessionService.isAnySessionWorking(sessionIds);
      const kanbanColumn = computeKanbanColumn({
        lifecycle: workspace.status,
        isWorking,
        prState: workspace.prState,
        hasHadSessions: workspace.hasHadSessions,
      });

      return {
        ...workspace,
        kanbanColumn,
        isWorking,
      };
    });

    return {
      type: 'kanban_snapshot',
      projectId,
      workspaces: workspacesWithKanban,
    };
  }
}

export const eventsSnapshotService = new EventsSnapshotService();
