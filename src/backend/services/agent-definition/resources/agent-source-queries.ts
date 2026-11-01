import { z } from 'zod';
import { prisma } from '@/backend/db';
import { ApplicationError } from '@/backend/lib/application-error';
import { agentSourcePageEvidenceSchema, type AgentSourceEntry } from '@/shared/agent-source-state';
import type { Prisma } from '@prisma-gen/client';
type Tx = Prisma.TransactionClient;
const targetWhere = {
  provider: 'GITHUB' as const,
  isEnabled: true,
  triggers: {
    some: {
      type: 'GITHUB_ISSUE' as const,
      agentDefinition: { project: { isArchived: false } },
      OR: [
        { activationState: 'STARTING' as const },
        {
          activationState: 'ACTIVE' as const,
          isEnabled: true,
          agentDefinition: { isEnabled: true },
        },
      ],
    },
  },
};
export async function listTargets(tx: Tx = prisma) {
  const connections = await tx.agentConnection.findMany({
    where: targetWhere,
    select: {
      id: true,
      externalId: true,
      triggers: {
        where: {
          type: 'GITHUB_ISSUE',
          agentDefinition: { project: { isArchived: false } },
          OR: [
            { activationState: 'STARTING' },
            { activationState: 'ACTIVE', isEnabled: true, agentDefinition: { isEnabled: true } },
          ],
        },
        select: {
          agentDefinition: {
            select: { project: { select: { githubOwner: true, githubRepo: true } } },
          },
        },
      },
    },
  });
  return connections.map((connection) => ({
    connectionId: connection.id,
    repositoryId: connection.externalId.replace(/^gh:/, ''),
    repositories: [
      ...new Set(
        connection.triggers.map(({ agentDefinition: { project } }) =>
          project.githubOwner && project.githubRepo
            ? `${project.githubOwner}/${project.githubRepo}`
            : ''
        )
      ),
    ],
  }));
}
export async function assertTarget(tx: Tx, connectionId: string) {
  if (
    !(await tx.agentConnection.findFirst({
      where: { ...targetWhere, id: connectionId },
      select: { id: true },
    }))
  ) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'The GitHub source has no active or starting trigger in an active project.'
    );
  }
}
export async function entriesFor(
  tx: Tx,
  connectionId: string,
  scanId: string
): Promise<AgentSourceEntry[]> {
  const pages = await tx.agentSourcePage.findMany({
    where: { connectionId, scanId, phase: 'CAPTURE' },
    orderBy: { ordinal: 'asc' },
  });
  return pages.flatMap((page) => agentSourcePageEvidenceSchema.parse(page.evidence).entries);
}
export async function getState(connectionId: string) {
  return await prisma.agentSourceState.findUnique({ where: { connectionId } });
}
export async function getBaseline(connectionId: string, id: string) {
  const row = await prisma.agentSourceBaseline.findFirst({ where: { id, connectionId } });
  return row
    ? {
        id: row.id,
        boundary:
          row.sourceOrder === null
            ? null
            : {
                provider: 'GITHUB' as const,
                headEventId: row.headEventId,
                sourceOrder: row.sourceOrder,
              },
      }
    : null;
}

/** A baseline read can race a newer interval commit. Retained evidence resolves its exact head. */
export async function historicalHeadOrder(tx: Tx, connectionId: string, head: string | null) {
  if (head === null) {
    return 0;
  }
  const matches = z.array(z.object({ scanId: z.string() })).parse(
    await tx.$queryRaw`
    SELECT DISTINCT page."scanId" FROM "AgentSourcePage" page,
      json_each(json_extract(page."evidence", '$.entries')) item
    WHERE page."connectionId" = ${connectionId} AND page."phase" = 'CAPTURE'
      AND json_extract(item.value, '$.providerEventId') = ${head}
  `
  );
  for (const { scanId } of matches) {
    const completed = await tx.agentSourcePage.findFirst({
      where: { connectionId, scanId, phase: 'FINALIZED' },
    });
    if (completed?.sourceOrder == null) {
      continue;
    }
    const entries = await entriesFor(tx, connectionId, scanId);
    let order = completed.sourceOrder;
    for (const entry of entries) {
      if (entry.providerEventId === head) {
        return order;
      }
      if (entry.eventId) {
        order--;
      }
    }
  }
  return null;
}
