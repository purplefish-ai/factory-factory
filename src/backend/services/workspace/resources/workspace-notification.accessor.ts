import { prisma } from '@/backend/db';
import type { DurableRecovery } from '@/shared/schemas/durable-recovery.schema';
import type { Prisma, WorkspaceNotification } from '@prisma-gen/client';

interface CreateNotificationInput {
  workspaceId: string;
  sourceWorkspaceId: string;
  sourceWorkspaceName: string;
  sourceProjectName: string;
  message: string;
  direction?: 'CHILD_TO_PARENT' | 'PARENT_TO_CHILD';
}

class WorkspaceNotificationAccessor {
  create(data: CreateNotificationInput): Promise<WorkspaceNotification> {
    const { direction, ...rest } = data;
    return prisma.workspaceNotification.create({
      data: direction ? { ...rest, direction } : rest,
    });
  }

  findById(id: string): Promise<WorkspaceNotification | null> {
    return prisma.workspaceNotification.findUnique({ where: { id } });
  }

  /**
   * Find all undelivered notifications for a workspace, ordered oldest-first
   * so they are delivered in the order they were sent.
   */
  findPending(workspaceId: string): Promise<WorkspaceNotification[]> {
    return prisma.workspaceNotification.findMany({
      where: { workspaceId, deliveredAt: null, recoveryHeld: false },
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
      where: { workspaceId, deliveredAt: null, recoveryHeld: false },
    });
  }
}

export const workspaceNotificationAccessor = new WorkspaceNotificationAccessor();

export async function restoreRecoveryNotifications(
  tx: Prisma.TransactionClient,
  data: DurableRecovery,
  workspaces: ReadonlySet<string>
) {
  for (const row of data.workspaceNotification) {
    if (
      !workspaces.has(row.workspaceId) ||
      (await tx.workspaceNotification.findUnique({ where: { id: row.id } }))
    ) {
      continue;
    }
    if (
      !workspaces.has(row.sourceWorkspaceId) &&
      (await tx.workspace.findUnique({ where: { id: row.sourceWorkspaceId } }))
    ) {
      continue;
    }
    await tx.workspaceNotification.create({
      data: { ...row, recoveryHeld: row.recoveryHeld || row.deliveredAt === null },
    });
  }
}
