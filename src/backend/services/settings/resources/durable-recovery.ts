import { durableRecoverySchema } from '@/shared/schemas/durable-recovery.schema';
import type { Prisma } from '@prisma-gen/client';

export async function readDurableRecovery(tx: Prisma.TransactionClient) {
  const rows = {
    periodicTask: await tx.periodicTask.findMany({
      select: {
        id: true,
        projectId: true,
        name: true,
        prompt: true,
        cadence: true,
        scheduledTime: true,
        timezone: true,
        scheduledDayOfMonth: true,
        isEnabled: true,
        nextRunAt: true,
        lastRunAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    periodicTaskExecution: await tx.periodicTaskExecution.findMany({
      select: {
        launchSnapshot: true,
        id: true,
        periodicTaskId: true,
        workspaceId: true,
        status: true,
        prUrl: true,
        prNumber: true,
        errorMessage: true,
        startedAt: true,
        completedAt: true,
      },
    }),
    agentDefinition: await tx.agentDefinition.findMany({
      select: {
        id: true,
        projectId: true,
        name: true,
        instructions: true,
        isEnabled: true,
        executionConfig: true,
        definitionRevision: true,
        managementRevision: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    agentConnection: await tx.agentConnection.findMany({
      select: {
        id: true,
        provider: true,
        externalId: true,
        name: true,
        isEnabled: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    agentTrigger: await tx.agentTrigger.findMany({
      select: {
        id: true,
        agentDefinitionId: true,
        type: true,
        connectionId: true,
        description: true,
        config: true,
        filterInstructions: true,
        isEnabled: true,
        isConfigured: true,
        triggerRevision: true,
        activationGeneration: true,
        activationState: true,
        activationBoundary: true,
        pendingActivation: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  };
  return durableRecoverySchema.parse(JSON.parse(JSON.stringify(rows)));
}
