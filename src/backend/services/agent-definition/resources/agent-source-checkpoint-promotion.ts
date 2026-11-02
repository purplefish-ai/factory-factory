import { z } from 'zod';
import type { Prisma } from '@prisma-gen/client';

type Tx = Prisma.TransactionClient;

/** No interval becomes authoritative while a legacy finalized interval is still unindexed. */
export async function checkpointPromotionStatus(tx: Tx, connectionId: string, scanId: string) {
  const pending = z.array(z.object({ scanId: z.string() })).parse(
    await tx.$queryRaw`
    SELECT page."scanId" FROM "AgentSourcePage" page
    LEFT JOIN "AgentSourceCheckpoint" checkpoint ON checkpoint."connectionId" = page."connectionId"
      AND checkpoint."scanId" = page."scanId"
    WHERE page."connectionId" = ${connectionId} AND page."phase" = 'FINALIZED'
      AND (checkpoint."status" IS NULL OR checkpoint."status" IN ('BUILDING', 'INVALID')) LIMIT 1
  `
  );
  if (pending.length) {
    return;
  }
  const checkpoint = await tx.agentSourceCheckpoint.findUniqueOrThrow({
    where: { connectionId_scanId: { connectionId, scanId } },
  });
  const conflicts = z.array(z.object({ providerEventId: z.string() })).parse(
    await tx.$queryRaw`
    SELECT head."providerEventId" FROM "AgentSourceHead" head
    WHERE head."connectionId" = ${connectionId} AND head."scanId" = ${scanId}
      AND (
        EXISTS (SELECT 1 FROM "AgentSourceBaseline" baseline
          WHERE baseline."connectionId" = head."connectionId" AND baseline."headEventId" = head."providerEventId"
            AND baseline."sourceOrder" IS NOT NULL
            AND baseline."sourceOrder" != ${checkpoint.sourceOrder} - head."precedingEventCount")
        OR EXISTS (SELECT 1 FROM "AgentSourceHead" other
          JOIN "AgentSourceCheckpoint" completed ON completed."connectionId" = other."connectionId" AND completed."scanId" = other."scanId"
          WHERE other."connectionId" = head."connectionId" AND other."providerEventId" = head."providerEventId"
            AND completed."sourceOrder" IS NOT NULL
            AND completed."sourceOrder" - other."precedingEventCount" != ${checkpoint.sourceOrder} - head."precedingEventCount")
      ) LIMIT 1
  `
  );
  return conflicts.length ? ('INVALID' as const) : ('COMPLETE' as const);
}
