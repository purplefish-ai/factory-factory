import { ApplicationError } from '@/backend/lib/application-error';
import type { AgentSpecification } from '@/shared/agent-proposal';
import {
  agentExecutionConfigSchema,
  agentTriggerInputSchema,
} from '@/shared/schemas/agent-definition.schema';
import { Prisma } from '@prisma-gen/client';

async function pauseRemovedTriggers(
  tx: Prisma.TransactionClient,
  current: Prisma.AgentDefinitionGetPayload<{ include: { triggers: true } }>,
  retained: Set<string>,
  executionChanged: boolean
) {
  const pausedIds: string[] = [];
  for (const removed of current.triggers.filter((trigger) => !retained.has(trigger.id))) {
    if (
      removed.isConfigured === false &&
      !(executionChanged || removed.isEnabled) &&
      removed.activationState === 'PAUSED'
    ) {
      continue;
    }
    pausedIds.push(removed.id);
    await tx.agentTrigger.update({
      where: { id: removed.id },
      data: {
        isConfigured: false,
        isEnabled: false,
        activationState: 'PAUSED',
        triggerRevision: { increment: 1 },
        activationGeneration: { increment: 1 },
        activationBoundary: Prisma.DbNull,
        pendingActivation: Prisma.DbNull,
      },
    });
  }
  return pausedIds;
}

/** Authoring's literal paused flags are not runtime activation state. */
async function reviseDefinition(
  tx: Prisma.TransactionClient,
  definitionId: string,
  definition: Omit<AgentSpecification, 'triggers'>,
  triggers: Array<AgentSpecification['triggers'][number] & { id: string }>
) {
  const current = await tx.agentDefinition.findUniqueOrThrow({
    where: { id: definitionId },
    include: { triggers: true },
  });
  assertManagementRevision(current.managementRevision);
  const executionChanged =
    current.instructions !== definition.instructions ||
    JSON.stringify(agentExecutionConfigSchema.parse(current.executionConfig)) !==
      JSON.stringify(definition.executionConfig);
  await tx.agentDefinition.update({
    where: { id: definitionId },
    data: {
      ...definition,
      managementRevision: { increment: 1 },
      ...(executionChanged ? { definitionRevision: { increment: 1 } } : {}),
    },
  });
  const retained = new Set(triggers.map((trigger) => trigger.id));
  const pausedIds = new Set<string>();
  for (const trigger of triggers) {
    const previous = current.triggers.find((candidate) => candidate.id === trigger.id);
    const { id, ...settings } = trigger;
    if (!previous) {
      await tx.agentTrigger.create({
        data: {
          ...settings,
          id,
          agentDefinitionId: definitionId,
          isConfigured: true,
          isEnabled: false,
        },
      });
      continue;
    }
    const before = agentTriggerInputSchema.parse({
      type: previous.type,
      connectionId: previous.connectionId,
      description: previous.description,
      filterInstructions: previous.filterInstructions,
      config: previous.config,
      isEnabled: false,
    });
    const changed =
      !previous.isConfigured ||
      JSON.stringify(before) !==
        JSON.stringify(agentTriggerInputSchema.parse({ ...settings, isEnabled: false }));
    if (!(changed || executionChanged)) {
      continue;
    }
    pausedIds.add(id);
    await tx.agentTrigger.update({
      where: { id },
      data: {
        ...settings,
        isConfigured: true,
        isEnabled: false,
        activationState: 'PAUSED',
        activationGeneration: { increment: 1 },
        ...(changed ? { triggerRevision: { increment: 1 } } : {}),
        activationBoundary: Prisma.DbNull,
        pendingActivation: Prisma.DbNull,
      },
    });
  }
  for (const id of await pauseRemovedTriggers(tx, current, retained, executionChanged)) {
    pausedIds.add(id);
  }
  if (!executionChanged && pausedIds.size === 0) {
    return;
  }
  const now = new Date();
  const affected = await tx.agentRun.findMany({
    where: {
      agentDefinitionId: definitionId,
      status: 'QUEUED',
      ...(executionChanged ? {} : { triggerId: { in: [...pausedIds] } }),
    },
    select: { id: true },
  });
  const ids = affected.map((run) => run.id);
  await tx.agentRun.updateMany({
    where: { id: { in: ids } },
    data: {
      status: 'CANCELLED',
      launchPhase: 'FINISHED',
      reasonCode: 'STALE_REVISION',
      completedAt: now,
    },
  });
  await tx.agentInitialDelivery.updateMany({
    where: { runId: { in: ids }, state: 'PENDING' },
    data: { state: 'FINISHED', finishedAt: now },
  });
}

export const agentRevisionAccessor = { reviseDefinition };

function assertManagementRevision(revision: number) {
  if (revision >= 2_147_483_647) {
    throw new ApplicationError('CONFLICT', 'The management revision is exhausted.');
  }
}
