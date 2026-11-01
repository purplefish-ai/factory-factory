import { randomUUID } from 'node:crypto';
import { configService } from '@/backend/services/config.service';
import {
  agentAdmissionInputSchema,
  agentEvaluationSnapshotSchema,
  type AdmissionResult,
  type AgentAdmissionInput,
  type AgentRuntimeReason,
} from '@/shared/agent-runtime';
import type { Prisma } from '@prisma-gen/client';
import { ledgerTransaction } from './agent-ledger-transaction';
import {
  eventEligibility,
  runtimeStateReason,
  runtimeTriggerInclude,
  sameRevisions,
  triggerRevisions,
  type RuntimeTrigger,
} from './agent-runtime-guards';

type Decision = Prisma.AgentEvaluationGetPayload<{ include: { event: true } }>;
type AdmissionContext = { requested: Decision; trigger: RuntimeTrigger };
type Owner = { owner: Decision; ownerTrigger: RuntimeTrigger };

async function admissionContext(
  tx: Prisma.TransactionClient,
  input: AgentAdmissionInput
): Promise<AdmissionContext | { reason: AgentRuntimeReason }> {
  const requested = await tx.agentEvaluation.findUnique({
    where: { id: input.evaluationId },
    include: { event: true },
  });
  if (!requested) {
    return { reason: 'NOT_FOUND' };
  }
  if (!sameRevisions(requested, input)) {
    return { reason: 'STALE_REVISION' };
  }
  if (requested.status !== 'MATCHED') {
    return { reason: 'NOT_MATCHED' };
  }
  const trigger = await tx.agentTrigger.findUnique({
    where: { id: requested.triggerId },
    include: runtimeTriggerInclude,
  });
  if (
    !trigger ||
    trigger.agentDefinitionId !== requested.agentDefinitionId ||
    trigger.connectionId !== requested.connectionId
  ) {
    return { reason: 'OWNERSHIP_MISMATCH' };
  }
  if (!sameRevisions(triggerRevisions(trigger), input)) {
    return { reason: 'STALE_REVISION' };
  }
  const unavailable =
    runtimeStateReason(trigger) ?? eventEligibility(trigger, requested.event, new Date());
  if (unavailable) {
    return { reason: unavailable };
  }
  return { requested, trigger };
}

async function firstMatchedEvaluation(
  tx: Prisma.TransactionClient,
  requested: Decision,
  trigger: RuntimeTrigger
): Promise<Owner | { reason: AgentRuntimeReason }> {
  // A caller cannot choose context by racing a later trigger's admission.
  const triggers = await tx.agentTrigger.findMany({
    where: {
      agentDefinitionId: requested.agentDefinitionId,
      connectionId: requested.connectionId,
      isEnabled: true,
      activationState: 'ACTIVE',
      id: { lte: requested.triggerId },
    },
    orderBy: { id: 'asc' },
    include: runtimeTriggerInclude,
  });
  for (const candidate of triggers) {
    const eligibility = eventEligibility(candidate, requested.event, new Date());
    if (eligibility === 'INVALID_STORED_DATA') {
      return { reason: eligibility };
    }
    if (eligibility) {
      continue;
    }
    const decision = await tx.agentEvaluation.findUnique({
      where: {
        eventId_triggerId_definitionRevision_triggerRevision_activationGeneration: {
          eventId: requested.eventId,
          triggerId: candidate.id,
          definitionRevision: requested.definitionRevision,
          triggerRevision: candidate.triggerRevision,
          activationGeneration: candidate.activationGeneration,
        },
      },
      include: { event: true },
    });
    if (!decision) {
      return { reason: 'EARLIER_EVALUATION_PENDING' };
    }
    if (decision.status === 'ERROR') {
      return { reason: 'EARLIER_EVALUATION_ERROR' };
    }
    if (decision.status === 'MATCHED') {
      return { owner: decision, ownerTrigger: candidate };
    }
  }
  return { owner: requested, ownerTrigger: trigger };
}

async function expireWaitingRuns(tx: Prisma.TransactionClient, agentDefinitionId: string) {
  const now = new Date();
  const expired = await tx.agentRun.findMany({
    where: { agentDefinitionId, status: 'QUEUED', expiresAt: { lte: now } },
    select: { id: true },
  });
  const ids = expired.map((run) => run.id);
  await tx.agentRun.updateMany({
    where: { id: { in: ids } },
    data: {
      status: 'CANCELLED',
      launchPhase: 'FINISHED',
      reasonCode: 'QUEUE_EXPIRED',
      completedAt: now,
    },
  });
  await tx.agentInitialDelivery.updateMany({
    where: { runId: { in: ids }, state: 'PENDING' },
    data: { state: 'FINISHED', finishedAt: now },
  });
}

async function admitRun(value: AgentAdmissionInput): Promise<AdmissionResult> {
  const input = agentAdmissionInputSchema.parse(value);
  return await ledgerTransaction(async (tx) => {
    const context = await admissionContext(tx, input);
    if ('reason' in context) {
      return { status: 'REJECTED', reason: context.reason };
    }
    const { requested, trigger } = context;
    const existing = await tx.agentRun.findUnique({
      where: {
        agentDefinitionId_eventId: {
          agentDefinitionId: requested.agentDefinitionId,
          eventId: requested.eventId,
        },
      },
    });
    if (existing) {
      await tx.agentEvaluation.update({
        where: { id: requested.id },
        data: { runId: existing.id },
      });
      return { status: 'COALESCED', runId: existing.id };
    }
    const overflowed = await tx.agentEvaluation.findFirst({
      where: {
        agentDefinitionId: requested.agentDefinitionId,
        eventId: requested.eventId,
        reasonCode: 'QUEUE_OVERFLOW',
      },
      select: { id: true },
    });
    if (overflowed) {
      await tx.agentEvaluation.update({
        where: { id: requested.id },
        data: {
          status: 'SKIPPED',
          reasonCode: 'QUEUE_OVERFLOW',
          explanation: 'This event already exceeded the waiting-run limit.',
        },
      });
      return { status: 'REJECTED', reason: 'QUEUE_OVERFLOW' };
    }
    const selected = await firstMatchedEvaluation(tx, requested, trigger);
    if ('reason' in selected) {
      return { status: 'DEFERRED', reason: selected.reason };
    }
    const { owner, ownerTrigger } = selected;
    const snapshot = agentEvaluationSnapshotSchema.safeParse(owner.configurationSnapshot);
    if (!snapshot.success || snapshot.data.input.eventId !== owner.eventId) {
      return { status: 'REJECTED', reason: 'INVALID_STORED_DATA' };
    }
    const limits = configService.getAgentRuntimeLimits();
    await expireWaitingRuns(tx, owner.agentDefinitionId);
    const waiting = await tx.agentRun.count({
      where: { agentDefinitionId: owner.agentDefinitionId, status: 'QUEUED' },
    });
    if (waiting >= limits.waitingPerDefinition) {
      await tx.agentEvaluation.updateMany({
        where: {
          agentDefinitionId: owner.agentDefinitionId,
          eventId: owner.eventId,
          status: 'MATCHED',
        },
        data: {
          status: 'SKIPPED',
          reasonCode: 'QUEUE_OVERFLOW',
          explanation: 'The waiting-run limit was reached.',
        },
      });
      return { status: 'REJECTED', reason: 'QUEUE_OVERFLOW' };
    }
    const initialMessageId = randomUUID();
    const run = await tx.agentRun.create({
      data: {
        agentDefinitionId: owner.agentDefinitionId,
        triggerId: ownerTrigger.id,
        eventId: owner.eventId,
        idempotencyKey: `event:${owner.eventId}`,
        // A launch continues the successful evaluation attempt; prior retries consume
        // the same end-to-end budget. The initial claim increments this counter.
        attemptCount: owner.attemptCount - 1,
        definitionRevision: owner.definitionRevision,
        triggerRevision: owner.triggerRevision,
        activationGeneration: owner.activationGeneration,
        definitionSnapshot: snapshot.data.definition,
        triggerSnapshot: snapshot.data.trigger,
        input: snapshot.data.input,
        reservedWorkspaceId: randomUUID(),
        reservedSessionId: randomUUID(),
        initialMessageId,
        expiresAt: new Date(Date.now() + limits.waitingExpiryMs),
        initialDelivery: { create: { sendAttemptId: randomUUID(), messageId: initialMessageId } },
      },
    });
    await tx.agentEvaluation.updateMany({
      where: {
        agentDefinitionId: owner.agentDefinitionId,
        eventId: owner.eventId,
        status: 'MATCHED',
      },
      data: { runId: run.id },
    });
    return { status: 'ADMITTED', runId: run.id };
  });
}

export const agentRunAccessor = { admitRun };
