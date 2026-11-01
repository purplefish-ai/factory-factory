import { z } from 'zod';
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
import { Prisma } from '@prisma-gen/client';
import { ledgerTransaction } from './agent-ledger-transaction';
import {
  eventEligibility,
  permanentRuntimeStateReason,
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
  const unavailable =
    permanentRuntimeStateReason(trigger) ?? eventEligibility(trigger, run.event, now);
  if (unavailable) {
    return unavailable;
  }
  return validReservedIdentity(run) && validFrozenInput(run) ? null : 'INVALID_STORED_DATA';
}

let maintenanceCursor: string | null = null;

async function maintainInTransaction(tx: Prisma.TransactionClient, now: Date) {
  const take = configService.getAgentRuntimeLimits().queueBatchSize;
  let queued = await tx.agentRun.findMany({
    where: {
      status: 'QUEUED',
      eventId: { not: null },
      ...(maintenanceCursor ? { id: { gt: maintenanceCursor } } : {}),
    },
    orderBy: { id: 'asc' },
    take,
    include: { event: true, initialDelivery: true },
  });
  if (!queued.length && maintenanceCursor) {
    queued = await tx.agentRun.findMany({
      where: { status: 'QUEUED', eventId: { not: null } },
      orderBy: { id: 'asc' },
      take,
      include: { event: true, initialDelivery: true },
    });
  }
  for (const run of queued) {
    const invalid = await queueInvalidReason(tx, run, now);
    if (invalid) {
      await cancelQueued(tx, run.id, invalid, now);
    }
  }
  return queued.at(-1)?.id ?? null;
}
async function maintainQueue(now = new Date()) {
  const cursor = await ledgerTransaction((tx) => maintainInTransaction(tx, now));
  maintenanceCursor = cursor;
}

/** The serialized transition to RUNNING is the pause/launch linearization point. */
async function claimNextRun(now = new Date()): Promise<AgentClaimResult> {
  const committed = await ledgerTransaction(async (tx) => {
    const cursor = await maintainInTransaction(tx, now);
    const result = await claimInTransaction(tx, now);
    return { cursor, result };
  });
  maintenanceCursor = committed.cursor;
  return committed.result;
}
async function claimInTransaction(
  tx: Prisma.TransactionClient,
  now: Date
): Promise<AgentClaimResult> {
  const limits = configService.getAgentRuntimeLimits();
  const active = await tx.agentRun.groupBy({
    by: ['agentDefinitionId'],
    where: { status: 'RUNNING' },
    _count: true,
  });
  const totalActive = active.reduce((sum, row) => sum + row._count, 0);
  if (totalActive >= limits.activeGlobal) {
    return { status: 'DEFERRED', reason: 'CAPACITY' };
  }
  // Filter temporary eligibility BEFORE the bounded page so deferred heads
  // cannot hide ready definitions. The FIFO check still sees every older run.
  const blocked = active
    .filter((row) => row._count >= limits.activePerDefinition)
    .map((row) => row.agentDefinitionId);
  const excluded = blocked.length
    ? Prisma.sql`AND r.agentDefinitionId NOT IN (${Prisma.join(blocked)})`
    : Prisma.empty;
  const heads = z.array(z.object({ id: z.string() })).parse(
    await tx.$queryRaw`
      SELECT r.id FROM AgentRun r
      JOIN AgentTrigger t ON t.id = r.triggerId
      JOIN AgentConnection c ON c.id = t.connectionId
      JOIN AgentSourceState s ON s.connectionId = c.id
      WHERE r.status = 'QUEUED' AND r.eventId IS NOT NULL
        AND t.type != 'SCHEDULE' AND t.isEnabled = 1 AND t.activationState = 'ACTIVE'
        AND c.isEnabled = 1 AND s.isReady = 1 ${excluded}
        AND (r.nextAttemptAt IS NULL OR r.nextAttemptAt <= ${now})
        AND (r.expiresAt IS NULL OR r.expiresAt > ${now})
        AND NOT EXISTS (SELECT 1 FROM AgentRun older WHERE older.agentDefinitionId = r.agentDefinitionId
          AND older.status = 'QUEUED' AND older.eventId IS NOT NULL
          AND (older.createdAt < r.createdAt OR (older.createdAt = r.createdAt AND older.id < r.id)))
      ORDER BY r.createdAt, r.id LIMIT ${limits.queueBatchSize}`
  );
  const queued = await tx.agentRun.findMany({
    where: {
      id: { in: heads.map((run) => run.id) },
      status: 'QUEUED',
      eventId: { not: null },
      agentDefinitionId: { notIn: blocked },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      AND: [{ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }],
      trigger: {
        type: { not: 'SCHEDULE' },
        isEnabled: true,
        activationState: 'ACTIVE',
        connection: { isEnabled: true, sourceState: { isReady: true } },
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limits.queueBatchSize,
    include: { event: true, initialDelivery: true },
  });
  for (const run of queued) {
    const invalid = await queueInvalidReason(tx, run, now);
    if (invalid) {
      await cancelQueued(tx, run.id, invalid, now);
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
  const waiting = await tx.agentRun.findFirst({
    where: { status: 'QUEUED', eventId: { not: null } },
    select: { id: true },
  });
  if (!waiting) {
    return { status: 'DEFERRED', reason: 'EMPTY' };
  }
  const unsaturated = await tx.agentRun.findFirst({
    where: { status: 'QUEUED', eventId: { not: null }, agentDefinitionId: { notIn: blocked } },
    select: { id: true },
  });
  return { status: 'DEFERRED', reason: unsaturated ? 'WAITING' : 'CAPACITY' };
}
export const agentRunClaimAccessor = { claimNextRun, maintainQueue };
