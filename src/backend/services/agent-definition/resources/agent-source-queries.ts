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
      isConfigured: true,
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
          isConfigured: true,
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
        connection.triggers.flatMap(({ agentDefinition: { project } }) =>
          project.githubOwner && project.githubRepo
            ? [`${project.githubOwner}/${project.githubRepo}`]
            : []
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

/** Rejected proof fences new preparation; already-issued baseline IDs remain readable. */
export async function assertCheckpointProof(tx: Tx, connectionId: string) {
  const rejected = await tx.agentSourceCheckpoint.findFirst({
    where: { connectionId, status: 'INVALID' },
    select: { scanId: true },
  });
  if (rejected) {
    throw new ApplicationError('CONFLICT', 'Invalid historical source proof requires recovery.');
  }
}

/** A baseline read can race a newer interval commit. Retained evidence resolves its exact head. */
export async function historicalHeadOrder(tx: Tx, connectionId: string, head: string | null) {
  await assertCheckpointProof(tx, connectionId);
  if (head === null) {
    return 0;
  }
  const indexed = await tx.agentSourceHead.findFirst({
    where: {
      connectionId,
      providerEventId: head,
      checkpoint: { status: 'COMPLETE' },
    },
    include: { checkpoint: true },
  });
  if (indexed?.checkpoint.sourceOrder != null) {
    return indexed.checkpoint.sourceOrder - indexed.precedingEventCount;
  }
  // Initial heads have no captured interval. Their durable baseline is also an exact witness.
  const baseline = await tx.agentSourceBaseline.findFirst({
    where: { connectionId, headEventId: head, sourceOrder: { not: null } },
  });
  const legacy = await legacyHeadOrder(tx, connectionId, head);
  if (legacy !== null && baseline?.sourceOrder != null && legacy !== baseline.sourceOrder) {
    throw new ApplicationError(
      'CONFLICT',
      'Conflicting historical source ordinals require recovery.'
    );
  }
  return legacy ?? baseline?.sourceOrder ?? null;
}

async function legacyHeadOrder(tx: Tx, connectionId: string, head: string) {
  const matches = z
    .array(z.object({ scanId: z.string(), checkpointStatus: z.string().nullable() }))
    .parse(
      await tx.$queryRaw`
    SELECT DISTINCT page."scanId", checkpoint."status" AS "checkpointStatus" FROM "AgentSourcePage" page
    LEFT JOIN "AgentSourceCheckpoint" checkpoint ON checkpoint."connectionId" = page."connectionId" AND checkpoint."scanId" = page."scanId"
    CROSS JOIN json_each(json_extract(page."evidence", '$.entries')) item
    WHERE page."connectionId" = ${connectionId} AND page."phase" = 'CAPTURE'
      AND json_extract(item.value, '$.providerEventId') = ${head}
  `
    );
  let resolved: number | null = null;
  for (const { scanId, checkpointStatus } of matches) {
    if (checkpointStatus === 'INVALID') {
      throw new ApplicationError('CONFLICT', 'Invalid historical source proof requires recovery.');
    }
    const completed = await tx.agentSourcePage.findFirst({
      where: { connectionId, scanId, phase: 'FINALIZED' },
    });
    if (completed?.sourceOrder == null) {
      continue;
    }
    const entries = await entriesFor(tx, connectionId, scanId);
    const order = orderForHead(entries, head, completed.sourceOrder);
    if (resolved !== null && order !== null && resolved !== order) {
      throw new ApplicationError(
        'CONFLICT',
        'Conflicting historical source ordinals require recovery.'
      );
    }
    resolved = order ?? resolved;
  }
  return resolved;
}

function orderForHead(entries: AgentSourceEntry[], head: string, highwater: number) {
  let order = highwater;
  for (const entry of entries) {
    if (entry.providerEventId === head) {
      return order;
    }
    if (entry.eventId) {
      order--;
    }
  }
  return null;
}
