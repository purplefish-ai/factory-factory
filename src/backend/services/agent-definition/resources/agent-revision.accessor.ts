import { ApplicationError } from '@/backend/lib/application-error';
import type { AgentSpecification } from '@/shared/agent-proposal';
import {
  agentExecutionConfigSchema,
  agentTriggerInputSchema,
} from '@/shared/schemas/agent-definition.schema';
import type { AgentTrigger, Prisma } from '@prisma-gen/client';
import { cancelQueuedRuns, pauseTriggers } from './agent-trigger-pause';

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
      data: { isConfigured: false, triggerRevision: { increment: 1 } },
    });
  }
  return pausedIds;
}

function triggerSettingsChanged(
  previous: AgentTrigger,
  settings: AgentSpecification['triggers'][number]
) {
  const before = agentTriggerInputSchema.safeParse({
    type: previous.type,
    connectionId: previous.connectionId,
    description: previous.description,
    filterInstructions: previous.filterInstructions,
    config: previous.config,
    isEnabled: false,
  });
  return (
    !(previous.isConfigured && before.success) ||
    JSON.stringify(before.data) !==
      JSON.stringify(agentTriggerInputSchema.parse({ ...settings, isEnabled: false }))
  );
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
  const previousExecution = agentExecutionConfigSchema.safeParse(current.executionConfig);
  const executionChanged =
    !previousExecution.success ||
    current.instructions !== definition.instructions ||
    JSON.stringify(previousExecution.data) !== JSON.stringify(definition.executionConfig);
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
    const changed = triggerSettingsChanged(previous, settings);
    if (!(changed || executionChanged)) {
      continue;
    }
    pausedIds.add(id);
    await tx.agentTrigger.update({
      where: { id },
      data: {
        ...settings,
        isConfigured: true,
        ...(changed ? { triggerRevision: { increment: 1 } } : {}),
      },
    });
  }
  for (const id of await pauseRemovedTriggers(tx, current, retained, executionChanged)) {
    pausedIds.add(id);
  }
  await pauseTriggers(tx, { id: { in: [...pausedIds] } });
  if (executionChanged) {
    // Execution edits also invalidate queued work that no paused trigger owns.
    await cancelQueuedRuns(tx, { agentDefinitionId: definitionId });
  }
}

export const agentRevisionAccessor = { reviseDefinition };

function assertManagementRevision(revision: number) {
  if (revision >= 2_147_483_647) {
    throw new ApplicationError('CONFLICT', 'The management revision is exhausted.');
  }
}
