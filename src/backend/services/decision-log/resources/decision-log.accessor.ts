import { prisma } from '@/backend/db';
import { retainedReferenceAllowed, type RecoveryImportedIds } from '@/shared/recovery-graph';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import type { DecisionLog, Prisma } from '@prisma-gen/client';

class DecisionLogAccessor {
  findById(id: string): Promise<DecisionLog | null> {
    return prisma.decisionLog.findUnique({
      where: { id },
    });
  }

  findByAgentId(agentId: string, limit = 50): Promise<DecisionLog[]> {
    return prisma.decisionLog.findMany({
      where: { agentId },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }

  findRecent(limit = 100): Promise<DecisionLog[]> {
    return prisma.decisionLog.findMany({
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }

  delete(id: string): Promise<DecisionLog> {
    return prisma.decisionLog.delete({
      where: { id },
    });
  }

  /**
   * List decision logs with optional filters
   */
  list(options: { agentId?: string; limit?: number }): Promise<DecisionLog[]> {
    const { agentId, limit = 100 } = options;

    if (agentId) {
      return this.findByAgentId(agentId, limit);
    }
    return this.findRecent(limit);
  }
}

export const decisionLogAccessor = new DecisionLogAccessor();

export async function restoreRecoveryDecisions(
  tx: Prisma.TransactionClient,
  data: ExportData['data'],
  ids: RecoveryImportedIds,
  definitions: ReadonlySet<string>
) {
  const sourceOwners = new Set([
    ...data.agentSessions.map((row) => row.id),
    ...(data.durable?.agentRun.map((row) => row.id) ?? []),
    ...(data.durable?.agentDefinition.map((row) => row.id) ?? []),
  ]);
  const importedOwners = new Set([...ids.sessions, ...ids.runs, ...definitions]);
  for (const row of data.durable?.decisionLog ?? []) {
    const existingOwner =
      (await tx.agentSession.findUnique({ where: { id: row.agentId } })) ??
      (await tx.agentRun.findUnique({ where: { id: row.agentId } })) ??
      (await tx.agentDefinition.findUnique({ where: { id: row.agentId } }));
    if (
      !retainedReferenceAllowed(sourceOwners, importedOwners, row.agentId, !!existingOwner) ||
      (await tx.decisionLog.findUnique({ where: { id: row.id } }))
    ) {
      continue;
    }
    await tx.decisionLog.create({ data: row });
  }
}
