import { workspaceNotificationAccessor } from '@/backend/services/workspace/resources/workspace-notification.accessor';

type NotificationInput = {
  workspaceId: string;
  sourceWorkspaceId: string;
  sourceWorkspaceName: string;
  sourceProjectName: string;
  message: string;
};

class WorkspaceNotificationService {
  notifyParent(data: NotificationInput) {
    return workspaceNotificationAccessor.create(data);
  }

  notifyChild(data: NotificationInput) {
    return workspaceNotificationAccessor.create({ ...data, direction: 'PARENT_TO_CHILD' });
  }

  findForDelivery(id: string) {
    return workspaceNotificationAccessor.findById(id);
  }

  async listPendingForDelivery(workspaceId: string) {
    const notifications = await workspaceNotificationAccessor.findPending(workspaceId);
    return notifications.toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  markDelivered(ids: string[]): Promise<void> {
    return workspaceNotificationAccessor.markDelivered(ids);
  }

  countPending(workspaceId: string): Promise<number> {
    return workspaceNotificationAccessor.countPending(workspaceId);
  }
}

export const workspaceNotificationService = new WorkspaceNotificationService();
