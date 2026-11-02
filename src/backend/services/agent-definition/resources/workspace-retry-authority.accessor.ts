import { prisma } from '@/backend/db';
import { parseWorkspaceRetryContext } from '@/shared/workspace-init-retry';
export const workspaceRetryAuthorityAccessor = {
  async read(target: { projectId: string; workspaceId: string; runId: string }) {
    const row = await prisma.agentRun.findUnique({
      where: { id: target.runId },
      include: { initialDelivery: true, agentDefinition: { select: { projectId: true } } },
    });
    return parseWorkspaceRetryContext(row, target);
  },
};
