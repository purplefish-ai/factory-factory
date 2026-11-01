import {
  agentEvaluationInputSchema,
  agentEvaluationSnapshotSchema,
  agentEventPayloadSchema,
  type AgentEvaluationInput,
  type AgentEvaluationResult,
} from '@/shared/agent-runtime';
import type { AgentEvent, Prisma } from '@prisma-gen/client';
import { ledgerTransaction } from './agent-ledger-transaction';
import {
  runtimeTriggerInclude,
  sameRevisions,
  triggerRevisions,
  type RuntimeTrigger,
} from './agent-runtime-guards';

type Evaluation = ReturnType<typeof agentEvaluationInputSchema.parse>;
function evaluationFence(
  input: Evaluation,
  event: AgentEvent,
  trigger: RuntimeTrigger
): AgentEvaluationResult | null {
  if (!sameRevisions(triggerRevisions(trigger), input)) {
    return { status: 'REJECTED', reason: 'STALE_REVISION' };
  }
  if (trigger.activationState === 'STARTING') {
    return { status: 'DEFERRED', reason: 'ACTIVATION_STARTING' };
  }
  if (event.payloadExpiresAt <= new Date()) {
    return { status: 'REJECTED', reason: 'EVENT_EXPIRED' };
  }
  const payload = agentEventPayloadSchema.safeParse(event.payload);
  if (!payload.success) {
    return { status: 'REJECTED', reason: 'INVALID_STORED_DATA' };
  }
  if (payload.data.provider === 'GITHUB' && event.sourceOrder === null) {
    return { status: 'DEFERRED', reason: 'SOURCE_ORDER_PENDING' };
  }
  if (input.input.eventId !== undefined && input.input.eventId !== event.id) {
    return { status: 'REJECTED', reason: 'OWNERSHIP_MISMATCH' };
  }
  return null;
}
function evaluationSnapshot(input: Evaluation, event: AgentEvent, trigger: RuntimeTrigger) {
  const definition = trigger.agentDefinition;
  return agentEvaluationSnapshotSchema.safeParse({
    definition: {
      name: definition.name,
      instructions: definition.instructions,
      isEnabled: definition.isEnabled,
      executionConfig: input.executionConfig,
    },
    trigger: {
      type: trigger.type,
      description: trigger.description,
      filterInstructions: trigger.filterInstructions,
      isEnabled: trigger.isEnabled,
      connectionId: trigger.connectionId,
      config: trigger.config,
    },
    executionConfig: input.executionConfig,
    input: { ...input.input, eventId: event.id },
  });
}

async function persistEvaluation(
  tx: Prisma.TransactionClient,
  input: Evaluation,
  event: AgentEvent,
  trigger: RuntimeTrigger,
  snapshot: ReturnType<typeof agentEvaluationSnapshotSchema.parse>
) {
  const run =
    input.status === 'MATCHED'
      ? await tx.agentRun.findUnique({
          where: {
            agentDefinitionId_eventId: {
              agentDefinitionId: input.agentDefinitionId,
              eventId: event.id,
            },
          },
        })
      : null;
  return tx.agentEvaluation.create({
    data: {
      eventId: event.id,
      connectionId: event.connectionId,
      agentDefinitionId: input.agentDefinitionId,
      triggerId: trigger.id,
      definitionRevision: input.definitionRevision,
      triggerRevision: input.triggerRevision,
      activationGeneration: input.activationGeneration,
      status: input.status,
      reasonCode: input.reasonCode,
      explanation: input.explanation,
      configurationSnapshot: snapshot,
      ...(input.classifier ? { classifier: input.classifier } : {}),
      runId: run?.id,
      expiresAt: event.payloadExpiresAt,
    },
  });
}

async function recordEvaluation(value: AgentEvaluationInput): Promise<AgentEvaluationResult> {
  const input = agentEvaluationInputSchema.parse(value);
  return await ledgerTransaction(async (tx) => {
    const event = await tx.agentEvent.findUnique({ where: { id: input.eventId } });
    const trigger = await tx.agentTrigger.findUnique({
      where: { id: input.triggerId },
      include: runtimeTriggerInclude,
    });
    if (!(event && trigger)) {
      return { status: 'REJECTED', reason: 'NOT_FOUND' };
    }
    if (
      trigger.agentDefinitionId !== input.agentDefinitionId ||
      event.connectionId !== trigger.connectionId
    ) {
      return { status: 'REJECTED', reason: 'OWNERSHIP_MISMATCH' };
    }
    const existing = await tx.agentEvaluation.findUnique({
      where: {
        eventId_triggerId_definitionRevision_triggerRevision_activationGeneration: {
          eventId: input.eventId,
          triggerId: input.triggerId,
          definitionRevision: input.definitionRevision,
          triggerRevision: input.triggerRevision,
          activationGeneration: input.activationGeneration,
        },
      },
    });
    if (existing) {
      return { status: 'DUPLICATE', evaluationId: existing.id };
    }
    const fence = evaluationFence(input, event, trigger);
    if (fence) {
      return fence;
    }
    const prior = await tx.agentEvaluation.findFirst({
      where: { eventId: event.id, triggerId: trigger.id },
    });
    if (prior) {
      return { status: 'REJECTED', reason: 'STALE_EVENT_COHORT' };
    }
    const snapshot = evaluationSnapshot(input, event, trigger);
    if (!snapshot.success) {
      return { status: 'REJECTED', reason: 'INVALID_STORED_DATA' };
    }
    const evaluation = await persistEvaluation(tx, input, event, trigger, snapshot.data);
    return { status: 'RECORDED', evaluationId: evaluation.id };
  });
}

export const agentEvaluationAccessor = { recordEvaluation };
