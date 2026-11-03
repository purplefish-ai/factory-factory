import { isAbsolute } from 'node:path';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { z } from 'zod';
import { createLogger } from '@/backend/services/logger.service';
import { PrismaClient, type Prisma } from '@prisma-gen/client';

const logger = createLogger('backup-snapshot');
const databaseListSchema = z.array(z.object({ name: z.string(), file: z.string() }));

/** Open the actual source database using a private, physically readonly snapshot. */
export async function withBackupSnapshot<T>(
  source: Pick<PrismaClient, '$queryRaw'>,
  read: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  const databases = databaseListSchema.parse(await source.$queryRaw`PRAGMA database_list`);
  const main = databases.filter((database) => database.name === 'main');
  const file = main[0]?.file;
  if (main.length !== 1 || !file || !isAbsolute(file)) {
    throw new Error('Backup requires exactly one file-backed main database');
  }
  const snapshot = new PrismaClient({
    adapter: new PrismaBetterSqlite3({
      url: file,
      readonly: true,
      fileMustExist: true,
      timeout: 5000, // SQLite busy wait, in milliseconds.
    }),
  });
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await snapshot.$transaction(read, { timeout: 120_000 }) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    await snapshot.$disconnect();
  } catch (error) {
    if (outcome.ok) {
      throw error;
    }
    logger.warn('Failed to disconnect backup snapshot after export failure', { error });
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
