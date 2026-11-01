import { prisma } from '@/backend/db';
import { eventAgentExecutionSchema, type EventSessionCreation } from '@/shared/event-agent-launch';
import type { Prisma } from '@prisma-gen/client';

export const agentSessionLaunchOriginAccessor = {
  find(tx: Prisma.TransactionClient, input: EventSessionCreation) {
    return tx.agentSessionLaunchOrigin.findFirst({
      where: { OR: [{ runId: input.runId }, { sessionId: input.id }] },
    });
  },
  create(tx: Prisma.TransactionClient, input: EventSessionCreation) {
    return tx.agentSessionLaunchOrigin.create({
      data: {
        runId: input.runId,
        sessionId: input.id,
        workspaceId: input.workspaceId,
        execution: input.execution,
      },
    });
  },
  async findBySessionId(sessionId: string) {
    const origin = await prisma.agentSessionLaunchOrigin.findUnique({ where: { sessionId } });
    return origin
      ? { ...origin, execution: eventAgentExecutionSchema.parse(origin.execution) }
      : null;
  },
};
