import { workspaceChildOriginAccessor } from '@/backend/services/workspace/resources/workspace-child-origin.accessor';
import { workspaceLaunchOriginAccessor } from '@/backend/services/workspace/resources/workspace-launch-origin.accessor';
import type { Prisma } from '@prisma-gen/client';

/** Import joins the caller transaction but writes only through workspace owners. */
export const workspaceChildHistoryService = {
  invalidateImportedWorkspace(tx: Prisma.TransactionClient, workspaceId: string) {
    return workspaceLaunchOriginAccessor.invalidateImportedCoverage(tx, workspaceId);
  },
  recordImportedChild(
    tx: Prisma.TransactionClient,
    workspace: { id: string; parentWorkspaceId: string | null }
  ) {
    return workspaceChildOriginAccessor.retain(tx, workspace);
  },
};
