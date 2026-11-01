import { prisma } from '@/backend/db';
import type { Prisma } from '@prisma-gen/client';

/** Serialize read/decision/write sequences with SQLite's write lock, including empty queues. */
export function ledgerTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE "AgentDefinition" SET "definitionRevision" = "definitionRevision" WHERE 0`;
    return operation(tx);
  });
}
