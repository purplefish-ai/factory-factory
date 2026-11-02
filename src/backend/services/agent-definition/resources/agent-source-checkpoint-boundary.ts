import type { AgentSourceEntry } from '@/shared/agent-source-state';
import type { AgentSourceCheckpoint, AgentSourcePage, Prisma } from '@prisma-gen/client';

type Tx = Prisma.TransactionClient;
/** Recover the boundary identity; bounded promotion proves its canonical ordinal against every witness. */
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
  let boundary = end >= 0 ? evidence.ids[end + 1] : undefined;
  if (end < 0 && checkpoint.entryCount > 0 && evidence.ids.length) {
    // A boundary-only continuation ends capture; an overlap-search observation does not.
    // Legacy replay has the next retained page, so this unique lookup distinguishes them.
    const next = await tx.agentSourcePage.findUnique({
      where: {
        connectionId_scanId_ordinal: {
          connectionId: page.connectionId,
          scanId: page.scanId,
          ordinal: page.ordinal + 1,
        },
      },
      select: { phase: true },
    });
    if (next?.phase === 'VERIFY') {
      boundary = evidence.ids[0];
    }
  }
  if (boundary) {
    return { boundaryKnown: true, previousBoundaryEventId: boundary };
  }
  if (page.nextPage === null && (end >= 0 || !evidence.ids.length)) {
    return { boundaryKnown: true, previousBoundaryEventId: null, initialSourceOrder: 0 };
  }
  return {};
}
