import { isDeepStrictEqual } from 'node:util';
import { prisma } from '@/backend/db';
import { configService } from '@/backend/services/config.service';
import {
  expiredAgentRunContextSchema,
  retainedAgentRunContextSchema,
  type InspectAgentRunContextsInput,
} from '@/shared/agent-run-context';
import { agentRunResultSchema } from '@/shared/agent-runtime';
import {
  initialDeliveryEvidenceSchema,
  type InitialDeliveryEvidence,
} from '@/shared/event-agent-delivery';
import { eventAgentExecutionSchema } from '@/shared/event-agent-launch';
import { eventLaunchPreparationSchema } from '@/shared/event-agent-preparation';
import { Prisma } from '@prisma-gen/client';
import type { RetentionBatch } from './agent-ledger-retention.accessor';
import { ledgerTransaction } from './agent-ledger-transaction';
import {
  retentionDependency,
  validRetentionEvaluation,
  type RetentionReason,
} from './agent-retention-dependencies';
import {
  childHistoryIsClear,
  hasChildWork,
  hasStoppedRunWork,
} from './agent-run-settlement.accessor';

const include = {
  initialDelivery: true,
  event: true,
  agentDefinition: { select: { projectId: true } },
} as const;
type Run = Prisma.AgentRunGetPayload<{ include: typeof include }>;

function contextDependency(run: Run): RetentionReason | null {
  if (!['COMPLETED', 'PR_CREATED', 'FAILED', 'CANCELLED'].includes(run.status)) {
    return 'ACTIVE_RUN';
  }
  if (run.launchPhase !== 'FINISHED' || run.nextAttemptAt || run.leaseExpiresAt) {
    return 'RECOVERY_DEPENDENCY';
  }
  return storedContextDependency(run) ?? deliveryDependency(run);
}

function storedContextDependency(run: Run): RetentionReason | null {
  const context = retainedAgentRunContextSchema.safeParse(run);
  if (
    !context.success ||
    (run.eventId !== null && context.data.input.eventId !== run.eventId) ||
    (run.triggerId === null) !== (context.data.triggerSnapshot === null) ||
    (run.result !== null && !agentRunResultSchema.safeParse(run.result).success) ||
    (run.effectiveExecution !== null &&
      !eventAgentExecutionSchema.safeParse(run.effectiveExecution).success)
  ) {
    return 'INVALID_STORED_DATA';
  }
  return null;
}

function deliveryDependency(run: Run): RetentionReason | null {
  const preparation =
    run.launchPreparation === null
      ? null
      : eventLaunchPreparationSchema.safeParse(run.launchPreparation);
  if (preparation && !preparation.success) {
    return 'INVALID_STORED_DATA';
  }
  if (preparation?.success && ['UNKNOWN', 'SETUP'].includes(preparation.data.state)) {
    return 'RECOVERY_DEPENDENCY';
  }
  const delivery = run.initialDelivery;
  if (!delivery || delivery.attemptGeneration !== run.attemptGeneration) {
    return 'RECOVERY_DEPENDENCY';
  }
  if (delivery.evidence === null) {
    return unsentDependency(run);
  }
  const evidence = initialDeliveryEvidenceSchema.safeParse(delivery.evidence);
  if (!evidence.success) {
    return 'INVALID_STORED_DATA';
  }
  const proof = evidence.data;
  const attempt = {
    runId: run.id,
    sessionId: run.reservedSessionId,
    workerGeneration: run.workerGeneration,
    attemptGeneration: run.attemptGeneration,
    messageId: delivery.messageId,
    sendAttemptId: delivery.sendAttemptId,
  };
  if (!isDeepStrictEqual({ ...proof.attempt, workerGeneration: run.workerGeneration }, attempt)) {
    return 'INVALID_STORED_DATA';
  }
  return settledProofDependency(proof, delivery.state);
}

function settledProofDependency(
  proof: InitialDeliveryEvidence,
  state: string
): RetentionReason | null {
  if (state !== 'FINISHED' && proof.resolution?.action !== 'ABANDON') {
    return 'RECOVERY_DEPENDENCY';
  }
  if (!(proof.source && proof.work)) {
    return 'RECOVERY_DEPENDENCY';
  }
  if (
    !isDeepStrictEqual(proof.source, proof.work.source) ||
    (proof.outcome && !isDeepStrictEqual(proof.source, proof.outcome.source))
  ) {
    return 'INVALID_STORED_DATA';
  }
  if (!(proof.outcome || proof.resolution?.action === 'ABANDON')) {
    return 'RECOVERY_DEPENDENCY';
  }
  if (proof.resolution?.action === 'ABANDON' && !validAbandonment(proof)) {
    return 'RECOVERY_DEPENDENCY';
  }
  if (proof.outcome?.result !== 'COMPLETED' && !hasStoppedRunWork(proof, proof.work)) {
    return 'RECOVERY_DEPENDENCY';
  }
  return null;
}

function validAbandonment(proof: InitialDeliveryEvidence) {
  const resolution = proof.resolution;
  return !!(
    resolution &&
    proof.work &&
    hasStoppedRunWork(proof, proof.work) &&
    isDeepStrictEqual(
      { ...resolution.attempt, workerGeneration: proof.attempt.workerGeneration },
      proof.attempt
    ) &&
    isDeepStrictEqual(resolution.work, proof.work) &&
    isDeepStrictEqual(resolution.stop, proof.stop)
  );
}

function unsentDependency(run: Run): RetentionReason | null {
  const delivery = run.initialDelivery;
  if (!delivery) {
    return 'RECOVERY_DEPENDENCY';
  }
  const preparation = eventLaunchPreparationSchema.safeParse(run.launchPreparation);
  // A terminal unsent cancellation/setup failure can have no provider evidence.
  return !(
    ['PENDING', 'FINISHED'].includes(delivery.state) && ['CANCELLED', 'FAILED'].includes(run.status)
  ) ||
    (run.workerGeneration > 0 && (!preparation.success || preparation.data.state !== 'SAFE')) ||
    delivery.sendingAt ||
    delivery.acceptedAt ||
    delivery.providerTurnId
    ? 'RECOVERY_DEPENDENCY'
    : null;
}

async function dependency(
  tx: Prisma.TransactionClient,
  run: Run,
  limit: number,
  assertCurrent: () => void
): Promise<RetentionReason | null> {
  const reason = contextDependency(run);
  if (reason) {
    return reason;
  }
  // Prisma reads SQL NULL and JSON null as JS null. Only SQL NULL means absent
  // optional context/control evidence; a persisted JSON null is malformed proof.
  const malformedNull = await tx.agentRun.findFirst({
    where: {
      id: run.id,
      OR: [
        { launchPreparation: { equals: Prisma.JsonNull } },
        { effectiveExecution: { equals: Prisma.JsonNull } },
        { result: { equals: Prisma.JsonNull } },
        { triggerSnapshot: { equals: Prisma.JsonNull } },
        { initialDelivery: { is: { evidence: { equals: Prisma.JsonNull } } } },
      ],
    },
    select: { id: true },
  });
  assertCurrent();
  if (malformedNull) {
    return 'INVALID_STORED_DATA';
  }
  if (run.event) {
    const eventReason = await retentionDependency(tx, run.event, false, assertCurrent, limit);
    assertCurrent();
    if (eventReason) {
      return eventReason;
    }
  }
  const childHold =
    run.initialDelivery?.evidence !== null
      ? !(await childHistoryIsClear(tx, run))
      : run.reservedWorkspaceId && (await hasChildWork(tx, run.reservedWorkspaceId));
  assertCurrent();
  if (childHold) {
    return 'RECOVERY_DEPENDENCY';
  }
  const evaluations = await tx.agentEvaluation.findMany({
    where: { runId: run.id },
    include: { run: { select: { agentDefinitionId: true, eventId: true } } },
    take: limit + 1,
  });
  assertCurrent();
  if (evaluations.length > limit) {
    return 'DEPENDENCY_LIMIT';
  }
  return evaluations.some((row) => !validRetentionEvaluation(row, row.run))
    ? 'INVALID_STORED_DATA'
    : null;
}

export type RunContextInspection = {
  retentionDays: number | null;
  policySource: 'CONFIGURED' | 'PREVIEW';
  cursor: string | null;
  inspected: number;
  eligible: number;
  retained: Partial<Record<RetentionReason, number>>;
  /** Logical UTF-8 snapshot JSON plus diagnostic text; excludes DB/file overhead. */
  byteImpact: {
    inspected: number;
    eligibleBefore: number;
    eligibleAfter: number;
    eligibleDelta: number;
  };
};

function contextBytes(run: Run) {
  return (
    [run.definitionSnapshot, run.triggerSnapshot, run.input].reduce<number>(
      (bytes, value) => bytes + (value === null ? 0 : Buffer.byteLength(JSON.stringify(value))),
      0
    ) + Buffer.byteLength(run.errorMessage ?? '')
  );
}

function recordByteImpact(
  report: RunContextInspection,
  run: Run,
  eligible: boolean,
  expired: ReturnType<typeof expiredAgentRunContextSchema.parse>
) {
  const beforeBytes = contextBytes(run);
  report.byteImpact.inspected += beforeBytes;
  if (eligible) {
    report.byteImpact.eligibleBefore += beforeBytes;
    report.byteImpact.eligibleAfter += 3 * Buffer.byteLength(JSON.stringify(expired));
  }
}

async function inspectPage(
  tx: Prisma.TransactionClient,
  cursor: string | null,
  prospectiveDays: number | undefined,
  assertCurrent: () => void,
  measureBytes: boolean
) {
  assertCurrent();
  // Pruning calls this only after the ledger write lock. Inspection uses a read snapshot.
  const limits = configService.getAgentRuntimeLimits();
  const retentionMs =
    prospectiveDays === undefined ? limits.runContextRetentionMs : prospectiveDays * 86_400_000;
  const now = new Date();
  const expired = expiredAgentRunContextSchema.parse({
    version: 1,
    state: 'EXPIRED',
    expiredAt: now.toISOString(),
  });
  const report: RunContextInspection = {
    retentionDays: retentionMs === null ? null : retentionMs / 86_400_000,
    policySource: prospectiveDays === undefined ? 'CONFIGURED' : 'PREVIEW',
    cursor,
    inspected: 0,
    eligible: 0,
    retained: {},
    byteImpact: { inspected: 0, eligibleBefore: 0, eligibleAfter: 0, eligibleDelta: 0 },
  };
  const eligibleRows: Run[] = [];
  if (retentionMs === null) {
    return { report, eligibleRows, expired, now };
  }
  const where = {
    contextExpiredAt: null,
    completedAt: { lte: new Date(now.getTime() - retentionMs) },
  };
  const page = (after: string | null) =>
    tx.agentRun.findMany({
      where: { ...where, ...(after ? { id: { gt: after } } : {}) },
      include,
      orderBy: { id: 'asc' },
      take: limits.queueBatchSize,
    });
  let rows = await page(cursor);
  assertCurrent();
  if (!rows.length && cursor) {
    rows = await page(null);
    assertCurrent();
  }
  report.cursor = rows.at(-1)?.id ?? null;
  report.inspected = rows.length;
  for (const run of rows) {
    const reason = await dependency(tx, run, limits.queueBatchSize, assertCurrent);
    assertCurrent();
    if (reason) {
      report.retained[reason] = (report.retained[reason] ?? 0) + 1;
    } else {
      eligibleRows.push(run);
      report.eligible++;
    }
    if (measureBytes) {
      recordByteImpact(report, run, reason === null, expired);
    }
  }
  report.byteImpact.eligibleDelta =
    report.byteImpact.eligibleAfter - report.byteImpact.eligibleBefore;
  assertCurrent();
  return { report, eligibleRows, expired, now };
}

export const agentRunContextRetentionAccessor = {
  /** Advisory read snapshot: no write statement, policy changes or maintenance cursor updates. */
  inspectBatch(
    input: InspectAgentRunContextsInput,
    assertCurrent: () => void
  ): Promise<RunContextInspection> {
    return prisma.$transaction(async (tx) => {
      const { report } = await inspectPage(
        tx,
        input.after ?? null,
        input.retentionDays,
        assertCurrent,
        true
      );
      assertCurrent();
      return report;
    });
  },
  pruneBatch(cursor: string | null, assertCurrent: () => void): Promise<RetentionBatch> {
    return ledgerTransaction(async (tx) => {
      const { report, eligibleRows, expired, now } = await inspectPage(
        tx,
        cursor,
        undefined,
        assertCurrent,
        false
      );
      const batch: RetentionBatch = {
        kind: 'runContext',
        cursor: report.cursor,
        inspected: report.inspected,
        changed: 0,
        retained: report.retained,
      };
      for (const run of eligibleRows) {
        assertCurrent();
        await tx.agentRun.update({
          where: { id: run.id },
          data: {
            contextExpiredAt: now,
            definitionSnapshot: expired,
            triggerSnapshot: expired,
            input: expired,
            errorMessage: null,
          },
        });
        assertCurrent();
        batch.changed++;
      }
      assertCurrent();
      return batch;
    });
  },
};
