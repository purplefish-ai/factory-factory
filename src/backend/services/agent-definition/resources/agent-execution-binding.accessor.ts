import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import {
  agentClaimResultSchema,
  agentResolvedExecutionConfigSchema,
  type AgentClaimResult,
} from '@/shared/agent-runtime';
import { eventAgentExecutionSchema, type EventAgentExecution } from '@/shared/event-agent-launch';
import { agentDefinitionInputSchema } from '@/shared/schemas/agent-definition.schema';
import type { Prisma } from '@prisma-gen/client';
import { ledgerTransaction } from './agent-ledger-transaction';

export type EventLaunchClaim = Extract<AgentClaimResult, { status: 'CLAIMED' }>;
export type FreezeEventExecutionInput = {
  claim: EventLaunchClaim;
  sendAttemptId: string;
  messageId: string;
  execution: EventAgentExecution;
};
const claimSchema = agentClaimResultSchema.options[0];
const freezeSchema = z.strictObject({
  claim: claimSchema,
  sendAttemptId: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
  execution: eventAgentExecutionSchema,
});
async function currentRun(tx: Prisma.TransactionClient, claim: EventLaunchClaim) {
  const run = await tx.agentRun.findUnique({
    where: { id: claim.runId },
    include: { initialDelivery: true },
  });
  if (
    run?.status !== 'RUNNING' ||
    !['PROVISIONING', 'READY'].includes(run.launchPhase) ||
    run.workerGeneration !== claim.workerGeneration ||
    run.attemptGeneration !== claim.attemptGeneration ||
    run.reservedWorkspaceId !== claim.reservedWorkspaceId ||
    run.reservedSessionId !== claim.reservedSessionId ||
    run.initialMessageId !== claim.initialMessageId ||
    !run.leaseExpiresAt ||
    run.leaseExpiresAt <= new Date()
  ) {
    throw new ApplicationError('CONFLICT', 'Event launch claim is no longer current');
  }
  const delivery = run.initialDelivery;
  if (
    delivery?.state !== 'PENDING' ||
    delivery.attemptGeneration !== claim.attemptGeneration ||
    (claim.attemptGeneration === 1 && delivery.messageId !== claim.initialMessageId)
  ) {
    throw new ApplicationError('CONFLICT', 'Event launch requires the current pending delivery');
  }
  return { run, delivery };
}
function readExecution(value: unknown) {
  return value === null ? null : eventAgentExecutionSchema.parse(value);
}
export const agentExecutionBindingAccessor = {
  read(claimInput: EventLaunchClaim) {
    const claim = claimSchema.parse(claimInput);
    return ledgerTransaction(async (tx) => {
      const { run, delivery } = await currentRun(tx, claim);
      return {
        execution: readExecution(run.effectiveExecution),
        sendAttemptId: delivery.sendAttemptId,
        messageId: delivery.messageId,
      };
    });
  },
  freeze(input: FreezeEventExecutionInput) {
    const data = freezeSchema.parse(input);
    return ledgerTransaction(async (tx) => {
      const { run, delivery } = await currentRun(tx, data.claim);
      if (delivery.sendAttemptId !== data.sendAttemptId || delivery.messageId !== data.messageId) {
        throw new ApplicationError('CONFLICT', 'Event send attempt is no longer current');
      }
      const admitted = agentResolvedExecutionConfigSchema.parse(
        agentDefinitionInputSchema.parse(run.definitionSnapshot).executionConfig
      );
      if (
        data.execution.provider !== admitted.provider ||
        data.execution.model !== admitted.model ||
        data.execution.reasoningEffort !== (admitted.reasoningEffort ?? null)
      ) {
        throw new ApplicationError(
          'CONFLICT',
          'Effective execution must preserve admitted provider, model and effort'
        );
      }
      const frozen = readExecution(run.effectiveExecution);
      if (frozen) {
        if (!isDeepStrictEqual(frozen, data.execution)) {
          throw new ApplicationError('CONFLICT', 'Event execution binding is already frozen');
        }
        return frozen;
      }
      // The SQLite write lock serializes this CAS with claim/takeover and attempt changes.
      await tx.agentRun.update({
        where: {
          id: run.id,
          workerGeneration: data.claim.workerGeneration,
          attemptGeneration: data.claim.attemptGeneration,
        },
        data: { effectiveExecution: data.execution },
      });
      return data.execution;
    });
  },
};
