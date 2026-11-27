import { chmod, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';

/** `better-sqlite3` copies this many pages per step; a step count above any real database means one step. */
const ALL_PAGES_IN_ONE_STEP = 2_147_483_647;

/**
 * Copy a SQLite database with SQLite's online backup API, which produces a
 * consistent snapshot (including committed WAL pages) without a write lock.
 * The copy is one step, a single WAL read transaction that does not block
 * writers: a stepped copy restarts whenever another connection commits, so it
 * never finishes beside a busy backend. The snapshot is readable only by its owner.
 */
export async function snapshotSqliteDatabase(
  databasePath: string,
  destinationPath: string
): Promise<void> {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    // Restrict the destination before any page is copied into it.
    await writeFile(destinationPath, '', { mode: 0o600 });
    await chmod(destinationPath, 0o600);
    await database.backup(destinationPath, { progress: () => ALL_PAGES_IN_ONE_STEP });
    await chmod(destinationPath, 0o600);
  } finally {
    database.close();
  }
}
