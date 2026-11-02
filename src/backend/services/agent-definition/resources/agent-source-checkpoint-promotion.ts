import { z } from 'zod';
import type { AgentSourceCheckpoint, Prisma } from '@prisma-gen/client';

type Tx = Prisma.TransactionClient;
const progressSchema = z.object({
  revision: z.number().int().nonnegative(),
  phase: z.enum(['MARKERS', 'HEADS', 'BASELINES']),
  scanId: z.string(),
  position: z.number().int().min(-1),
  baselineId: z.string(),
  headCount: z.number().int().nonnegative(),
});
type Progress = z.infer<typeof progressSchema>;
const markersSchema = z.array(
  z.object({
    scanId: z.string(),
    ordinal: z.number().int(),
    status: z.string().nullable(),
  })
);
const headsSchema = z.array(
  z.object({
    scanId: z.string(),
    position: z.number().int(),
    conflict: z.enum(['CONFLICT', 'OK']),
  })
);
const baselinesSchema = z.array(z.object({ id: z.string(), conflict: z.enum(['CONFLICT', 'OK']) }));

async function markers(tx: Tx, connectionId: string, progress: Progress, take: number) {
  return markersSchema.parse(
    await tx.$queryRaw`
    SELECT page."scanId", page."ordinal", checkpoint."status"
    FROM "AgentSourcePage" page
    LEFT JOIN "AgentSourceCheckpoint" checkpoint
      ON checkpoint."connectionId" = page."connectionId" AND checkpoint."scanId" = page."scanId"
    WHERE page."connectionId" = ${connectionId} AND page."phase" = 'FINALIZED'
      AND (page."scanId", page."ordinal") > (${progress.scanId}, ${progress.position})
    ORDER BY page."scanId", page."ordinal" LIMIT ${take}
  `
  );
}

async function heads(
  tx: Tx,
  connectionId: string,
  scanId: string,
  sourceOrder: number,
  progress: Progress,
  take: number
) {
  // Traverse authority rows, not candidate heads with an unbounded probe for each identity.
  // Both joins are unique point lookups; the ordered range is capped before the next transaction.
  return headsSchema.parse(
    await tx.$queryRaw`
    SELECT authority."scanId", authority."position",
      CASE WHEN other."sourceOrder" IS NOT NULL AND target."providerEventId" IS NOT NULL
        AND other."sourceOrder" - authority."precedingEventCount" != ${sourceOrder} - target."precedingEventCount"
        THEN 'CONFLICT' ELSE 'OK' END AS conflict
    FROM "AgentSourceHead" authority
    JOIN "AgentSourceCheckpoint" other
      ON other."connectionId" = authority."connectionId" AND other."scanId" = authority."scanId"
    LEFT JOIN "AgentSourceHead" target ON target."connectionId" = authority."connectionId"
      AND target."scanId" = ${scanId} AND target."providerEventId" = authority."providerEventId"
    WHERE authority."connectionId" = ${connectionId}
      AND (authority."scanId", authority."position") > (${progress.scanId}, ${progress.position})
    ORDER BY authority."scanId", authority."position" LIMIT ${take}
  `
  );
}

async function baselines(
  tx: Tx,
  connectionId: string,
  scanId: string,
  sourceOrder: number,
  progress: Progress,
  take: number
) {
  return baselinesSchema.parse(
    await tx.$queryRaw`
    SELECT baseline."id", CASE WHEN baseline."sourceOrder" IS NOT NULL
      AND target."providerEventId" IS NOT NULL
      AND baseline."sourceOrder" != ${sourceOrder} - target."precedingEventCount"
      THEN 'CONFLICT' ELSE 'OK' END AS conflict
    FROM "AgentSourceBaseline" baseline
    LEFT JOIN "AgentSourceHead" target ON target."connectionId" = baseline."connectionId"
      AND target."scanId" = ${scanId} AND target."providerEventId" = baseline."headEventId"
    WHERE baseline."connectionId" = ${connectionId} AND baseline."id" > ${progress.baselineId}
    ORDER BY baseline."id" LIMIT ${take}
  `
  );
}

/** At most 100 authority rows, with unique point joins, per ledger writer transaction.
 * SQLite triggers advance the connection revision whenever a consulted claim changes.
 * An interrupted traversal restarts at the new revision. Publication shares the final
 * chunk's writer lock, so no authority write can slip between its fence and COMPLETE.
 */
export async function checkpointPromotionStatus(tx: Tx, connectionId: string, scanId: string) {
  const checkpoint = await tx.agentSourceCheckpoint.findUniqueOrThrow({
    where: { connectionId_scanId: { connectionId, scanId } },
  });
  if (checkpoint.status !== 'INDEXED' || checkpoint.sourceOrder === null) {
    return;
  }
  const state = await tx.agentSourceState.findUniqueOrThrow({ where: { connectionId } });
  const parsed = progressSchema.safeParse(checkpoint.validationCursor);
  const progress: Progress =
    parsed.success && parsed.data.revision === state.authorityRevision
      ? parsed.data
      : {
          revision: state.authorityRevision,
          phase: 'MARKERS',
          scanId: '',
          position: -1,
          baselineId: '',
          headCount: 0,
        };
  let remaining = 100;
  if (progress.phase === 'MARKERS') {
    const budget = await advanceMarkers(tx, connectionId, progress, remaining);
    if (budget === null) {
      return;
    }
    remaining = budget;
  }
  if (remaining > 0 && progress.phase === 'HEADS') {
    const budget = await advanceHeads(tx, checkpoint, progress, remaining);
    if (budget === null) {
      return { status: 'INVALID' };
    }
    remaining = budget;
  }
  if (remaining > 0 && progress.phase === 'BASELINES') {
    return await advanceBaselines(tx, checkpoint, progress, remaining);
  }
  return { validationCursor: progress };
}

async function advanceMarkers(tx: Tx, connectionId: string, progress: Progress, remaining: number) {
  const rows = await markers(tx, connectionId, progress, remaining);
  // Unindexed legacy intervals might contain contradictory heads. Keep their proof.
  if (rows.some((row) => row.status !== 'INDEXED' && row.status !== 'COMPLETE')) {
    return null;
  }
  const last = rows.at(-1);
  if (last) {
    progress.scanId = last.scanId;
    progress.position = last.ordinal;
  }
  remaining -= rows.length;
  if (remaining > 0) {
    progress.phase = 'HEADS';
    progress.scanId = '';
    progress.position = -1;
  }
  return remaining;
}

async function advanceHeads(
  tx: Tx,
  checkpoint: AgentSourceCheckpoint,
  progress: Progress,
  remaining: number
) {
  if (checkpoint.sourceOrder === null) {
    return null;
  }
  const rows = await heads(
    tx,
    checkpoint.connectionId,
    checkpoint.scanId,
    checkpoint.sourceOrder,
    progress,
    remaining
  );
  if (rows.some((row) => row.conflict === 'CONFLICT')) {
    return null;
  }
  progress.headCount += rows.filter((row) => row.scanId === checkpoint.scanId).length;
  const last = rows.at(-1);
  if (last) {
    progress.scanId = last.scanId;
    progress.position = last.position;
  }
  remaining -= rows.length;
  if (remaining > 0) {
    progress.phase = 'BASELINES';
  }
  return remaining;
}

async function advanceBaselines(
  tx: Tx,
  checkpoint: AgentSourceCheckpoint,
  progress: Progress,
  remaining: number
) {
  if (checkpoint.sourceOrder === null) {
    return { status: 'INVALID' };
  }
  const rows = await baselines(
    tx,
    checkpoint.connectionId,
    checkpoint.scanId,
    checkpoint.sourceOrder,
    progress,
    remaining
  );
  if (rows.some((row) => row.conflict === 'CONFLICT')) {
    return { status: 'INVALID' };
  }
  const last = rows.at(-1);
  if (last) {
    progress.baselineId = last.id;
  }
  if (rows.length < remaining) {
    return {
      status: progress.headCount === checkpoint.entryCount ? 'COMPLETE' : 'INVALID',
      validationCursor: progress,
    };
  }
  return { validationCursor: progress };
}
