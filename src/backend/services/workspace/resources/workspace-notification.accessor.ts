import type { WorkspaceNotification } from '@prisma-gen/client';
import { prisma } from '@/backend/db';

interface CreateNotificationInput {
  workspaceId: string;
  sourceWorkspaceId: string;
  sourceWorkspaceName: string;
  sourceProjectName: string;
  message: string;
}

class WorkspaceNotificationAccessor {
  create(data: CreateNotificationInput): Promise<WorkspaceNotification> {
    return prisma.workspaceNotification.create({ data });
  }

  /**
   * Find all undelivered notifications for a workspace, ordered oldest-first
   * so they are delivered in the order they were sent.
   */
  findPending(workspaceId: string): Promise<WorkspaceNotification[]> {
    return prisma.workspaceNotification.findMany({
      where: { workspaceId, deliveredAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Mark a batch of notifications as delivered.
   */
  async markDelivered(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await prisma.workspaceNotification.updateMany({
      where: { id: { in: ids } },
      data: { deliveredAt: new Date() },
    });
  }

  countPending(workspaceId: string): Promise<number> {
    return prisma.workspaceNotification.count({
      where: { workspaceId, deliveredAt: null },
    });
  }
}

export const workspaceNotificationAccessor = new WorkspaceNotificationAccessor();
