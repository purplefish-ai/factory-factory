export { restoreRecoveryNotifications } from './workspace-notification.accessor';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import type { Prisma } from '@prisma-gen/client';

export async function restoreWorkspaceScheduleLinks(
  tx: Prisma.TransactionClient,
  workspaces: ExportData['data']['workspaces'],
  importedWorkspaces: ReadonlySet<string>,
  importedTasks: ReadonlySet<string>
) {
  for (const workspace of workspaces) {
    if (
      !(
        importedWorkspaces.has(workspace.id) &&
        workspace.periodicTaskId &&
        importedTasks.has(workspace.periodicTaskId)
      )
    ) {
      continue;
    }
    const task = await tx.periodicTask.findFirst({
      where: { id: workspace.periodicTaskId, projectId: workspace.projectId },
    });
    if (!task) {
      throw new Error('Imported schedule belongs to another project');
    }
    await tx.workspace.updateMany({
      where: { id: workspace.id, projectId: workspace.projectId, periodicTaskId: null },
      data: { periodicTaskId: task.id },
    });
  }
}
