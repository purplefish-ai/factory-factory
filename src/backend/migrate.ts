/**
 * Simple migration runner for Electron.
 * Uses better-sqlite3 directly to avoid Prisma CLI complexity.
 *
 * Environment variables:
 *   DATABASE_PATH - Path to SQLite database file
 *   MIGRATIONS_PATH - Path to prisma/migrations directory
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// Simple log function for migration output
const log = (msg: string) => process.stdout.write(`${msg}\n`);
const logError = (msg: string) => process.stderr.write(`${msg}\n`);

const databasePath = process.env.DATABASE_PATH;
const migrationsPath = process.env.MIGRATIONS_PATH;

if (!databasePath) {
  logError('DATABASE_PATH environment variable is required');
  process.exit(1);
}

if (!migrationsPath) {
  logError('MIGRATIONS_PATH environment variable is required');
  process.exit(1);
}

log(`Database: ${databasePath}`);
log(`Migrations: ${migrationsPath}`);

const db = new Database(databasePath);

try {
  // Create migrations tracking table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS _prisma_migrations (
      id TEXT PRIMARY KEY,
      migration_name TEXT NOT NULL UNIQUE,
      finished_at DATETIME,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      applied_steps_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Get list of applied migrations
  const appliedMigrations = new Set(
    (
      db
        .prepare('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL')
        .all() as Array<{ migration_name: string }>
    ).map((row) => row.migration_name)
  );

  // Read migration directories (sorted by name = chronological order)
  const migrationDirs = readdirSync(migrationsPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const migrationName of migrationDirs) {
    if (appliedMigrations.has(migrationName)) {
      log(`Skipping already applied: ${migrationName}`);
      continue;
    }

    const sqlPath = join(migrationsPath, migrationName, 'migration.sql');
    if (!existsSync(sqlPath)) {
      log(`No migration.sql found in ${migrationName}, skipping`);
      continue;
    }

    log(`Applying: ${migrationName}`);
    const sql = readFileSync(sqlPath, 'utf-8');

    // Record migration start
    const id = crypto.randomUUID();
    db.prepare(
      'INSERT INTO _prisma_migrations (id, migration_name, started_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
    ).run(id, migrationName);

    try {
      // Execute the migration
      db.exec(sql);

      // Record migration completion
      db.prepare(
        'UPDATE _prisma_migrations SET finished_at = CURRENT_TIMESTAMP, applied_steps_count = 1 WHERE id = ?'
      ).run(id);

      log(`Applied: ${migrationName}`);
    } catch (err) {
      // Remove the incomplete migration record so it can be retried
      db.prepare('DELETE FROM _prisma_migrations WHERE id = ?').run(id);
      throw err;
    }
  }

  log('All migrations complete');
} finally {
  db.close();
}
