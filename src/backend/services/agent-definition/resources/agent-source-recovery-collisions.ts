import type { DurableRecovery } from '@/shared/schemas/durable-recovery.schema';
import type { Prisma } from '@prisma-gen/client';

// A collision invalidates the import's whole source proof graph. Never attach
// imported proof to a local connection or restore only a suffix of its pages.
export async function conflictingRecoverySourceConnections(
  tx: Prisma.TransactionClient,
  data: DurableRecovery
): Promise<ReadonlySet<string>> {
  const blocked = new Set<string>();
  for (const rows of [data.agentSourcePage, data.agentSourceBaseline]) {
    for (let start = 0; start < rows.length; start += 200) {
      const batch = rows.slice(start, start + 200);
      const ids = batch.map((row) => row.id);
      const existing =
        rows === data.agentSourcePage
          ? await tx.agentSourcePage.findMany({ where: { id: { in: ids } }, select: { id: true } })
          : await tx.agentSourceBaseline.findMany({
              where: { id: { in: ids } },
              select: { id: true },
            });
      const collisions = new Set(existing.map((row) => row.id));
      for (const row of batch) {
        if (collisions.has(row.id)) {
          blocked.add(row.connectionId);
        }
      }
    }
  }
  return blocked;
}
