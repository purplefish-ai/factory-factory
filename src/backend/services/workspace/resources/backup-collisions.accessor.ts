import type { Prisma, Project, WorkspacePREvent } from '@prisma-gen/client';

type EventIdentity = Pick<
  WorkspacePREvent,
  'id' | 'workspaceId' | 'prId' | 'deduplicationKey' | 'deliveryId'
>;
type ProjectIdentity = Pick<
  Project,
  'id' | 'slug' | 'repoPath' | 'worktreeBasePath' | 'githubOwner' | 'githubRepo'
>;

function* chunks<T>(values: readonly T[]) {
  const unique = [...new Set(values)];
  for (let index = 0; index < unique.length; index += 100) {
    yield unique.slice(index, index + 100);
  }
}

// Structured keys preserve exact pairs even when IDs contain separators.
function dedupKeys(event: Pick<EventIdentity, 'workspaceId' | 'prId' | 'deduplicationKey'>) {
  return [
    JSON.stringify(['workspace', event.workspaceId, event.deduplicationKey]),
    ...(event.prId === null ? [] : [JSON.stringify(['pr', event.prId, event.deduplicationKey])]),
  ];
}

export const backupCollisionsAccessor = {
  async readIdentities(
    tx: Prisma.TransactionClient,
    input: {
      projects: readonly Pick<Project, 'id' | 'slug'>[];
      workspaceIds: readonly string[];
      prIds: readonly string[];
    }
  ) {
    const projects = new Map<string, ProjectIdentity>();
    const workspaceIds = new Set<string>();
    const prIds = new Set<string>();
    for (const batch of chunks(input.projects)) {
      const rows = await tx.project.findMany({
        where: {
          OR: [{ id: { in: batch.map((p) => p.id) } }, { slug: { in: batch.map((p) => p.slug) } }],
        },
        select: {
          id: true,
          slug: true,
          repoPath: true,
          worktreeBasePath: true,
          githubOwner: true,
          githubRepo: true,
        },
      });
      for (const row of rows) {
        projects.set(row.id, row);
      }
    }
    for (const batch of chunks(input.workspaceIds)) {
      for (const row of await tx.workspace.findMany({
        where: { id: { in: batch } },
        select: { id: true },
      })) {
        workspaceIds.add(row.id);
      }
    }
    for (const batch of chunks(input.prIds)) {
      for (const row of await tx.workspacePR.findMany({
        where: { id: { in: batch } },
        select: { id: true },
      })) {
        prIds.add(row.id);
      }
    }
    return { projects: [...projects.values()], workspaceIds, prIds };
  },

  /** Passive evidence only: callers decide admission; no row is normalized or mutated. */
  async findEventConflicts(tx: Prisma.TransactionClient, events: readonly EventIdentity[]) {
    const eventIds = new Set<string>();
    const receiptIds = new Set<string>();
    const deduplicationKeys = new Set<string>();
    for (const batch of chunks(events)) {
      const receipts = [
        ...new Set(batch.flatMap((event) => (event.deliveryId === null ? [] : [event.deliveryId]))),
      ];
      // At most 700 bound values: IDs, both unique pairs, raw and normalized receipt references.
      const rows = await tx.workspacePREvent.findMany({
        where: {
          OR: [
            { id: { in: batch.map((event) => event.id) } },
            ...batch.map(({ workspaceId, deduplicationKey }) => ({
              workspaceId,
              deduplicationKey,
            })),
            ...batch.flatMap(({ prId, deduplicationKey }) =>
              prId === null ? [] : [{ prId, deduplicationKey }]
            ),
            { deliveryId: { in: receipts } },
            { batchId: { in: receipts } },
          ],
        },
        select: {
          id: true,
          workspaceId: true,
          prId: true,
          deduplicationKey: true,
          deliveryId: true,
          batchId: true,
        },
      });
      for (const row of rows) {
        eventIds.add(row.id);
        for (const key of dedupKeys(row)) {
          deduplicationKeys.add(key);
        }
        for (const id of [row.deliveryId, row.batchId].filter((id): id is string => id !== null)) {
          receiptIds.add(id);
        }
      }
      if (receipts.length) {
        for (const row of await tx.workspacePRDelivery.findMany({
          where: { id: { in: receipts } },
          select: { id: true },
        })) {
          receiptIds.add(row.id);
        }
      }
    }
    // Map against the entire input, including every group referring to a hit from a later chunk.
    return new Set(
      events
        .filter(
          (event) =>
            eventIds.has(event.id) ||
            dedupKeys(event).some((key) => deduplicationKeys.has(key)) ||
            (event.deliveryId !== null && receiptIds.has(event.deliveryId))
        )
        .map((event) => event.workspaceId)
    );
  },
};
