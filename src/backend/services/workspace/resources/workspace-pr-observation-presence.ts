import { z } from 'zod';
import { Prisma } from '@prisma-gen/client';

const idRowsSchema = z.array(z.object({ id: z.string() }));

/**
 * Polled PR reads leave the `observation` blob (review bodies included) out,
 * but the terminal polling policy needs to know whether one is stored. This
 * returns which of `prIds` have none: SQL NULL or JSON null, both of which a
 * full read returns as `null`. Read it in the same transaction as the rows it
 * annotates.
 *
 * SQLite answers `typeof()` and `octet_length()` from the record header, so
 * only 4-byte values are compared with `'null'`. Prisma's `equals: AnyNull`
 * compiles to `"observation" = 'null'`, which reads every stored observation,
 * overflow pages included.
 */
export async function findPRIdsWithoutObservation(
  client: Prisma.TransactionClient,
  prIds: readonly string[]
): Promise<Set<string>> {
  if (prIds.length === 0) {
    return new Set();
  }
  const rows = idRowsSchema.parse(
    await client.$queryRaw`SELECT "id" FROM "WorkspacePR" WHERE "id" IN (${Prisma.join(prIds)}) AND (typeof("observation") = 'null' OR (octet_length("observation") = 4 AND "observation" = 'null'))`
  );
  return new Set(rows.map(({ id }) => id));
}

/** Annotate blob-free PR rows with the presence flag `shouldPollPR` reads. */
export function withObservationPresence<T extends { id: string }>(
  prs: T[],
  withoutObservation: ReadonlySet<string>
): (T & { hasObservation: boolean })[] {
  return prs.map((pr) => ({ ...pr, hasObservation: !withoutObservation.has(pr.id) }));
}
