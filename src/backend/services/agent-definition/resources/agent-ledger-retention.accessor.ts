import { configService } from '@/backend/services/config.service';
import { type AgentEvent, Prisma } from '@prisma-gen/client';
import { agentEventAccessor } from './agent-event.accessor';
import { ledgerTransaction } from './agent-ledger-transaction';
import {
  retentionDependency,
  validRetentionEvaluation,
  type RetentionReason,
} from './agent-retention-dependencies';

export type RetentionKind = 'evaluation' | 'payload' | 'identity';
export type RetentionBatch = {
  kind: RetentionKind;
  cursor: string | null;
  inspected: number;
  changed: number;
  retained: Partial<Record<RetentionReason, number>>;
};
const runInclude = { run: { select: { agentDefinitionId: true, eventId: true } } } as const;
type Candidate =
  | AgentEvent
  | Prisma.AgentEvaluationGetPayload<{ include: typeof runInclude & { event: true } }>;

async function candidates(
  tx: Prisma.TransactionClient,
  kind: RetentionKind,
  after: string | null,
  now: Date,
  take: number
): Promise<Candidate[]> {
  const id = after ? { id: { gt: after } } : {};
  if (kind === 'evaluation') {
    return await tx.agentEvaluation.findMany({
      where: { expiresAt: { lte: now }, ...id },
      orderBy: { id: 'asc' },
      take,
      include: { event: true, ...runInclude },
    });
  }
  return await tx.agentEvent.findMany({
    where: {
      ...(kind === 'identity'
        ? { identityExpiresAt: { lte: now } }
        : { payloadExpiresAt: { lte: now }, payload: { not: Prisma.DbNull } }),
      ...id,
    },
    orderBy: { id: 'asc' },
    take,
  });
}

async function remainingDependency(
  tx: Prisma.TransactionClient,
  kind: RetentionKind,
  eventId: string,
  limit: number,
  assertCurrent: () => void
): Promise<RetentionReason | null> {
  if (kind === 'identity') {
    const remaining = await tx.agentEvaluation.findFirst({
      where: { eventId },
      select: { id: true },
    });
    assertCurrent();
    return remaining ? 'EVALUATIONS_REMAIN' : null;
  }
  if (kind === 'payload') {
    const remaining = await tx.agentEvaluation.findMany({
      where: { eventId },
      take: limit + 1,
      orderBy: { id: 'asc' },
      include: runInclude,
    });
    assertCurrent();
    if (remaining.length > limit) {
      return 'DEPENDENCY_LIMIT';
    }
    if (remaining.some((evaluation) => !validRetentionEvaluation(evaluation, evaluation.run))) {
      return 'INVALID_STORED_DATA';
    }
  }
  return null;
}

async function pruneCandidate(
  tx: Prisma.TransactionClient,
  kind: RetentionKind,
  candidate: Candidate,
  limit: number,
  assertCurrent: () => void
): Promise<RetentionReason | null> {
  const event = 'event' in candidate ? candidate.event : candidate;
  const reason = await retentionDependency(tx, event, kind === 'identity', assertCurrent, limit);
  assertCurrent();
  if (reason) {
    return reason;
  }
  if ('event' in candidate && !validRetentionEvaluation(candidate, candidate.run)) {
    return 'INVALID_STORED_DATA';
  }
  const remaining = await remainingDependency(tx, kind, event.id, limit, assertCurrent);
  assertCurrent();
  if (remaining) {
    return remaining;
  }
  if (kind === 'evaluation') {
    await tx.agentEvaluation.delete({ where: { id: candidate.id } });
  } else {
    await agentEventAccessor.pruneEventInTransaction(tx, event.id, kind);
  }
  assertCurrent();
  return null;
}

async function pruneBatch(
  kind: RetentionKind,
  cursor: string | null,
  assertCurrent: () => void
): Promise<RetentionBatch> {
  return await ledgerTransaction(async (tx) => {
    assertCurrent();
    const now = new Date(); // ledgerTransaction has already awaited the write lock.
    const take = configService.getAgentRuntimeLimits().queueBatchSize;
    let rows = await candidates(tx, kind, cursor, now, take);
    assertCurrent();
    if (!rows.length && cursor) {
      rows = await candidates(tx, kind, null, now, take);
      assertCurrent();
    }
    const batch: RetentionBatch = {
      kind,
      cursor: rows.at(-1)?.id ?? null,
      inspected: rows.length,
      changed: 0,
      retained: {},
    };
    for (const candidate of rows) {
      const reason = await pruneCandidate(tx, kind, candidate, take, assertCurrent);
      assertCurrent();
      if (reason) {
        batch.retained[reason] = (batch.retained[reason] ?? 0) + 1;
      } else {
        batch.changed++;
      }
    }
    // This live check rolls back all mutations on a shutdown during any await.
    assertCurrent();
    return batch;
  });
}
export const agentLedgerRetentionAccessor = { pruneBatch };
