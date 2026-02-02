/**
 * Simple migration runner for Electron.
 * Uses better-sqlite3 directly to avoid Prisma CLI complexity.
 *
 * Can be used in two ways:
 * 1. As a module: import { runMigrations } from './migrate'
 * 2. As a script: node migrate.js (uses environment variables)
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export interface MigrationOptions {
  databasePath: string;
  migrationsPath: string;
  log?: (msg: string) => void;
}

/**
 * Run database migrations.
 * @param options - Migration configuration
 * @throws Error if migrations fail
 */
export function runMigrations(options: MigrationOptions): void {
  // biome-ignore lint/suspicious/noConsole: CLI tool uses console as default logger
  const { databasePath, migrationsPath, log = console.log } = options;

  log(`[migrate] Database: ${databasePath}`);
  log(`[migrate] Migrations: ${migrationsPath}`);

  const db = new Database(databasePath);

  try {
    // Create migrations tracking table if it doesn't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS _prisma_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL DEFAULT '',
        migration_name TEXT NOT NULL UNIQUE,
        finished_at DATETIME,
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        applied_steps_count INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Add checksum column if it doesn't exist (for existing databases)
    const columns = db.prepare('PRAGMA table_info(_prisma_migrations)').all() as Array<{
      name: string;
    }>;
    if (!columns.some((col) => col.name === 'checksum')) {
      db.exec(`ALTER TABLE _prisma_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''`);
    }

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
        log(`[migrate] Skipping already applied: ${migrationName}`);
        continue;
      }

      const sqlPath = join(migrationsPath, migrationName, 'migration.sql');
      if (!existsSync(sqlPath)) {
        log(`[migrate] No migration.sql found in ${migrationName}, skipping`);
        continue;
      }

      log(`[migrate] Applying: ${migrationName}`);
      const sql = readFileSync(sqlPath, 'utf-8');

      // Record migration start
      const id = crypto.randomUUID();
      const checksum = createHash('sha256').update(sql).digest('hex');
      db.prepare(
        'INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)'
      ).run(id, checksum, migrationName);

      try {
        // Execute the migration
        db.exec(sql);

        // Record migration completion
        db.prepare(
          'UPDATE _prisma_migrations SET finished_at = CURRENT_TIMESTAMP, applied_steps_count = 1 WHERE id = ?'
        ).run(id);

        log(`[migrate] Applied: ${migrationName}`);
      } catch (err) {
        // Remove the incomplete migration record so it can be retried
        db.prepare('DELETE FROM _prisma_migrations WHERE id = ?').run(id);
        throw err;
      }
    }

    log('[migrate] All migrations complete');
  } finally {
    db.close();
  }
}

// CLI entry point - run if executed directly
// Check if this module is being run directly (not imported)
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const databasePath = process.env.DATABASE_PATH;
  const migrationsPath = process.env.MIGRATIONS_PATH;

  if (!databasePath) {
    // biome-ignore lint/suspicious/noConsole: CLI entry point
    console.error('DATABASE_PATH environment variable is required');
    process.exit(1);
  }

  if (!migrationsPath) {
    // biome-ignore lint/suspicious/noConsole: CLI entry point
    console.error('MIGRATIONS_PATH environment variable is required');
    process.exit(1);
  }

  try {
    runMigrations({ databasePath, migrationsPath });
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: CLI entry point
    console.error('Migration failed:', error);
    process.exit(1);
  }
}
