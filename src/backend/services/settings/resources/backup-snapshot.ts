import { isAbsolute } from 'node:path';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import { TunedPrismaBetterSqlite3 } from '@/backend/lib/sqlite-adapter';
import { createLogger } from '@/backend/services/logger.service';
import { PrismaClient, type Prisma } from '@prisma-gen/client';

const logger = createLogger('backup-snapshot');
const databaseListSchema = z.array(z.object({ name: z.string(), file: z.string() }));

async function mainDatabaseFile(source: Pick<PrismaClient, '$queryRaw'>): Promise<string> {
  const databases = databaseListSchema.parse(await source.$queryRaw`PRAGMA database_list`);
  const main = databases.filter((database) => database.name === 'main');
  const file = main[0]?.file;
  if (main.length !== 1 || !file || !isAbsolute(file)) {
    throw new Error('Backup requires exactly one file-backed main database');
  }
  return file;
}

/** Open the actual source database using a private, physically readonly snapshot. */
export async function withBackupSnapshot<T>(
  source: Pick<PrismaClient, '$queryRaw'>,
  read: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  const file = await mainDatabaseFile(source);
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

const failureSchema = z.object({
  code: z.union([z.string(), z.number()]).optional(),
  originalCode: z.union([z.string(), z.number()]).optional(),
  cause: z.unknown().optional(),
  meta: z.unknown().optional(),
  driverAdapterError: z.unknown().optional(),
});

function isSqliteBusyCode(code: string | number | undefined): boolean {
  if (typeof code === 'number') {
    return Number.isInteger(code) && (code & 255) === 5;
  }
  if (typeof code !== 'string') {
    return false;
  }
  if (/^SQLITE_BUSY(?:_[A-Z0-9]+)*$/.test(code)) {
    return true;
  }
  const extended = /^UNKNOWN_SQLITE_ERROR_(\d+)$/.exec(code)?.[1];
  return extended !== undefined && (Number(extended) & 255) === 5;
}

function isImportContention(error: unknown): boolean {
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length) {
    const candidate = pending.pop();
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const parsed = failureSchema.safeParse(candidate);
    if (!parsed.success) {
      continue;
    }
    const failure = parsed.data;
    if (failure.code === 'P2028' || failure.code === 'P1008') {
      return true;
    }
    if (isSqliteBusyCode(failure.code) || isSqliteBusyCode(failure.originalCode)) {
      return true;
    }
    pending.push(failure.cause, failure.meta, failure.driverAdapterError);
  }
  return false;
}

/** All existing-format import owners share one private, bounded writer transaction. */
export async function withBackupImport<T>(
  source: Pick<PrismaClient, '$queryRaw'>,
  write: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  let writer: PrismaClient | undefined;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    const file = await mainDatabaseFile(source);
    writer = new PrismaClient({
      adapter: new TunedPrismaBetterSqlite3({ url: file, fileMustExist: true, timeout: 5000 }),
    });
    outcome = { ok: true, value: await writer.$transaction(write, { timeout: 120_000 }) };
  } catch (error) {
    outcome = {
      ok: false,
      error: isImportContention(error)
        ? new ApplicationError(
            'CONFLICT',
            'Database is busy or the import expired. Retry the whole import.',
            { cause: error }
          )
        : error,
    };
  }
  try {
    await writer?.$disconnect();
  } catch (error) {
    // The import committed; cleanup cannot authorize a retry.
    if (outcome.ok) {
      throw error;
    }
    logger.warn('Failed to disconnect backup writer after import failure', { error });
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
