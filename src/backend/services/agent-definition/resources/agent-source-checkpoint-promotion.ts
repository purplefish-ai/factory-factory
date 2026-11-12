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
type PhaseOutcome =
  | { kind: 'DEFERRED' }
  | { kind: 'INVALID' }
  | { kind: 'ADVANCED'; remaining: number }
  | { kind: 'COMPLETE' };
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

/** Authority is the proof of one epoch; identities may carry other ordinals in earlier epochs. */
type Authority = { connectionId: string; epoch: number; epochStartSourceOrder: number };

async function markers(tx: Tx, authority: Authority, progress: Progress, take: number) {
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
    WHERE page."connectionId" = ${authority.connectionId} AND page."epoch" = ${authority.epoch}
      AND page."phase" = 'FINALIZED'
      AND (page."scanId", page."ordinal") > (${progress.scanId}, ${progress.position})
    ORDER BY page."scanId", page."ordinal" LIMIT ${take}
  `
  );
}

async function heads(
  tx: Tx,
  { connectionId, epoch }: Authority,
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
        WHERE pin."connectionId" = authority."connectionId" AND pin."epoch" = ${epoch}
          AND pin."headEventId" = authority."providerEventId"
          AND pin."sourceOrder" IS NOT NULL ORDER BY pin."sourceOrder" ASC LIMIT 1) AS "baselineMinimum",
      (SELECT pin."sourceOrder" FROM "AgentSourceBaseline" pin
        WHERE pin."connectionId" = authority."connectionId" AND pin."epoch" = ${epoch}
          AND pin."headEventId" = authority."providerEventId"
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
    WHERE authority."connectionId" = ${connectionId} AND authority."epoch" = ${epoch}
      AND (authority."scanId", authority."position") > (${progress.scanId}, ${progress.position})
    ORDER BY authority."scanId", authority."position" LIMIT ${take}
  `
  );
}

async function baselines(
  tx: Tx,
  { connectionId, epoch, epochStartSourceOrder }: Authority,
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
      AND ((baseline."headEventId" IS NULL AND baseline."sourceOrder" != ${epochStartSourceOrder})
        OR (target."providerEventId" IS NOT NULL
          AND baseline."sourceOrder" != ${sourceOrder} - target."precedingEventCount"))
      THEN 'CONFLICT' ELSE 'OK' END AS conflict,
      CASE WHEN baseline."headEventId" IS ${boundaryEventId} AND baseline."sourceOrder" IS NOT NULL
        THEN CASE WHEN baseline."sourceOrder" = ${boundaryOrder}
          THEN 'MATCH' ELSE 'CONFLICT' END ELSE 'NONE' END AS boundary
    FROM "AgentSourceBaseline" baseline
    LEFT JOIN "AgentSourceHead" target ON target."connectionId" = baseline."connectionId"
      AND target."scanId" = ${scanId} AND target."providerEventId" = baseline."headEventId"
    WHERE baseline."connectionId" = ${connectionId} AND baseline."epoch" = ${epoch}
      AND baseline."id" > ${progress.baselineId}
    ORDER BY baseline."id" LIMIT ${take}
  `
  );
}

function resumeProgress(checkpoint: AgentSourceCheckpoint, revision: number): Progress {
  const parsed = progressSchema.safeParse(checkpoint.validationCursor);
  return parsed.success && parsed.data.revision === revision
    ? parsed.data
    : {
        version: 2,
        boundaryWitnessed: checkpoint.previousBoundaryEventId === null,
        revision,
        phase: 'MARKERS',
        scanId: '',
        position: -1,
        baselineId: '',
        headCount: 0,
      };
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
  // An earlier epoch's interval stays INDEXED: its authority is retained, not revalidated.
  if (checkpoint.epoch !== state.epoch) {
    return;
  }
  const authority: Authority = {
    connectionId,
    epoch: state.epoch,
    epochStartSourceOrder: state.epochStartSourceOrder,
  };
  const progress = resumeProgress(checkpoint, state.authorityRevision);
  let remaining = 100;
  for (const phase of ['MARKERS', 'HEADS', 'BASELINES'] as const) {
    if (remaining === 0 || progress.phase !== phase) {
      continue;
    }
    const outcome =
      phase === 'MARKERS'
        ? await advanceMarkers(tx, authority, checkpoint, progress, remaining)
        : phase === 'HEADS'
          ? await advanceHeads(tx, authority, checkpoint, progress, remaining)
          : await advanceBaselines(tx, authority, checkpoint, progress, remaining);
    switch (outcome.kind) {
      case 'DEFERRED':
        return;
      case 'INVALID':
        return { status: 'INVALID' };
      case 'COMPLETE':
        return { status: 'COMPLETE', validationCursor: progress };
      case 'ADVANCED':
        remaining = outcome.remaining;
        break;
    }
  }
  return { validationCursor: progress };
}

async function advanceMarkers(
  tx: Tx,
  authority: Authority,
  checkpoint: AgentSourceCheckpoint,
  progress: Progress,
  remaining: number
): Promise<PhaseOutcome> {
  const rows = await markers(tx, authority, progress, remaining);
  // Unindexed legacy intervals might contain contradictory heads. Keep their proof.
  if (rows.some((row) => row.status !== 'INDEXED' && row.status !== 'COMPLETE')) {
    return { kind: 'DEFERRED' };
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
    return { kind: 'INVALID' };
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
  return { kind: 'ADVANCED', remaining };
}

async function advanceHeads(
  tx: Tx,
  authority: Authority,
  checkpoint: AgentSourceCheckpoint,
  progress: Progress,
  remaining: number
): Promise<PhaseOutcome> {
  if (checkpoint.sourceOrder === null) {
    return { kind: 'INVALID' };
  }
  const take = Math.floor(remaining / 3);
  if (take === 0) {
    return { kind: 'ADVANCED', remaining: 0 };
  }
  const rows = await heads(
    tx,
    authority,
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
    return { kind: 'INVALID' };
  }
  if (rows.some((row) => row.conflict === 'CONFLICT' || row.boundary === 'CONFLICT')) {
    return { kind: 'INVALID' };
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
  return { kind: 'ADVANCED', remaining };
}

async function advanceBaselines(
  tx: Tx,
  authority: Authority,
  checkpoint: AgentSourceCheckpoint,
  progress: Progress,
  remaining: number
): Promise<PhaseOutcome> {
  if (checkpoint.sourceOrder === null) {
    return { kind: 'INVALID' };
  }
  const rows = await baselines(
    tx,
    authority,
    checkpoint.scanId,
    checkpoint.sourceOrder,
    checkpoint.previousBoundaryEventId,
    checkpoint.initialSourceOrder,
    progress,
    remaining
  );
  if (rows.some((row) => row.conflict === 'CONFLICT' || row.boundary === 'CONFLICT')) {
    return { kind: 'INVALID' };
  }
  progress.boundaryWitnessed ||= rows.some((row) => row.boundary === 'MATCH');
  const last = rows.at(-1);
  if (last) {
    progress.baselineId = last.id;
  }
  if (rows.length < remaining) {
    return {
      kind:
        progress.headCount === checkpoint.entryCount && progress.boundaryWitnessed
          ? 'COMPLETE'
          : 'INVALID',
    };
  }
  return { kind: 'ADVANCED', remaining: 0 };
}
