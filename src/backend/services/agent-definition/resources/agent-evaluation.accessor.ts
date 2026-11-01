import { configService } from '@/backend/services/config.service';
import {
  agentEvaluationInputSchema,
  agentEvaluationFailureSnapshotSchema,
  agentEvaluationSnapshotSchema,
  agentEventPayloadSchema,
  type AgentEvaluationInput,
  type AgentEvaluationResult,
  type AgentRuntimeReason,
} from '@/shared/agent-runtime';
import type { AgentEvent, AgentEvaluation, Prisma } from '@prisma-gen/client';
import { ledgerTransaction } from './agent-ledger-transaction';
import {
  rawTriggerInput,
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
  if (input.status !== 'MATCHED') {
    const snapshot = {
      version: 1,
      kind: 'NON_DISPATCHING',
      definition: {
        name: trigger.agentDefinition.name,
        instructions: trigger.agentDefinition.instructions,
        isEnabled: trigger.agentDefinition.isEnabled,
        executionConfig: trigger.agentDefinition.executionConfig,
      },
      trigger: rawTriggerInput(trigger),
      input: { ...input.input, eventId: event.id },
    };
    agentEvaluationFailureSnapshotSchema.parse(snapshot);
    return { success: true as const, data: snapshot };
  }
  const definition = trigger.agentDefinition;
  return agentEvaluationSnapshotSchema.safeParse({
    definition: {
      name: definition.name,
      instructions: definition.instructions,
      isEnabled: definition.isEnabled,
      executionConfig: input.executionConfig,
    },
    trigger: rawTriggerInput(trigger),
    executionConfig: input.executionConfig,
    input: { ...input.input, eventId: event.id },
  });
}

async function persistEvaluation(
  tx: Prisma.TransactionClient,
  input: Evaluation,
  event: AgentEvent,
  trigger: RuntimeTrigger,
  snapshot: Prisma.InputJsonObject,
  nextAttemptAt: Date | null
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
      nextAttemptAt,
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

export type EvaluationAttempt = {
  now?: Date;
  retryable?: boolean;
  retryAfterMs?: number;
  expectedAttemptCount?: number;
};
async function recordEvaluation(
  value: AgentEvaluationInput,
  attempt: EvaluationAttempt = {}
): Promise<AgentEvaluationResult> {
  const input = agentEvaluationInputSchema.parse(value);
  const now = attempt.now ?? new Date();
  return await ledgerTransaction(async (tx) => {
    const context = await evaluationContext(tx, input);
    if ('reason' in context) {
      return { status: 'REJECTED', reason: context.reason };
    }
    const { event, trigger } = context;
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
    if (existing && !canRetry(existing, attempt, now)) {
      return { status: 'DUPLICATE', evaluationId: existing.id };
    }
    const fence = evaluationFence(input, event, trigger);
    if (fence) {
      return fence;
    }
    const prior = await tx.agentEvaluation.findFirst({
      where: { eventId: event.id, triggerId: trigger.id },
    });
    if (prior && !existing) {
      return { status: 'REJECTED', reason: 'STALE_EVENT_COHORT' };
    }
    const snapshot = evaluationSnapshot(input, event, trigger);
    if (!snapshot.success) {
      return { status: 'REJECTED', reason: 'INVALID_STORED_DATA' };
    }
    const attemptCount = (existing?.attemptCount ?? 0) + 1;
    const nextAttemptAt = retryAt(input, attempt, attemptCount, now);
    const evaluation = existing
      ? await tx.agentEvaluation.update({
          where: { id: existing.id },
          data: {
            status: input.status,
            reasonCode: input.reasonCode,
            explanation: input.explanation,
            configurationSnapshot: snapshot.data,
            attemptCount,
            nextAttemptAt,
          },
        })
      : await persistEvaluation(tx, input, event, trigger, snapshot.data, nextAttemptAt);
    return { status: 'RECORDED', evaluationId: evaluation.id };
  });
}

export const agentEvaluationAccessor = { recordEvaluation };

function canRetry(existing: AgentEvaluation, attempt: EvaluationAttempt, now: Date) {
  return (
    existing.status === 'ERROR' &&
    existing.nextAttemptAt !== null &&
    existing.nextAttemptAt <= now &&
    existing.attemptCount === attempt.expectedAttemptCount
  );
}
function retryAt(input: Evaluation, attempt: EvaluationAttempt, attemptCount: number, now: Date) {
  const delay = configService.getAgentRuntimeLimits().retryDelaysMs[attemptCount - 1];
  return input.status === 'ERROR' && attempt.retryable && delay !== undefined
    ? new Date(now.getTime() + Math.max(delay, attempt.retryAfterMs ?? 0))
    : null;
}

async function evaluationContext(
  tx: Prisma.TransactionClient,
  input: Evaluation
): Promise<{ event: AgentEvent; trigger: RuntimeTrigger } | { reason: AgentRuntimeReason }> {
  const event = await tx.agentEvent.findUnique({ where: { id: input.eventId } });
  const trigger = await tx.agentTrigger.findUnique({
    where: { id: input.triggerId },
    include: runtimeTriggerInclude,
  });
  if (!(event && trigger)) {
    return { reason: 'NOT_FOUND' };
  }
  if (
    trigger.agentDefinitionId !== input.agentDefinitionId ||
    event.connectionId !== trigger.connectionId
  ) {
    return { reason: 'OWNERSHIP_MISMATCH' };
  }
  return { event, trigger };
}
