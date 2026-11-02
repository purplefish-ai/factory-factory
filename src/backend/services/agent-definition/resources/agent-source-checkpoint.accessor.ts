import { z } from 'zod';
import { nullablePrismaJson } from '@/backend/lib/prisma-json';
import {
  agentGithubCursorSchema,
  agentSourcePageEvidenceSchema,
} from '@/shared/agent-source-state';
import type { DurableRecovery } from '@/shared/schemas/durable-recovery.schema';
import { recoveryJsonNullLookup } from '@/shared/schemas/recovery-json-storage.schema';
import { type AgentSourceCheckpoint, type AgentSourcePage, Prisma } from '@prisma-gen/client';
import { ledgerTransaction } from './agent-ledger-transaction';
import { captureBoundary } from './agent-source-checkpoint-boundary';
import { checkpointPromotionStatus } from './agent-source-checkpoint-promotion';
import { verifyCheckpointPage } from './agent-source-checkpoint-verification';

type Tx = Prisma.TransactionClient;
type DeletePages = (tx: Tx, ids: string[]) => Promise<{ count: number }>;

async function promoteCheckpoint(tx: Tx, connectionId: string, scanId: string) {
  const data = await checkpointPromotionStatus(tx, connectionId, scanId);
  if (data) {
    await tx.agentSourceCheckpoint.update({
      where: { connectionId_scanId: { connectionId, scanId } },
      data,
    });
  }
}

async function capture(tx: Tx, checkpoint: AgentSourceCheckpoint, page: AgentSourcePage) {
  if (checkpoint.verification !== null) {
    return false;
  }
  const evidence = agentSourcePageEvidenceSchema.parse(page.evidence);
  let offset = checkpoint.executableCount;
  let position = checkpoint.entryCount;
  let previous = -1;
  const heads: Prisma.AgentSourceHeadCreateManyInput[] = [];
  for (const entry of evidence.entries) {
    const index = evidence.ids.indexOf(entry.providerEventId);
    if (index <= previous || (previous >= 0 && index !== previous + 1)) {
      return false;
    }
    previous = index;
    heads.push({
      connectionId: page.connectionId,
      scanId: page.scanId,
      providerEventId: entry.providerEventId,
      position: position++,
      precedingEventCount: offset,
    });
    if (entry.eventId) {
      offset++;
    }
  }
  const existing = await tx.agentSourceHead.findMany({
    where: {
      connectionId: page.connectionId,
      scanId: page.scanId,
      providerEventId: { in: heads.map((head) => head.providerEventId) },
    },
  });
  if (
    existing.some(
      (row) =>
        !heads.some(
          (head) =>
            head.providerEventId === row.providerEventId &&
            head.position === row.position &&
            head.precedingEventCount === row.precedingEventCount
        )
    )
  ) {
    return false;
  }
  const fresh = heads.filter(
    (head) => !existing.some((row) => row.providerEventId === head.providerEventId)
  );
  if (fresh.length) {
    await tx.agentSourceHead.createMany({ data: fresh });
  }
  await tx.agentSourceCheckpoint.update({
    where: {
      connectionId_scanId: { connectionId: checkpoint.connectionId, scanId: checkpoint.scanId },
    },
    data: {
      ...(await captureBoundary(tx, checkpoint, page, evidence)),
      entryCount: position,
      executableCount: offset,
      headEventId: checkpoint.headEventId ?? evidence.entries[0]?.providerEventId ?? null,
    },
  });
  return true;
}

async function verify(tx: Tx, checkpoint: AgentSourceCheckpoint, page: AgentSourcePage) {
  const data = await verifyCheckpointPage(tx, checkpoint, page);
  if (!data) {
    return false;
  }
  await tx.agentSourceCheckpoint.update({
    where: {
      connectionId_scanId: { connectionId: checkpoint.connectionId, scanId: checkpoint.scanId },
    },
    data,
  });
  return true;
}

async function complete(tx: Tx, checkpoint: AgentSourceCheckpoint, page: AgentSourcePage) {
  const evidence = agentSourcePageEvidenceSchema.parse(page.evidence);
  // This is only a provisional claim until promotion checks every retained boundary witness.
  const initialSourceOrder =
    page.sourceOrder === null ? null : page.sourceOrder - checkpoint.executableCount;
  if (
    evidence.entries.length ||
    evidence.ids.length !== 1 ||
    evidence.ids[0] !== checkpoint.headEventId ||
    !checkpoint.boundaryKnown ||
    checkpoint.verifiedCount !==
      checkpoint.entryCount + (checkpoint.previousBoundaryEventId ? 1 : 0) ||
    page.sourceOrder === null ||
    initialSourceOrder === null ||
    initialSourceOrder < 0 ||
    (checkpoint.initialSourceOrder !== null &&
      initialSourceOrder !== checkpoint.initialSourceOrder) ||
    !Number.isSafeInteger(page.sourceOrder)
  ) {
    return false;
  }
  await tx.agentSourceCheckpoint.update({
    where: { connectionId_scanId: { connectionId: page.connectionId, scanId: page.scanId } },
    data: { status: 'INDEXED', sourceOrder: page.sourceOrder, initialSourceOrder },
  });
  await promoteCheckpoint(tx, page.connectionId, page.scanId);
  return true;
}

/** One immutable page, at most100 head writes. Partial indexes never serve reads or delete proof. */
async function checkpointPage(
  tx: Tx,
  page: AgentSourcePage,
  boundary?: { headEventId: string | null; sourceOrder: number }
) {
  const key = { connectionId: page.connectionId, scanId: page.scanId };
  let checkpoint = await tx.agentSourceCheckpoint.findUnique({
    where: { connectionId_scanId: key },
  });
  if (!checkpoint) {
    // An upgrade may encounter an active scan midway through capture. Backfill it after finalization.
    if (page.ordinal !== 0) {
      return;
    }
    checkpoint = await tx.agentSourceCheckpoint.create({
      data: {
        ...key,
        ...(boundary
          ? {
              boundaryKnown: true,
              previousBoundaryEventId: boundary.headEventId,
              initialSourceOrder: boundary.sourceOrder,
            }
          : {}),
      },
    });
  }
  if (checkpoint.status !== 'BUILDING' || checkpoint.nextOrdinal !== page.ordinal) {
    return;
  }
  if (page.phase === 'FINALIZED') {
    await tx.agentSourceCheckpoint.update({
      where: { connectionId_scanId: key },
      data: { sourceOrder: page.sourceOrder },
    });
  }
  const parsed = agentSourcePageEvidenceSchema.safeParse(page.evidence);
  const valid = parsed.success && (await indexPage(tx, checkpoint, page));
  await tx.agentSourceCheckpoint.update({
    where: { connectionId_scanId: key },
    data: valid ? { nextOrdinal: page.ordinal + 1 } : { status: 'INVALID' },
  });
}

async function indexPage(tx: Tx, checkpoint: AgentSourceCheckpoint, page: AgentSourcePage) {
  switch (page.phase) {
    case 'CAPTURE':
      return await capture(tx, checkpoint, page);
    case 'VERIFY':
      return await verify(tx, checkpoint, page);
    case 'FINALIZED':
      return await complete(tx, checkpoint, page);
    default:
      return false;
  }
}

/** A single bounded transaction, serialized with capture/finalization and baseline pinning. */
function maintainCheckpoints(connectionId: string, deletePages: DeletePages) {
  return ledgerTransaction(async (tx) => {
    const state = await tx.agentSourceState.findUnique({ where: { connectionId } });
    const cursor = agentGithubCursorSchema.safeParse(state?.cursor);
    if (!cursor.success) {
      return { indexedPages: 0, deletedPages: 0 };
    }
    const activeScan = cursor.data.scan?.id ?? '';
    // Markers survive compaction; NOT EXISTS avoids rescanning all historical JSON.
    const candidates = z
      .array(z.object({ scanId: z.string(), sourceOrder: z.number().int().nullable() }))
      .parse(
        await tx.$queryRaw`
      SELECT page."scanId", page."sourceOrder" FROM "AgentSourcePage" page
      LEFT JOIN "AgentSourceCheckpoint" checkpoint ON checkpoint."connectionId" = page."connectionId"
        AND checkpoint."scanId" = page."scanId"
      WHERE page."connectionId" = ${connectionId} AND page."phase" = 'FINALIZED'
        AND page."scanId" != ${activeScan}
        AND (checkpoint."status" IS NULL OR checkpoint."status" = 'BUILDING')
      ORDER BY page."scanId" LIMIT 1
    `
      );
    const candidate = candidates[0];
    if (candidate) {
      return await backfillPage(tx, connectionId, candidate);
    }
    if (
      await tx.agentSourceCheckpoint.findFirst({
        where: { connectionId, status: 'INVALID' },
        select: { scanId: true },
      })
    ) {
      return { indexedPages: 0, deletedPages: 0 };
    }
    const indexed = await tx.agentSourceCheckpoint.findFirst({
      where: { connectionId, status: 'INDEXED', scanId: { not: activeScan } },
    });
    if (indexed) {
      await promoteCheckpoint(tx, connectionId, indexed.scanId);
      return { indexedPages: 0, deletedPages: 0 };
    }
    return await compactPages(tx, connectionId, activeScan, deletePages);
  });
}

async function backfillPage(
  tx: Tx,
  connectionId: string,
  candidate: { scanId: string; sourceOrder: number | null }
) {
  const key = { connectionId, scanId: candidate.scanId };
  const checkpoint = await tx.agentSourceCheckpoint.upsert({
    where: { connectionId_scanId: key },
    create: { ...key, sourceOrder: candidate.sourceOrder },
    update: {},
  });
  const page = await tx.agentSourcePage.findFirst({
    where: { ...key, ordinal: { gte: checkpoint?.nextOrdinal ?? 0 } },
    orderBy: { ordinal: 'asc' },
  });
  if (!page || page.ordinal !== (checkpoint?.nextOrdinal ?? 0)) {
    await tx.agentSourceCheckpoint.upsert({
      where: { connectionId_scanId: key },
      create: { ...key, status: 'INVALID' },
      update: { status: 'INVALID' },
    });
  } else {
    await checkpointPage(tx, page);
  }
  return { indexedPages: page ? 1 : 0, deletedPages: 0 };
}

async function compactPages(
  tx: Tx,
  connectionId: string,
  activeScan: string,
  deletePages: DeletePages
) {
  // Select completed scans before applying the page limit; active proof is never eligible.
  const pages = z.array(z.object({ id: z.string(), scanId: z.string() })).parse(
    await tx.$queryRaw`
      SELECT page."id", page."scanId" FROM "AgentSourcePage" page
      JOIN "AgentSourceCheckpoint" checkpoint ON checkpoint."connectionId" = page."connectionId"
        AND checkpoint."scanId" = page."scanId" AND checkpoint."status" = 'COMPLETE'
      WHERE page."connectionId" = ${connectionId} AND page."scanId" != ${activeScan}
        AND page."phase" IN ('CAPTURE', 'VERIFY')
      ORDER BY page."scanId", page."ordinal" LIMIT 100
    `
  );
  const ids: string[] = [];
  for (const scanId of new Set(pages.map((page) => page.scanId))) {
    const checkpoint = await tx.agentSourceCheckpoint.findUnique({
      where: { connectionId_scanId: { connectionId, scanId } },
    });
    if (checkpoint?.status !== 'COMPLETE') {
      continue;
    }
    const marker = await tx.agentSourcePage.findFirst({
      where: { connectionId, scanId, phase: 'FINALIZED' },
    });
    // Publication already counted immutable heads in bounded validation chunks.
    if (marker?.sourceOrder !== checkpoint.sourceOrder) {
      continue;
    }
    ids.push(...pages.filter((page) => page.scanId === scanId).map((page) => page.id));
  }
  const deleted = await deletePages(tx, ids);
  return { indexedPages: 0, deletedPages: deleted.count };
}

export const agentSourceCheckpointAccessor = { checkpointPage, maintainCheckpoints };

export async function restoreRecoveryCheckpointProof(
  tx: Prisma.TransactionClient,
  data: DurableRecovery,
  states: ReadonlySet<string>
) {
  const nulls = recoveryJsonNullLookup(data.jsonStorage);
  for (const row of data.agentSourceCheckpoint) {
    if (!states.has(row.connectionId)) {
      continue;
    }
    const id = JSON.stringify([row.connectionId, row.scanId]);
    await tx.agentSourceCheckpoint.create({
      data: {
        ...row,
        verification: nullablePrismaJson(
          row.verification,
          nulls('AgentSourceCheckpoint', id, 'verification')
        ),
        // Progress is a runtime optimization, never imported authority. Complete
        // compacted proof has already been validated without requiring old pages.
        validationCursor:
          row.status === 'COMPLETE'
            ? nullablePrismaJson(
                row.validationCursor,
                nulls('AgentSourceCheckpoint', id, 'validationCursor')
              )
            : Prisma.DbNull,
        // Match the canonical verifier upgrade: replay retained pages from the
        // beginning rather than trusting imported partial capture/verify counters.
        ...(row.status === 'BUILDING'
          ? {
              nextOrdinal: 0,
              entryCount: 0,
              executableCount: 0,
              verifiedCount: 0,
              verification: Prisma.DbNull,
            }
          : {}),
      },
    });
  }
  for (const row of data.agentSourceHead) {
    if (!states.has(row.connectionId)) {
      continue;
    }
    await tx.agentSourceHead.create({ data: row });
  }
}
