import type { ExportData } from '@/shared/schemas/export-data.schema';
import type { Prisma } from '@prisma-gen/client';

/** Generic decision history reserves an ID across all three live owner types. */
export async function readRecoveryOwnerConflicts(
  tx: Prisma.TransactionClient,
  data: ExportData['data']
): Promise<ReadonlySet<string>> {
  const { conflicts, seen } = candidateOwners(data);
  const candidates = [...seen];
  for (let start = 0; start < candidates.length; start += 200) {
    const ids = candidates.slice(start, start + 200);
    const [sessions, runs, definitions, decisions] = await Promise.all([
      tx.agentSession.findMany({ where: { id: { in: ids } }, select: { id: true } }),
      tx.agentRun.findMany({ where: { id: { in: ids } }, select: { id: true } }),
      tx.agentDefinition.findMany({ where: { id: { in: ids } }, select: { id: true } }),
      tx.decisionLog.groupBy({ by: ['agentId'], where: { agentId: { in: ids } } }),
    ]);
    for (const rows of [sessions, runs, definitions]) {
      for (const row of rows) {
        conflicts.add(row.id);
      }
    }
    for (const row of decisions) {
      conflicts.add(row.agentId);
    }
  }
  return conflicts;
}

function candidateOwners(data: ExportData['data']) {
  const conflicts = new Set<string>();
  const seen = new Set<string>();
  for (const rows of [
    data.agentSessions,
    data.durable?.agentDefinition ?? [],
    data.durable?.agentRun ?? [],
  ]) {
    for (const row of rows) {
      if (seen.has(row.id)) {
        conflicts.add(row.id);
      }
      seen.add(row.id);
    }
  }
  return { conflicts, seen };
}
