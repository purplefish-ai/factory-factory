import { useMemo } from 'react';
import { useLocation } from 'react-router';
import { useProjectContext } from '@/frontend/lib/providers';
import { trpc } from '@/frontend/lib/trpc';
import { useWebSocketTransport } from '@/hooks/use-websocket-transport';
import { buildWebSocketUrl } from '@/lib/websocket-config';
import { EventsSnapshotSchema } from '@/shared/events-snapshots';

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
    const wantsGlobal =
      location.pathname.startsWith('/admin') ||
      location.pathname.startsWith('/reviews') ||
      location.pathname.startsWith('/projects') ||
      !projectId;
    if (wantsGlobal) {
      params.scope = 'global';
    }
    if (projectId) {
      params.projectId = projectId;
    }
    if (workspaceId) {
      params.workspaceId = workspaceId;
    }
    return buildWebSocketUrl('/events', params);
  }, [projectId, workspaceId, location.pathname]);

  const handleMessage = (data: unknown) => {
    const parsed = EventsSnapshotSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;

    switch (message.type) {
      case 'project_list_snapshot': {
        utils.project.list.invalidate({ isArchived: false });
        break;
      }
      case 'project_summary_snapshot': {
        utils.workspace.getProjectSummaryState.invalidate({ projectId: message.projectId });
        break;
      }
      case 'workspace_list_snapshot': {
        utils.workspace.list.invalidate({ projectId: message.projectId });
        break;
      }
      case 'kanban_snapshot': {
        utils.workspace.listWithKanbanState.invalidate({ projectId: message.projectId });
        break;
      }
      case 'workspace_detail_snapshot': {
        utils.workspace.get.invalidate({ id: message.workspaceId });
        break;
      }
      case 'session_list_snapshot': {
        utils.session.listClaudeSessions.invalidate({ workspaceId: message.workspaceId });
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
        utils.prReview.listReviewRequests.invalidate();
        break;
      }
      case 'admin_stats_snapshot': {
        utils.admin.getSystemStats.invalidate();
        break;
      }
      case 'admin_processes_snapshot': {
        utils.admin.getActiveProcesses.invalidate();
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
