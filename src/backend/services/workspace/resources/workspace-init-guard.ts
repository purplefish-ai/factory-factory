import { isDeepStrictEqual } from 'node:util';
import { prisma } from '@/backend/db';
import { WorkspaceInitFenceError } from '@/backend/lib/workspace-init-fence-error';
import { eventWorkspaceIdentitySchema } from '@/shared/event-agent-launch';
import { parseWorkspaceRetryContext, type WorkspaceInitGuard } from '@/shared/workspace-init-retry';
import type { Prisma } from '@prisma-gen/client';

/** Preserve ordinary writers; event retries lock before reading exact foreign authority. */
export function withWorkspaceInitGuard<T>(
  id: string,
  guard: WorkspaceInitGuard | undefined,
  operation: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  if (!guard) {
    return operation(prisma);
  }
  guard.assertCurrent();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE "Workspace" SET "updatedAt" = "updatedAt" WHERE 0`;
    try {
      await validateWorkspaceInitContext(tx, id, guard);
    } catch {
      guard.revoke();
      throw new WorkspaceInitFenceError();
    }
    const result = await operation(tx);
    guard.assertCurrent();
    return result;
  });
}

async function validateWorkspaceInitContext(
  tx: Prisma.TransactionClient,
  id: string,
  guard: WorkspaceInitGuard
) {
  const context = guard.context;
  const runId = context.fence.attempt.runId;
  const workspace = await tx.workspace.findUnique({ where: { id }, include: { project: true } });
  const origin = await tx.workspaceLaunchOrigin.findUnique({ where: { workspaceId: id } });
  const run = await tx.agentRun.findUnique({
    where: { id: runId },
    include: { initialDelivery: true, agentDefinition: { select: { projectId: true } } },
  });
  const current = parseWorkspaceRetryContext(run, {
    projectId: context.projectId,
    workspaceId: id,
    runId,
  });
  const identity = eventWorkspaceIdentitySchema.safeParse(workspace?.creationMetadata);
  if (
    !workspace ||
    workspace.project.isArchived ||
    ['ARCHIVING', 'ARCHIVED'].includes(workspace.status) ||
    workspace.creationSource !== 'EVENT_AGENT' ||
    !identity.success ||
    identity.data.runId !== runId ||
    identity.data.reservedSessionId !== context.fence.attempt.sessionId ||
    identity.data.initialMessageId !== context.initialMessageId ||
    origin?.runId !== runId ||
    origin.projectId !== context.projectId ||
    workspace.projectId !== context.projectId ||
    context.workspaceId !== id ||
    current.fence.state !== 'FINISHED' ||
    !isDeepStrictEqual(current.fence.attempt, context.fence.attempt) ||
    !isDeepStrictEqual(current.fence.execution, context.fence.execution) ||
    current.initialMessageId !== context.initialMessageId
  ) {
    guard.revoke();
    throw new WorkspaceInitFenceError();
  }
  guard.assertCurrent();
}
