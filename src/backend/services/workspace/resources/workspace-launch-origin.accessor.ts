import type { Prisma } from '@prisma-gen/client';

type Origin = { runId: string; workspaceId: string; projectId: string };
/** Retained scalars deliberately outlive the workspace, run and project. */
export const workspaceLaunchOriginAccessor = {
  invalidateImportedCoverage(tx: Prisma.TransactionClient, workspaceId: string) {
    return tx.workspaceLaunchOrigin.updateMany({
      where: { workspaceId },
      data: { childHistoryVersion: null },
    });
  },
  find(tx: Prisma.TransactionClient, input: Origin) {
    return tx.workspaceLaunchOrigin.findFirst({
      where: { OR: [{ runId: input.runId }, { workspaceId: input.workspaceId }] },
    });
  },
  create(tx: Prisma.TransactionClient, input: Origin) {
    return tx.workspaceLaunchOrigin.create({ data: { ...input, childHistoryVersion: 1 } });
  },
};
