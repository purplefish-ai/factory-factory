import { isAbsolute } from 'node:path';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import { PrismaClient, type Prisma } from '@prisma-gen/client';

/** Ordinary adapter queries do not join its transaction mutex. A private reader
 * prevents app writes from entering the snapshot or being rolled back with it.
 */
export async function withBackupSnapshot<T>(
  source: Pick<PrismaClient, '$queryRaw'>,
  read: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  const databases = z
    .array(z.object({ name: z.string(), file: z.string() }))
    .parse(await source.$queryRaw`PRAGMA database_list`);
  const databasePath = databases.find((database) => database.name === 'main')?.file;
  if (!(databasePath && isAbsolute(databasePath))) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Logical export requires a file-backed database.'
    );
  }
  const reader = new PrismaClient({
    adapter: new PrismaBetterSqlite3({
      url: databasePath,
      readonly: true,
      fileMustExist: true,
      timeout: 5000,
    }),
  });
  try {
    return await reader.$transaction(read);
  } finally {
    await reader.$disconnect();
  }
}
