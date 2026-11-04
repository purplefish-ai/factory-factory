import { workspaceNotificationAccessor } from '@/backend/services/workspace/resources/workspace-notification.accessor';
import type {
  AckMailInput,
  UnreadMailCountsInput,
  ListMailInput,
  ReadMailInput,
  WorkspaceMailSendMetadata,
  WorkspaceMailWakeClaim,
} from '@/shared/workspace-mail';

type NotificationInput = WorkspaceMailSendMetadata & {
  workspaceId: string;
  sourceWorkspaceId: string;
  sourceWorkspaceName: string;
  sourceProjectName: string;
  message: string;
};

class WorkspaceNotificationService {
  unreadCountsForProject(input: UnreadMailCountsInput) {
    return workspaceNotificationAccessor.unreadCountsForProject(input);
  }

  listMail(input: ListMailInput) {
    return workspaceNotificationAccessor.listMail(input);
  }
  readMail(input: ReadMailInput) {
    return workspaceNotificationAccessor.readMail(input);
  }
  ackMail(input: AckMailInput) {
    return workspaceNotificationAccessor.ackMail(input);
  }
  claimWake(input: { workspaceId: string }) {
    return workspaceNotificationAccessor.claimWake(input);
  }
  settleWake(input: WorkspaceMailWakeClaim) {
    return workspaceNotificationAccessor.settleWake(input);
  }
  releaseWake(input: WorkspaceMailWakeClaim) {
    return workspaceNotificationAccessor.releaseWake(input);
  }
  quarantineWake(input: WorkspaceMailWakeClaim) {
    return workspaceNotificationAccessor.quarantineWake(input);
  }
  disarmWake(input: WorkspaceMailWakeClaim) {
    return workspaceNotificationAccessor.disarmWake(input);
  }
  retryWake(input: { workspaceId: string }) {
    return workspaceNotificationAccessor.retryWake(input);
  }
  nextWakeRetryAt(input: { workspaceId: string }) {
    return workspaceNotificationAccessor.nextWakeRetryAt(input);
  }

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
    return [...notifications].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  markDelivered(ids: string[]): Promise<void> {
    return workspaceNotificationAccessor.markDelivered(ids);
  }

  countPending(workspaceId: string): Promise<number> {
    return workspaceNotificationAccessor.countPending(workspaceId);
  }
}

export const workspaceNotificationService = new WorkspaceNotificationService();
