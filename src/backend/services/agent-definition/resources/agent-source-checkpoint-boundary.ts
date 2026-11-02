import { z } from 'zod';
import type { AgentSourceEntry } from '@/shared/agent-source-state';
import type { AgentSourceCheckpoint, AgentSourcePage, Prisma } from '@prisma-gen/client';

type Tx = Prisma.TransactionClient;
async function boundaryOrder(tx: Tx, connectionId: string, head: string) {
  const baseline = await tx.agentSourceBaseline.findFirst({
    where: { connectionId, headEventId: head, sourceOrder: { not: null } },
  });
  if (baseline?.sourceOrder != null) {
    return baseline.sourceOrder;
  }
  const markers = z.array(z.object({ sourceOrder: z.number().int().nonnegative() })).parse(
    await tx.$queryRaw`
      SELECT "sourceOrder" FROM "AgentSourcePage"
      WHERE "connectionId" = ${connectionId} AND "phase" = 'FINALIZED' AND "sourceOrder" IS NOT NULL
        AND json_extract("evidence", '$.ids[0]') = ${head} LIMIT 1
    `
  );
  return markers[0]?.sourceOrder ?? null;
}

/** Legacy pages lack the cursor's previous boundary. Require an independent retained witness. */
export async function captureBoundary(
  tx: Tx,
  checkpoint: AgentSourceCheckpoint,
  page: AgentSourcePage,
  evidence: { ids: string[]; entries: AgentSourceEntry[] }
) {
  if (checkpoint.boundaryKnown) {
    return {};
  }
  const known = await tx.agentSourceHead.findMany({
    where: {
      connectionId: page.connectionId,
      scanId: page.scanId,
      providerEventId: { in: evidence.ids },
    },
    orderBy: { position: 'desc' },
    take: 1,
  });
  const anchor = known[0]?.providerEventId;
  const end = anchor ? evidence.ids.indexOf(anchor) : -1;
  // A continuation page may begin with the boundary and contain no captured head.
  // Its first identity still requires an independent canonical witness below.
  const boundary =
    end >= 0 ? evidence.ids[end + 1] : checkpoint.entryCount > 0 ? evidence.ids[0] : undefined;
  if (boundary) {
    const order = await boundaryOrder(tx, page.connectionId, boundary);
    return order === null
      ? {}
      : { boundaryKnown: true, previousBoundaryEventId: boundary, initialSourceOrder: order };
  }
  if (page.nextPage === null && (end >= 0 || !evidence.ids.length)) {
    return { boundaryKnown: true, previousBoundaryEventId: null, initialSourceOrder: 0 };
  }
  return {};
}
