import { z } from 'zod';
import { prisma } from '@/backend/db';
import { ApplicationError } from '@/backend/lib/application-error';
import { agentSourcePageEvidenceSchema, type AgentSourceEntry } from '@/shared/agent-source-state';
import { agentTriggerInputSchema } from '@/shared/schemas/agent-definition.schema';
import type { Prisma } from '@prisma-gen/client';
type Tx = Prisma.TransactionClient;
/** The current epoch of a source. Only proof written in it is authority for ordinals. */
export type SourceEpoch = { connectionId: string; epoch: number; epochStartSourceOrder: number };
export function sourceEpoch(
  connectionId: string,
  state: { epoch: number; epochStartSourceOrder: number } | null
): SourceEpoch {
  return {
    connectionId,
    epoch: state?.epoch ?? 0,
    epochStartSourceOrder: state?.epochStartSourceOrder ?? 0,
  };
}
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
const slackTriggerWhere = {
  type: 'SLACK_MESSAGE' as const,
  isConfigured: true,
  agentDefinition: { project: { isArchived: false } },
  OR: [
    { activationState: 'STARTING' as const },
    { activationState: 'ACTIVE' as const, isEnabled: true, agentDefinition: { isEnabled: true } },
  ],
};
/**
 * Slack connections the listener should hold open, with the channels their
 * listening triggers select. Malformed trigger configuration selects nothing.
 */
export async function listSlackTargets(connectionId?: string) {
  const connections = await prisma.agentConnection.findMany({
    where: {
      ...(connectionId ? { id: connectionId } : {}),
      provider: 'SLACK',
      isEnabled: true,
      triggers: { some: slackTriggerWhere },
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      triggers: {
        where: slackTriggerWhere,
        select: {
          type: true,
          description: true,
          filterInstructions: true,
          isEnabled: true,
          connectionId: true,
          config: true,
        },
      },
    },
  });
  return connections.map((connection) => ({
    connectionId: connection.id,
    channelIds: [
      ...new Set(
        connection.triggers.flatMap((trigger) => {
          const parsed = agentTriggerInputSchema.safeParse(trigger);
          return parsed.success && parsed.data.type === 'SLACK_MESSAGE'
            ? parsed.data.config.channelIds
            : [];
        })
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

/** Rejected proof fences new preparation in its epoch; already-issued baseline IDs remain readable. */
export async function assertCheckpointProof(tx: Tx, { connectionId, epoch }: SourceEpoch) {
  const rejected = await tx.agentSourceCheckpoint.findFirst({
    where: { connectionId, epoch, status: 'INVALID' },
    select: { scanId: true },
  });
  if (rejected) {
    throw new ApplicationError('CONFLICT', 'Invalid historical source proof requires recovery.');
  }
}

/**
 * A baseline read can race a newer interval commit. Retained evidence of the current epoch
 * resolves its exact head; an identity's ordinal in an earlier epoch is not evidence.
 */
export async function historicalHeadOrder(tx: Tx, source: SourceEpoch, head: string | null) {
  const { connectionId, epoch } = source;
  await assertCheckpointProof(tx, source);
  if (head === null) {
    return source.epochStartSourceOrder;
  }
  const indexed = await tx.agentSourceHead.findFirst({
    where: {
      connectionId,
      epoch,
      providerEventId: head,
      checkpoint: { epoch, status: 'COMPLETE' },
    },
    include: { checkpoint: true },
  });
  if (indexed?.checkpoint.sourceOrder != null) {
    return indexed.checkpoint.sourceOrder - indexed.precedingEventCount;
  }
  // Initial heads have no captured interval. Their durable baseline is also an exact witness.
  const baseline = await tx.agentSourceBaseline.findFirst({
    where: { connectionId, epoch, headEventId: head, sourceOrder: { not: null } },
  });
  const legacy = await legacyHeadOrder(tx, source, head);
  if (legacy !== null && baseline?.sourceOrder != null && legacy !== baseline.sourceOrder) {
    throw new ApplicationError(
      'CONFLICT',
      'Conflicting historical source ordinals require recovery.'
    );
  }
  return legacy ?? baseline?.sourceOrder ?? null;
}

async function legacyHeadOrder(tx: Tx, { connectionId, epoch }: SourceEpoch, head: string) {
  const matches = z
    .array(z.object({ scanId: z.string(), checkpointStatus: z.string().nullable() }))
    .parse(
      await tx.$queryRaw`
    SELECT DISTINCT page."scanId", checkpoint."status" AS "checkpointStatus" FROM "AgentSourcePage" page
    LEFT JOIN "AgentSourceCheckpoint" checkpoint ON checkpoint."connectionId" = page."connectionId" AND checkpoint."scanId" = page."scanId"
    CROSS JOIN json_each(json_extract(page."evidence", '$.entries')) item
    WHERE page."connectionId" = ${connectionId} AND page."epoch" = ${epoch} AND page."phase" = 'CAPTURE'
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
