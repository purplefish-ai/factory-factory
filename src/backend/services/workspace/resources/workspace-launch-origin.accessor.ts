import { prisma } from '@/backend/db';
import { ApplicationError } from '@/backend/lib/application-error';
import { retainedEventOriginSchema } from '@/shared/agent-history';
import { eventWorkspaceIdentitySchema } from '@/shared/event-agent-launch';
import type { Prisma, Workspace } from '@prisma-gen/client';

type Origin = { runId: string; workspaceId: string; projectId: string };
/** Retained scalars deliberately outlive the workspace, run and project. */
export const workspaceLaunchOriginAccessor = {
  read(input: { projectId: string; workspaceId: string }) {
    return prisma.$transaction(async (tx) => {
      const origin = await tx.workspaceLaunchOrigin.findUnique({
        where: { workspaceId: input.workspaceId },
      });
      const workspace = await tx.workspace.findUnique({
        where: { id: input.workspaceId },
        select: { projectId: true, creationSource: true, creationMetadata: true },
      });
      if (
        (workspace && workspace.projectId !== input.projectId) ||
        (origin && origin.projectId !== input.projectId)
      ) {
        throw new ApplicationError('NOT_FOUND', 'Workspace origin not found in this project.');
      }
      if (origin && workspace) {
        assertLiveIdentity(origin, workspace);
      }
      return origin
        ? retainedEventOriginSchema.parse({
            projectId: origin.projectId,
            workspaceId: origin.workspaceId,
            runId: origin.runId,
            workspaceState: workspace ? 'LIVE' : 'DELETED',
          })
        : null;
    });
  },
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

function assertLiveIdentity(
  origin: Origin,
  workspace: Pick<Workspace, 'creationSource' | 'creationMetadata'>
) {
  const identity = eventWorkspaceIdentitySchema.safeParse(workspace.creationMetadata);
  if (
    workspace.creationSource !== 'EVENT_AGENT' ||
    !identity.success ||
    identity.data.runId !== origin.runId
  ) {
    throw new ApplicationError(
      'NOT_FOUND',
      'Workspace origin does not match its creation identity.'
    );
  }
}
