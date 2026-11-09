import { chmod } from 'node:fs/promises';
import Database from 'better-sqlite3';

/**
 * Copy a SQLite database with SQLite's online backup API, which produces a
 * consistent snapshot (including committed WAL pages) without a write lock.
 * The snapshot is readable only by its owner.
 */
export async function snapshotSqliteDatabase(
  databasePath: string,
  destinationPath: string
): Promise<void> {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    await database.backup(destinationPath);
    await chmod(destinationPath, 0o600);
  } finally {
    database.close();
  }
}
