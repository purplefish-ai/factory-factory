import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

/**
 * Connection pragmas for the app database.
 *
 * better-sqlite3 runs every query on the main thread, so write latency is
 * event-loop latency. SQLite's defaults (rollback journal, synchronous=FULL)
 * fsync on every commit; WAL with synchronous=NORMAL avoids that while staying
 * corruption-safe (a power loss can drop only the last commits). journal_mode
 * persists in the file; the others are per-connection.
 */
export const SQLITE_CONNECTION_PRAGMAS = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA busy_timeout = 5000;',
  'PRAGMA temp_store = MEMORY;',
  'PRAGMA cache_size = -65536;',
].join('\n');

/** Prisma better-sqlite3 adapter that applies {@link SQLITE_CONNECTION_PRAGMAS} on every connection. */
export class TunedPrismaBetterSqlite3 extends PrismaBetterSqlite3 {
  override async connect(): ReturnType<PrismaBetterSqlite3['connect']> {
    const adapter = await super.connect();
    await adapter.executeScript(SQLITE_CONNECTION_PRAGMAS);
    return adapter;
  }
}
