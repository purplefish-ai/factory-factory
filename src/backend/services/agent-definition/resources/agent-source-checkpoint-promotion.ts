import { z } from 'zod';
import type { AgentSourceCheckpoint, Prisma } from '@prisma-gen/client';

type Tx = Prisma.TransactionClient;
const progressSchema = z.object({
  version: z.literal(2),
  boundaryWitnessed: z.boolean(),
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
    checkpointHead: z.string().nullable(),
    checkpointOrder: z.number().int().nullable(),
    headEventId: z.string().nullable(),
    sourceOrder: z.number().int().nullable(),
  })
);
const headsSchema = z.array(
  z.object({
    scanId: z.string(),
    position: z.number().int(),
    canonicalOrder: z
      .union([z.number(), z.bigint().transform(Number)])
      .pipe(z.number().int())
      .nullable(),
    baselineMinimum: z.number().int().nullable(),
    baselineMaximum: z.number().int().nullable(),
    conflict: z.enum(['CONFLICT', 'OK']),
    boundary: z.enum(['MATCH', 'CONFLICT', 'NONE']),
  })
);
const baselinesSchema = z.array(
  z.object({
    id: z.string(),
    conflict: z.enum(['CONFLICT', 'OK']),
    boundary: z.enum(['MATCH', 'CONFLICT', 'NONE']),
  })
);

async function markers(tx: Tx, connectionId: string, progress: Progress, take: number) {
  return markersSchema.parse(
    await tx.$queryRaw`
    SELECT page."scanId", page."ordinal", checkpoint."status", page."sourceOrder",
      checkpoint."headEventId" AS "checkpointHead", checkpoint."sourceOrder" AS "checkpointOrder",
      CASE WHEN json_valid(page."evidence") THEN
        CASE WHEN json_type(page."evidence", '$.ids') = 'array'
          AND json_array_length(page."evidence", '$.ids') = 1
          AND json_type(page."evidence", '$.ids[0]') = 'text'
          AND length(json_extract(page."evidence", '$.ids[0]')) BETWEEN 1 AND 256
          AND json_type(page."evidence", '$.entries') = 'array'
          AND json_array_length(page."evidence", '$.entries') = 0
        THEN json_extract(page."evidence", '$.ids[0]') END
      END AS "headEventId"
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
  boundaryEventId: string | null,
  boundaryOrder: number | null,
  progress: Progress,
  take: number
) {
  // Traverse authority rows, not candidate heads with an unbounded probe for each identity.
  // Joins are unique point lookups; each baseline extremum is one indexed range seek.
  // Reserve three authority rows per head, including both optional baseline witnesses.
  return headsSchema.parse(
    await tx.$queryRaw`
    SELECT authority."scanId", authority."position",
      other."sourceOrder" - authority."precedingEventCount" AS "canonicalOrder",
      (SELECT pin."sourceOrder" FROM "AgentSourceBaseline" pin
        WHERE pin."connectionId" = authority."connectionId" AND pin."headEventId" = authority."providerEventId"
          AND pin."sourceOrder" IS NOT NULL ORDER BY pin."sourceOrder" ASC LIMIT 1) AS "baselineMinimum",
      (SELECT pin."sourceOrder" FROM "AgentSourceBaseline" pin
        WHERE pin."connectionId" = authority."connectionId" AND pin."headEventId" = authority."providerEventId"
          AND pin."sourceOrder" IS NOT NULL ORDER BY pin."sourceOrder" DESC LIMIT 1) AS "baselineMaximum",
      CASE WHEN other."sourceOrder" IS NOT NULL AND target."providerEventId" IS NOT NULL
        AND other."sourceOrder" - authority."precedingEventCount" != ${sourceOrder} - target."precedingEventCount"
        THEN 'CONFLICT' ELSE 'OK' END AS conflict,
      CASE WHEN authority."providerEventId" = ${boundaryEventId} AND other."sourceOrder" IS NOT NULL
        THEN CASE WHEN other."sourceOrder" - authority."precedingEventCount" = ${boundaryOrder}
          THEN 'MATCH' ELSE 'CONFLICT' END ELSE 'NONE' END AS boundary
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
  boundaryEventId: string | null,
  boundaryOrder: number | null,
  progress: Progress,
  take: number
) {
  return baselinesSchema.parse(
    await tx.$queryRaw`
    SELECT baseline."id", CASE WHEN baseline."sourceOrder" IS NOT NULL
      AND target."providerEventId" IS NOT NULL
      AND baseline."sourceOrder" != ${sourceOrder} - target."precedingEventCount"
      THEN 'CONFLICT' ELSE 'OK' END AS conflict,
      CASE WHEN baseline."headEventId" IS ${boundaryEventId} AND baseline."sourceOrder" IS NOT NULL
        THEN CASE WHEN baseline."sourceOrder" = ${boundaryOrder}
          THEN 'MATCH' ELSE 'CONFLICT' END ELSE 'NONE' END AS boundary
    FROM "AgentSourceBaseline" baseline
    LEFT JOIN "AgentSourceHead" target ON target."connectionId" = baseline."connectionId"
      AND target."scanId" = ${scanId} AND target."providerEventId" = baseline."headEventId"
    WHERE baseline."connectionId" = ${connectionId} AND baseline."id" > ${progress.baselineId}
    ORDER BY baseline."id" LIMIT ${take}
  `
  );
}

/** At most 100 authority rows, including indexed baseline extrema, per ledger writer transaction.
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
          version: 2,
          boundaryWitnessed: checkpoint.previousBoundaryEventId === null,
          revision: state.authorityRevision,
          phase: 'MARKERS',
          scanId: '',
          position: -1,
          baselineId: '',
          headCount: 0,
        };
  let remaining = 100;
  if (progress.phase === 'MARKERS') {
    const budget = await advanceMarkers(tx, checkpoint, progress, remaining);
    if (budget === 'INVALID') {
      return { status: 'INVALID' };
    }
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

async function advanceMarkers(
  tx: Tx,
  checkpoint: AgentSourceCheckpoint,
  progress: Progress,
  remaining: number
) {
  const rows = await markers(tx, checkpoint.connectionId, progress, remaining);
  // Unindexed legacy intervals might contain contradictory heads. Keep their proof.
  if (rows.some((row) => row.status !== 'INDEXED' && row.status !== 'COMPLETE')) {
    return null;
  }
  if (
    rows.some(
      (row) =>
        row.headEventId === null ||
        row.sourceOrder === null ||
        row.sourceOrder < 0 ||
        row.sourceOrder !== row.checkpointOrder ||
        row.headEventId !== row.checkpointHead ||
        (row.headEventId === checkpoint.previousBoundaryEventId &&
          row.sourceOrder !== checkpoint.initialSourceOrder)
    )
  ) {
    return 'INVALID';
  }
  progress.boundaryWitnessed ||= rows.some(
    (row) => row.headEventId === checkpoint.previousBoundaryEventId
  );
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
  const take = Math.floor(remaining / 3);
  if (take === 0) {
    return 0;
  }
  const rows = await heads(
    tx,
    checkpoint.connectionId,
    checkpoint.scanId,
    checkpoint.sourceOrder,
    checkpoint.previousBoundaryEventId,
    checkpoint.initialSourceOrder,
    progress,
    take
  );
  if (
    rows.some(
      (row) =>
        row.canonicalOrder !== null &&
        ((row.baselineMinimum !== null && row.baselineMinimum !== row.canonicalOrder) ||
          (row.baselineMaximum !== null && row.baselineMaximum !== row.canonicalOrder))
    )
  ) {
    return null;
  }
  if (rows.some((row) => row.conflict === 'CONFLICT' || row.boundary === 'CONFLICT')) {
    return null;
  }
  progress.boundaryWitnessed ||= rows.some((row) => row.boundary === 'MATCH');
  progress.headCount += rows.filter((row) => row.scanId === checkpoint.scanId).length;
  const last = rows.at(-1);
  if (last) {
    progress.scanId = last.scanId;
    progress.position = last.position;
  }
  remaining -= rows.length * 3;
  if (rows.length < take) {
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
    checkpoint.previousBoundaryEventId,
    checkpoint.initialSourceOrder,
    progress,
    remaining
  );
  if (rows.some((row) => row.conflict === 'CONFLICT' || row.boundary === 'CONFLICT')) {
    return { status: 'INVALID' };
  }
  progress.boundaryWitnessed ||= rows.some((row) => row.boundary === 'MATCH');
  const last = rows.at(-1);
  if (last) {
    progress.baselineId = last.id;
  }
  if (rows.length < remaining) {
    return {
      status:
        progress.headCount === checkpoint.entryCount && progress.boundaryWitnessed
          ? 'COMPLETE'
          : 'INVALID',
      validationCursor: progress,
    };
  }
  return { validationCursor: progress };
}
