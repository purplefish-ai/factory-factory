import { configService } from '@/backend/services/config.service';
import { SERVICE_TIMEOUT_MS } from '@/backend/services/constants';
import { eventLaunchPreparationSchema } from '@/shared/event-agent-preparation';
import type { Prisma } from '@prisma-gen/client';
import type { EventLaunchClaim } from './agent-execution-binding.accessor';
import { disposeLaunch, type EventLaunchDisposition } from './agent-launch-disposition';
import { currentLaunch, launchSnapshot } from './agent-launch.accessor';
import { ledgerTransaction } from './agent-ledger-transaction';

const include = {
  initialDelivery: true,
  agentDefinition: { select: { projectId: true } },
} as const;
type Run = Prisma.AgentRunGetPayload<{ include: typeof include }>;
let cursor: string | null = null;
function snapshot(run: Run) {
  if (!run.initialDelivery) {
    throw new Error('Event initial delivery is missing');
  }
  return launchSnapshot({ ...run, initialDelivery: run.initialDelivery });
}
function lease() {
  return new Date(Date.now() + SERVICE_TIMEOUT_MS.agentLaunchLease);
}
async function takeOwnership(tx: Prisma.TransactionClient, run: Run, retry: boolean) {
  return snapshot(
    await tx.agentRun.update({
      where: { id: run.id },
      data: {
        workerGeneration: { increment: 1 },
        leaseExpiresAt: lease(),
        ...(retry ? { attemptCount: { increment: 1 }, nextAttemptAt: null } : {}),
      },
      include,
    })
  );
}
async function holdRecovery(tx: Prisma.TransactionClient, run: Run) {
  const preparation = eventLaunchPreparationSchema.safeParse(run.launchPreparation);
  const sent = run.initialDelivery?.state !== 'PENDING';
  if (sent && run.initialDelivery?.state === 'FINISHED') {
    await tx.agentRun.update({ where: { id: run.id }, data: { launchPhase: 'ACTIVE' } });
    return;
  }
  if (sent && run.initialDelivery) {
    await tx.agentInitialDelivery.update({
      where: { runId: run.id },
      data: { state: 'AMBIGUOUS' },
    });
  }
  await tx.agentRun.update({
    where: { id: run.id },
    data: {
      workerGeneration: { increment: 1 },
      leaseExpiresAt: null,
      launchPhase: 'NEEDS_ATTENTION',
      reasonCode: sent ? 'DELIVERY_UNCERTAIN' : 'PREPARATION_CLEANUP_UNCERTAIN',
      ...(!sent
        ? {
            launchPreparation: {
              version: 1,
              state: 'UNKNOWN',
              setupStartedAt: preparation.success ? preparation.data.setupStartedAt : null,
            },
          }
        : {}),
    },
  });
}
function isSafe(run: Run) {
  if (run.initialDelivery?.state !== 'PENDING') {
    return false;
  }
  if (run.launchPreparation === null) {
    return true;
  }
  const preparation = eventLaunchPreparationSchema.safeParse(run.launchPreparation);
  return preparation.success && preparation.data.state === 'SAFE';
}
async function recoverOne(tx: Prisma.TransactionClient, run: Run) {
  if (!isSafe(run)) {
    await holdRecovery(tx, run);
    return null;
  }
  try {
    snapshot(run);
  } catch {
    await tx.agentRun.update({
      where: { id: run.id },
      data: {
        workerGeneration: { increment: 1 },
        leaseExpiresAt: null,
        launchPhase: 'NEEDS_ATTENTION',
        reasonCode: 'INVALID_STORED_DATA',
      },
    });
    return null;
  }
  return takeOwnership(tx, run, run.nextAttemptAt !== null);
}
async function recoveryPage(tx: Prisma.TransactionClient, excluded: string[]) {
  const now = new Date();
  const where: Prisma.AgentRunWhereInput = {
    status: 'RUNNING',
    launchPhase: { in: ['PROVISIONING', 'READY', 'DISPATCHING'] },
    id: { notIn: excluded },
    OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    AND: [{ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }],
  };
  const take = configService.getAgentRuntimeLimits().queueBatchSize;
  const rows = await tx.agentRun.findMany({
    where: { ...where, ...(cursor ? { id: { notIn: excluded, gt: cursor } } : {}) },
    orderBy: { id: 'asc' },
    take,
    include,
  });
  return !rows.length && cursor
    ? tx.agentRun.findMany({ where, orderBy: { id: 'asc' }, take, include })
    : rows;
}
export const agentLaunchRecoveryAccessor = {
  /** Observation takeover never creates a new send attempt or spends provisioning budget. */
  adopt: (claim: EventLaunchClaim) =>
    ledgerTransaction(async (tx) => {
      const run = await currentLaunch(tx, claim, 'EXPIRED');
      snapshot(run);
      return takeOwnership(tx, run, false);
    }),
  renew: (claim: EventLaunchClaim) =>
    ledgerTransaction(async (tx) => {
      const run = await currentLaunch(tx, claim);
      const leaseExpiresAt = lease();
      await tx.agentRun.update({ where: { id: run.id }, data: { leaseExpiresAt } });
      return leaseExpiresAt;
    }),
  dispose: (claim: EventLaunchClaim, input: EventLaunchDisposition, assertCurrent?: () => void) => {
    assertCurrent?.();
    return ledgerTransaction(async (tx) => {
      const run = await currentLaunch(tx, claim);
      assertCurrent?.();
      await disposeLaunch(tx, run, input);
      assertCurrent?.();
    });
  },
  /** Includes held and ACTIVE/FINISHED records for the Task5 observation owner. */
  list: (after?: string) =>
    ledgerTransaction(async (tx) => {
      const rows = await tx.agentRun.findMany({
        where: { status: 'RUNNING', ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' },
        take: configService.getAgentRuntimeLimits().queueBatchSize,
        include,
      });
      const runs: ReturnType<typeof snapshot>[] = [];
      const invalid: Array<{
        runId: string;
        workerGeneration: number;
        attemptGeneration: number;
        reason: 'INVALID_STORED_DATA';
      }> = [];
      for (const run of rows) {
        try {
          runs.push(snapshot(run));
        } catch {
          invalid.push({
            runId: run.id,
            workerGeneration: run.workerGeneration,
            attemptGeneration: run.attemptGeneration,
            reason: 'INVALID_STORED_DATA',
          });
        }
      }
      return { runs, invalid, nextCursor: rows.at(-1)?.id ?? null };
    }),
  recover: async (excluded: string[], available: number) => {
    const committed = await ledgerTransaction(async (tx) => {
      const rows = await recoveryPage(tx, excluded);
      const claims: ReturnType<typeof launchSnapshot>[] = [];
      const limit = Math.max(
        0,
        Math.min(available, configService.getAgentRuntimeLimits().activeGlobal)
      );
      let inspected: string | null = null;
      for (const run of rows) {
        if (claims.length >= limit) {
          break;
        }
        const claim = await recoverOne(tx, run);
        inspected = run.id;
        if (claim) {
          claims.push(claim);
        }
      }
      return { claims, cursor: inspected };
    });
    cursor = committed.cursor;
    return committed.claims;
  },
};
