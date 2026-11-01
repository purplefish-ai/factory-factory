import { z } from 'zod';
import { configService } from '@/backend/services/config.service';
import { eventLaunchPreparationSchema } from '@/shared/event-agent-preparation';
import type { Prisma } from '@prisma-gen/client';
import type { currentLaunch } from './agent-launch.accessor';

export const launchDispositionSchema = z.strictObject({
  kind: z.enum(['FAILED', 'TIMED_OUT', 'SHUTDOWN']),
  cleanup: z.enum(['CONFIRMED', 'UNKNOWN']),
  category: z.enum(['TRANSIENT', 'PERMANENT', 'UNKNOWN']),
  retryAfterMs: z.number().finite().nonnegative().optional(),
});
export type EventLaunchDisposition = z.infer<typeof launchDispositionSchema>;
type Run = Awaited<ReturnType<typeof currentLaunch>>;

export async function disposeLaunch(
  tx: Prisma.TransactionClient,
  run: Run,
  input: EventLaunchDisposition
) {
  const disposition = launchDispositionSchema.parse(input);
  const state = run.initialDelivery.state;
  if (state === 'FINISHED') {
    // A prompt outcome is not all-owned-work settlement. Task5 adopts this RUNNING record.
    await tx.agentRun.update({ where: { id: run.id }, data: { leaseExpiresAt: null } });
    return;
  }
  if (state !== 'PENDING') {
    await tx.agentInitialDelivery.update({
      where: { runId: run.id },
      data: { state: 'AMBIGUOUS' },
    });
    await tx.agentRun.update({
      where: { id: run.id },
      data: {
        launchPhase: 'NEEDS_ATTENTION',
        reasonCode: 'DELIVERY_UNCERTAIN',
        leaseExpiresAt: null,
      },
    });
    return;
  }
  const previous =
    run.launchPreparation === null
      ? null
      : eventLaunchPreparationSchema.parse(run.launchPreparation);
  const preparation = {
    version: 1,
    state: disposition.cleanup === 'CONFIRMED' ? 'SAFE' : 'UNKNOWN',
    setupStartedAt: previous?.setupStartedAt ?? null,
  } as const;
  const data: Prisma.AgentRunUpdateInput =
    disposition.cleanup === 'UNKNOWN'
      ? {
          launchPhase: 'NEEDS_ATTENTION',
          reasonCode: 'PREPARATION_CLEANUP_UNCERTAIN',
          nextAttemptAt: null,
        }
      : safeDisposition(run, disposition);
  await tx.agentRun.update({
    where: { id: run.id },
    data: { ...data, launchPreparation: preparation, leaseExpiresAt: null },
  });
}
function safeDisposition(
  run: Run,
  disposition: EventLaunchDisposition
): Prisma.AgentRunUpdateInput {
  if (disposition.kind === 'SHUTDOWN') {
    return {
      status: 'RUNNING',
      launchPhase: 'PROVISIONING',
      reasonCode: 'SHUTDOWN',
      nextAttemptAt: null,
    };
  }
  const delay = configService.getAgentRuntimeLimits().retryDelaysMs[run.attemptCount - 1];
  if (
    disposition.kind === 'FAILED' &&
    disposition.category === 'TRANSIENT' &&
    delay !== undefined
  ) {
    return {
      status: 'RUNNING',
      launchPhase: 'PROVISIONING',
      reasonCode: 'PROVISIONING_RETRY',
      nextAttemptAt: new Date(Date.now() + Math.max(delay, disposition.retryAfterMs ?? 0)),
    };
  }
  return {
    status: 'FAILED',
    launchPhase: 'FINISHED',
    reasonCode: disposition.kind === 'TIMED_OUT' ? 'SETUP_TIMEOUT' : 'PROVISIONING_FAILED',
    nextAttemptAt: null,
    completedAt: new Date(),
  };
}
