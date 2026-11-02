import { isAbsolute } from 'node:path';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import { toError } from '@/backend/lib/error-utils';
import { TunedPrismaBetterSqlite3 } from '@/backend/lib/sqlite-adapter';
import { createLogger } from '@/backend/services/logger.service';
import { PrismaClient, Prisma } from '@prisma-gen/client';

const logger = createLogger('backup-connection');
// A bounded 64 MiB package can require many owner writes; this is separate
// from SQLite's five-second busy wait and never makes imports unbounded.
const BACKUP_TRANSACTION_TIMEOUT_MS = 120_000;
type BackupSource = Pick<PrismaClient, '$queryRaw'>;
type BackupOperation<T> = (tx: Prisma.TransactionClient) => Promise<T>;

/** Private connections prevent ordinary app writes from joining an awaiting
 * backup transaction and being included in its snapshot or rollback.
 */
export function withBackupSnapshot<T>(source: BackupSource, read: BackupOperation<T>): Promise<T> {
  return withBackupConnection(source, 'read', read);
}

/** A concurrent app commit can invalidate the deferred import snapshot. The
 * whole import then fails with CONFLICT and can be explicitly retried.
 */
export function withBackupImport<T>(source: BackupSource, write: BackupOperation<T>): Promise<T> {
  return withBackupConnection(source, 'write', write);
}

async function withBackupConnection<T>(
  source: BackupSource,
  mode: 'read' | 'write',
  operation: BackupOperation<T>
): Promise<T> {
  const databases = z
    .array(z.object({ name: z.string(), file: z.string() }))
    .parse(await source.$queryRaw`PRAGMA database_list`);
  const databasePath = databases.find((database) => database.name === 'main')?.file;
  if (!(databasePath && isAbsolute(databasePath))) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Logical backup requires a file-backed database.'
    );
  }
  const connection = new PrismaClient({
    adapter:
      mode === 'read'
        ? new PrismaBetterSqlite3({
            url: databasePath,
            readonly: true,
            fileMustExist: true,
            timeout: 5000,
          })
        : new TunedPrismaBetterSqlite3({ url: databasePath, fileMustExist: true }),
  });
  let failed = false;
  try {
    return await connection.$transaction(operation, { timeout: BACKUP_TRANSACTION_TIMEOUT_MS });
  } catch (error) {
    failed = true;
    // SQLite contention is P1008; an exhausted interactive transaction is P2028.
    // No import effects commit on this failure; retry uses a fresh snapshot.
    if (
      mode === 'write' &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P1008' || error.code === 'P2028')
    ) {
      throw new ApplicationError(
        'CONFLICT',
        'Database changed, is busy, or import exceeded its time budget. Retry the whole import.',
        { cause: error }
      );
    }
    throw error;
  } finally {
    await closeBackupConnection(connection, failed);
  }
}

async function closeBackupConnection(
  connection: PrismaClient,
  operationFailed: boolean
): Promise<void> {
  try {
    await connection.$disconnect();
  } catch (error) {
    if (!operationFailed) {
      throw error;
    }
    logger.error('Failed to close backup connection after operation failure', toError(error));
  }
}
