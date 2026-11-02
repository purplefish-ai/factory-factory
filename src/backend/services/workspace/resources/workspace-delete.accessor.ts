import { prisma } from '@/backend/db';
import type { WorkspaceDeletionCapture } from '@/backend/services/workspace/types';
import { workspacePrAccessor } from './workspace-pr.accessor';

/** Capture and cascade share the writer lock with attachment and run-owner transactions. */
export function deleteWorkspace(id: string, capture: WorkspaceDeletionCapture) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE "Workspace" SET "name" = "name" WHERE 0`;
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { id } });
    const origin = await tx.workspaceLaunchOrigin.findUnique({ where: { workspaceId: id } });
    const prs = await workspacePrAccessor.listForDeletion(tx, id);
    await capture(tx, {
      workspaceId: id,
      projectId: workspace.projectId,
      originRunId: origin?.runId ?? null,
      prs,
    });
    return tx.workspace.delete({ where: { id } });
  });
}
