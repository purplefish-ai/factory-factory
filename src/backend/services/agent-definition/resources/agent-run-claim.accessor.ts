import { configService } from '@/backend/services/config.service';
import { SERVICE_TIMEOUT_MS } from '@/backend/services/constants';
import {
  agentClaimResultSchema,
  agentResolvedExecutionConfigSchema,
  type AgentClaimResult,
  type AgentRuntimeReason,
} from '@/shared/agent-runtime';
import {
  agentDefinitionInputSchema,
  agentRunInputSchema,
  agentTriggerInputSchema,
} from '@/shared/schemas/agent-definition.schema';
import type { Prisma } from '@prisma-gen/client';
import { ledgerTransaction } from './agent-ledger-transaction';
import {
  eventEligibility,
  runtimeStateReason,
  runtimeTriggerInclude,
  sameRevisions,
  triggerRevisions,
} from './agent-runtime-guards';

type QueuedRun = Prisma.AgentRunGetPayload<{ include: { event: true; initialDelivery: true } }>;

async function cancelQueued(
  tx: Prisma.TransactionClient,
  runId: string,
  reasonCode: AgentRuntimeReason,
  now: Date
) {
  await tx.agentRun.update({
    where: { id: runId },
    data: {
      status: 'CANCELLED',
      launchPhase: 'FINISHED',
      reasonCode,
      completedAt: now,
    },
  });
  await tx.agentInitialDelivery.updateMany({
    where: { runId, state: 'PENDING' },
    data: { state: 'FINISHED', finishedAt: now },
  });
}

function validReservedIdentity(run: QueuedRun) {
  return (
    run.reservedWorkspaceId &&
    run.reservedSessionId &&
    run.initialMessageId &&
    run.initialDelivery?.state === 'PENDING' &&
    run.initialDelivery.attemptGeneration === run.attemptGeneration &&
    run.initialDelivery.messageId === run.initialMessageId
  );
}
function validFrozenInput(run: QueuedRun) {
  const definition = agentDefinitionInputSchema.safeParse(run.definitionSnapshot);
  const settings = agentTriggerInputSchema.safeParse(run.triggerSnapshot);
  const input = agentRunInputSchema.safeParse(run.input);
  return (
    definition.success &&
    settings.success &&
    input.success &&
    agentResolvedExecutionConfigSchema.safeParse(definition.data.executionConfig).success &&
    input.data.eventId === run.eventId
  );
}
async function queueInvalidReason(
  tx: Prisma.TransactionClient,
  run: QueuedRun,
  now: Date
): Promise<AgentRuntimeReason | null> {
  if (run.expiresAt && run.expiresAt <= now) {
    return 'QUEUE_EXPIRED';
  }
  const trigger = run.triggerId
    ? await tx.agentTrigger.findUnique({
        where: { id: run.triggerId },
        include: runtimeTriggerInclude,
      })
    : null;
  if (
    !(trigger && run.event) ||
    trigger.agentDefinitionId !== run.agentDefinitionId ||
    trigger.connectionId !== run.event.connectionId
  ) {
    return 'OWNERSHIP_MISMATCH';
  }
  if (!sameRevisions(triggerRevisions(trigger), run)) {
    return 'STALE_REVISION';
  }
  const unavailable = runtimeStateReason(trigger) ?? eventEligibility(trigger, run.event, now);
  if (unavailable) {
    return unavailable;
  }
  return validReservedIdentity(run) && validFrozenInput(run) ? null : 'INVALID_STORED_DATA';
}

/** The serialized transition to RUNNING is the pause/launch linearization point. */
function claimNextRun(): Promise<AgentClaimResult> {
  return ledgerTransaction(async (tx) => {
    const now = new Date();
    const limits = configService.getAgentRuntimeLimits();
    const queued = await tx.agentRun.findMany({
      where: { status: 'QUEUED', eventId: { not: null } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { event: true, initialDelivery: true },
    });
    const active = await tx.agentRun.groupBy({
      by: ['agentDefinitionId'],
      where: { status: 'RUNNING' },
      _count: true,
    });
    const totalActive = active.reduce((sum, row) => sum + row._count, 0);
    const byDefinition = new Map(active.map((row) => [row.agentDefinitionId, row._count]));
    let capacityBlocked = false;
    for (const run of queued) {
      const invalid = await queueInvalidReason(tx, run, now);
      if (invalid) {
        await cancelQueued(tx, run.id, invalid, now);
        continue;
      }
      if (
        totalActive >= limits.activeGlobal ||
        (byDefinition.get(run.agentDefinitionId) ?? 0) >= limits.activePerDefinition
      ) {
        capacityBlocked = true;
        continue;
      }
      const claimed = await tx.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'RUNNING',
          launchPhase: 'PROVISIONING',
          startedAt: now,
          workerGeneration: { increment: 1 },
          attemptCount: { increment: 1 },
          leaseExpiresAt: new Date(now.getTime() + SERVICE_TIMEOUT_MS.agentLaunchLease),
        },
      });
      // queueInvalidReason established these once-reserved identities before the claim.
      return agentClaimResultSchema.parse({
        status: 'CLAIMED',
        runId: run.id,
        workerGeneration: claimed.workerGeneration,
        attemptGeneration: run.attemptGeneration,
        reservedWorkspaceId: run.reservedWorkspaceId,
        reservedSessionId: run.reservedSessionId,
        initialMessageId: run.initialMessageId,
      });
    }
    return { status: 'DEFERRED', reason: capacityBlocked ? 'CAPACITY' : 'EMPTY' };
  });
}

export const agentRunClaimAccessor = { claimNextRun };
