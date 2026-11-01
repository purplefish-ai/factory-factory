import { z } from 'zod';
import { prisma } from '@/backend/db';
import { configService } from '@/backend/services/config.service';
import { Prisma } from '@prisma-gen/client';
import { ledgerTransaction } from './agent-ledger-transaction';
import {
  eventEligibility,
  permanentRuntimeStateReason,
  runtimeTriggerInclude,
  sameRevisions,
  triggerRevisions,
} from './agent-runtime-guards';

export type EvaluationCursor = { triggerId: string; eventId: string };
const candidateIds = z.array(z.object({ triggerId: z.string(), eventId: z.string() }));

/** Keyset rotation bounds each cycle even with a permanently blocked prefix. */
async function pending(cursor: EvaluationCursor | null) {
  const after = cursor
    ? Prisma.sql`AND (t.id > ${cursor.triggerId} OR (t.id = ${cursor.triggerId} AND e.id > ${cursor.eventId}))`
    : Prisma.empty;
  const rows = candidateIds.parse(
    await prisma.$queryRaw`
    SELECT t.id AS triggerId, e.id AS eventId
    FROM AgentTrigger t JOIN AgentEvent e ON e.connectionId = t.connectionId
    WHERE t.type != 'SCHEDULE' AND t.activationState != 'STARTING'
      AND (e.sourceOrder IS NOT NULL OR t.type = 'SLACK_MESSAGE')
      AND e.payload IS NOT NULL
      AND (NOT EXISTS (SELECT 1 FROM AgentEvaluation a WHERE a.eventId = e.id AND a.triggerId = t.id)
        OR EXISTS (SELECT 1 FROM AgentEvaluation a WHERE a.eventId = e.id AND a.triggerId = t.id
          AND ((a.status = 'ERROR' AND a.nextAttemptAt IS NOT NULL) OR (a.status = 'MATCHED' AND a.runId IS NULL))))
      ${after}
    ORDER BY t.id, e.id LIMIT ${configService.getAgentRuntimeLimits().evaluationBatchSize}`
  );
  const [triggers, events, evaluations] = await Promise.all([
    prisma.agentTrigger.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.triggerId))] } },
      include: runtimeTriggerInclude,
    }),
    prisma.agentEvent.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.eventId))] } },
    }),
    prisma.agentEvaluation.findMany({ where: { OR: rows } }),
  ]);
  const triggersById = new Map(triggers.map((trigger) => [trigger.id, trigger]));
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const evaluationsByPair = new Map(
    evaluations.map((evaluation) => [
      JSON.stringify([evaluation.triggerId, evaluation.eventId]),
      evaluation,
    ])
  );
  const candidates = [];
  for (const row of rows) {
    const trigger = triggersById.get(row.triggerId);
    const event = eventsById.get(row.eventId);
    const evaluation = evaluationsByPair.get(JSON.stringify([row.triggerId, row.eventId])) ?? null;
    if (trigger && event) {
      candidates.push({ trigger, event, evaluation });
    }
  }
  return { candidates, cursor: rows.at(-1) ?? null };
}
async function settleUnavailable(evaluationId: string, now: Date) {
  return await ledgerTransaction(async (tx) => {
    const evaluation = await tx.agentEvaluation.findUnique({
      where: { id: evaluationId },
      include: { event: true, trigger: { include: runtimeTriggerInclude } },
    });
    if (!evaluation || evaluation.runId || evaluation.status === 'SKIPPED') {
      return true;
    }
    const trigger = evaluation.trigger;
    const reason = !sameRevisions(evaluation, triggerRevisions(trigger))
      ? 'STALE_REVISION'
      : (permanentRuntimeStateReason(trigger) ?? eventEligibility(trigger, evaluation.event, now));
    if (!reason) {
      return false;
    }
    await tx.agentEvaluation.update({
      where: { id: evaluationId },
      data: {
        status: reason === 'INVALID_STORED_DATA' ? 'ERROR' : 'SKIPPED',
        reasonCode: reason,
        nextAttemptAt: null,
        explanation: 'The pending decision is no longer eligible for execution.',
      },
    });
    return true;
  });
}
export const agentEvaluationCandidatesAccessor = { pending, settleUnavailable };
