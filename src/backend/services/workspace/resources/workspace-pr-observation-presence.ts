import { prisma } from '@/backend/db';
import { Prisma } from '@prisma-gen/client';

/**
 * Polled PR reads leave the `observation` blob (review bodies included) out,
 * but the terminal polling policy needs to know whether one is stored. This
 * reads the ids of the PRs matching `where` that have none: SQL NULL or JSON
 * null, both of which a full read returns as `null`. Run it in the same batch
 * transaction as the rows it annotates so both see one snapshot.
 */
export function findPRIdsWithoutObservation(where: Prisma.WorkspacePRWhereInput) {
  return prisma.workspacePR.findMany({
    where: { AND: [where, { observation: { equals: Prisma.AnyNull } }] },
    select: { id: true },
  });
}

/** Annotate blob-free PR rows with the presence flag `shouldPollPR` reads. */
export function withObservationPresence<T extends { id: string }>(
  prs: T[],
  withoutObservation: ReadonlySet<string>
): (T & { hasObservation: boolean })[] {
  return prs.map((pr) => ({ ...pr, hasObservation: !withoutObservation.has(pr.id) }));
}
