import { Prisma } from '@prisma-gen/client';

type Tx = Prisma.TransactionClient;

/** Cancels admitted-but-unclaimed runs; claimed runs keep their frozen settings and finish. */
export async function cancelQueuedRuns(tx: Tx, where: Prisma.AgentRunWhereInput) {
  const runs = await tx.agentRun.findMany({
    where: { ...where, status: 'QUEUED' },
    select: { id: true },
  });
  const ids = runs.map((run) => run.id);
  if (!ids.length) {
    return 0;
  }
  const now = new Date();
  await tx.agentRun.updateMany({
    where: { id: { in: ids }, status: 'QUEUED' },
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
  return ids.length;
}

/**
 * Pauses matching triggers: advances each activation generation, clears the
 * boundary and any pending activation, and cancels their unclaimed runs. The
 * new generation fences every earlier evaluation, admission and claim.
 */
export async function pauseTriggers(tx: Tx, where: Prisma.AgentTriggerWhereInput) {
  const triggers = await tx.agentTrigger.findMany({ where, select: { id: true } });
  const ids = triggers.map((trigger) => trigger.id);
  if (!ids.length) {
    return { pausedTriggerCount: 0, cancelledRunCount: 0 };
  }
  await tx.agentTrigger.updateMany({
    where: { id: { in: ids } },
    data: {
      isEnabled: false,
      activationState: 'PAUSED',
      activationGeneration: { increment: 1 },
      activationBoundary: Prisma.DbNull,
      pendingActivation: Prisma.DbNull,
      // Callers that pause because activation failed record their reason afterwards.
      pausedReasonCode: null,
    },
  });
  const cancelledRunCount = await cancelQueuedRuns(tx, { triggerId: { in: ids } });
  return { pausedTriggerCount: ids.length, cancelledRunCount };
}
