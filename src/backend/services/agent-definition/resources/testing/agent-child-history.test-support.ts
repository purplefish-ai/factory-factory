import { childHistoryIsClear } from '@/backend/services/agent-definition/resources/agent-run-settlement.accessor';
import type { PrismaClient } from '@prisma-gen/client';

/** Exercise the production settlement fence without exposing a raw accessor. */
export function readChildHistoryClearForTest(prisma: PrismaClient, runId: string) {
  return prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.findUniqueOrThrow({
      where: { id: runId },
      include: { agentDefinition: true },
    });
    return childHistoryIsClear(tx, run);
  });
}
