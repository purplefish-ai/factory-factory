import type { WorkspaceStatus } from '@prisma-gen/browser';
import { useMemo } from 'react';
import { useLocation } from 'react-router';
import { useProjectContext } from '@/frontend/lib/providers';
import { trpc } from '@/frontend/lib/trpc';
import { useWebSocketTransport } from '@/hooks/use-websocket-transport';
import { buildWebSocketUrl } from '@/lib/websocket-config';

type EventsMessage =
  | {
      type: 'project_list_snapshot';
      projects: unknown[];
    }
  | {
      type: 'project_summary_snapshot';
      projectId: string;
      workspaces: unknown[];
      reviewCount: number;
    }
  | {
      type: 'workspace_list_snapshot';
      projectId: string;
      workspaces: unknown[];
    }
  | {
      type: 'kanban_snapshot';
      projectId: string;
      workspaces: unknown[];
    }
  | {
      type: 'workspace_detail_snapshot';
      workspaceId: string;
      workspace: unknown;
    }
  | {
      type: 'session_list_snapshot';
      workspaceId: string;
      sessions: unknown[];
    }
  | {
      type: 'workspace_init_status_snapshot';
      workspaceId: string;
      status: WorkspaceStatus;
      initErrorMessage: string | null;
      initStartedAt: string | null;
      initCompletedAt: string | null;
      hasStartupScript: boolean;
    }
  | {
      type: 'reviews_snapshot';
      prs: unknown[];
      health: { isInstalled: boolean; isAuthenticated: boolean };
      error: string | null;
    }
  | {
      type: 'admin_stats_snapshot';
      stats: unknown;
    }
  | {
      type: 'admin_processes_snapshot';
      processes: unknown;
    };

function getWorkspaceIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/\/workspaces\/([^/]+)/);
  return match?.[1];
}

export function EventsSocketManager() {
  const { projectId } = useProjectContext();
  const location = useLocation();
  const workspaceId = useMemo(() => getWorkspaceIdFromPath(location.pathname), [location.pathname]);
  const utils = trpc.useUtils();

  const url = useMemo(() => {
    const params: Record<string, string> = {};
    if (projectId) {
      params.projectId = projectId;
    }
    if (workspaceId) {
      params.workspaceId = workspaceId;
    }
    return buildWebSocketUrl('/events', params);
  }, [projectId, workspaceId]);

  const handleMessage = (data: unknown) => {
    const message = data as EventsMessage;
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return;
    }

    switch (message.type) {
      case 'project_list_snapshot': {
        utils.project.list.setData({ isArchived: false }, message.projects as never[]);
        break;
      }
      case 'project_summary_snapshot': {
        utils.workspace.getProjectSummaryState.setData(
          { projectId: message.projectId },
          { workspaces: message.workspaces as never[], reviewCount: message.reviewCount }
        );
        break;
      }
      case 'workspace_list_snapshot': {
        const statusFilters: WorkspaceStatus[] = [
          'NEW',
          'PROVISIONING',
          'READY',
          'FAILED',
          'ARCHIVED',
        ];
        const workspaces = message.workspaces as Array<{ status?: WorkspaceStatus }>;
        utils.workspace.list.setData({ projectId: message.projectId }, workspaces as never[]);
        for (const status of statusFilters) {
          utils.workspace.list.setData(
            { projectId: message.projectId, status },
            workspaces.filter((workspace) => workspace.status === status) as never[]
          );
        }
        break;
      }
      case 'kanban_snapshot': {
        utils.workspace.listWithKanbanState.setData(
          { projectId: message.projectId },
          message.workspaces as never[]
        );
        break;
      }
      case 'workspace_detail_snapshot': {
        utils.workspace.get.setData({ id: message.workspaceId }, message.workspace as never);
        break;
      }
      case 'session_list_snapshot': {
        utils.session.listClaudeSessions.setData(
          { workspaceId: message.workspaceId },
          message.sessions as never[]
        );
        break;
      }
      case 'workspace_init_status_snapshot': {
        utils.workspace.getInitStatus.setData(
          { id: message.workspaceId },
          {
            status: message.status,
            initErrorMessage: message.initErrorMessage,
            initStartedAt: message.initStartedAt ? new Date(message.initStartedAt) : null,
            initCompletedAt: message.initCompletedAt ? new Date(message.initCompletedAt) : null,
            hasStartupScript: message.hasStartupScript,
          }
        );
        break;
      }
      case 'reviews_snapshot': {
        utils.prReview.listReviewRequests.setData(undefined, {
          prs: message.prs as never[],
          health: message.health,
          error: message.error,
        });
        break;
      }
      case 'admin_stats_snapshot': {
        utils.admin.getSystemStats.setData(undefined, message.stats as never);
        break;
      }
      case 'admin_processes_snapshot': {
        utils.admin.getActiveProcesses.setData(undefined, message.processes as never);
        break;
      }
      default:
        break;
    }
  };

  useWebSocketTransport({
    url,
    onMessage: handleMessage,
  });

  return null;
}
