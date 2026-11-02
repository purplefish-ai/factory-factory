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
  // A continuation page may begin with the boundary and contain no captured head.
  // Its first identity still requires an independent canonical witness below.
  const boundary =
    end >= 0 ? evidence.ids[end + 1] : checkpoint.entryCount > 0 ? evidence.ids[0] : undefined;
  if (boundary) {
    return { boundaryKnown: true, previousBoundaryEventId: boundary };
  }
  if (page.nextPage === null && (end >= 0 || !evidence.ids.length)) {
    return { boundaryKnown: true, previousBoundaryEventId: null, initialSourceOrder: 0 };
  }
  return {};
}
