import type { Prisma } from '@prisma-gen/client';

/** Retained ownership, never proof that child work stopped. */
export const workspaceChildOriginAccessor = {
  async retain(
    tx: Prisma.TransactionClient,
    workspace: { id: string; parentWorkspaceId: string | null }
  ) {
    if (!workspace.parentWorkspaceId) {
      return;
    }
    const identity = {
      parentWorkspaceId: workspace.parentWorkspaceId,
      childWorkspaceId: workspace.id,
    };
    await tx.workspaceChildOrigin.upsert({
      where: { parentWorkspaceId_childWorkspaceId: identity },
      create: identity,
      update: {},
    });
  },
};
