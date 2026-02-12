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

function writeStdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Parse migration SQL to separate PRAGMAs from DDL/DML statements.
 * PRAGMAs must execute outside a transaction in SQLite.
 *
 * IMPORTANT: This parser is designed for Prisma-generated DDL migrations,
 * which never contain multi-line string literals. It uses a simple line-based
 * approach that:
 * - Strips comment lines (starting with --)
 * - Separates PRAGMA statements from DDL/DML
 * - Preserves order (pre-pragmas, DDL, post-pragmas)
 *
 * LIMITATION: This parser does NOT handle multi-line string literals correctly.
 * If a custom migration contains a multi-line string with "--" or "PRAGMA" in it,
 * the parser will incorrectly strip or extract those lines. This is acceptable
 * because Prisma DDL migrations never have this pattern. For custom migrations
 * with data, avoid multi-line strings or use db.exec() directly.
 */
function parseMigrationSql(migrationSql: string): {
  prePragmas: string[];
  ddlDml: string;
  postPragmas: string[];
} {
  const lines = migrationSql.split('\n');
  const prePragmas: string[] = [];
  const postPragmas: string[] = [];
  const ddlDml: string[] = [];
  let foundNonPragma = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--')) {
      // Skip empty lines and comments
      continue;
    }

    if (trimmed.toUpperCase().startsWith('PRAGMA ')) {
      // Collect PRAGMAs before first non-PRAGMA as "pre"
      // Collect PRAGMAs after non-PRAGMAs as "post"
      if (foundNonPragma) {
        postPragmas.push(trimmed);
      } else {
        prePragmas.push(trimmed);
      }
    } else {
      foundNonPragma = true;
      ddlDml.push(line);
    }
  }

  return {
    prePragmas,
    ddlDml: ddlDml.join('\n'),
    postPragmas,
  };
}

/**
 * Apply a single migration file to the database.
 */
function applySingleMigration(
  db: Database.Database,
  migrationName: string,
  sql: string,
  checksum: string,
  log: (msg: string) => void
): void {
  const { prePragmas, ddlDml, postPragmas } = parseMigrationSql(sql);

  // Define an atomic transaction for the migration
  // This includes only DDL/DML statements, not PRAGMAs
  const applyMigration = db.transaction(() => {
    const id = crypto.randomUUID();
    db.prepare(
      'INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)'
    ).run(id, checksum, migrationName);

    // Execute DDL/DML statements
    if (ddlDml.trim()) {
      db.exec(ddlDml);
    }

    // Record migration completion
    db.prepare(
      'UPDATE _prisma_migrations SET finished_at = CURRENT_TIMESTAMP, applied_steps_count = 1 WHERE id = ?'
    ).run(id);
  });

  log(`[migrate] Applying: ${migrationName}`);

  // Execute pre-transaction PRAGMAs
  for (const pragma of prePragmas) {
    db.exec(pragma);
  }

  try {
    // Apply migration in transaction
    applyMigration();
  } finally {
    // Always execute post-transaction PRAGMAs to restore connection state
    // This ensures PRAGMA settings are restored even if the migration fails
    for (const pragma of postPragmas) {
      try {
        db.exec(pragma);
      } catch (pragmaError) {
        // Log but don't throw - we want to restore as much state as possible
        log(
          `[migrate] Warning: Failed to execute post-PRAGMA "${pragma}": ${pragmaError instanceof Error ? pragmaError.message : String(pragmaError)}`
        );
      }
    }
  }

  log(`[migrate] Applied: ${migrationName}`);
}

/**
 * Run database migrations.
 * @param options - Migration configuration
 * @throws Error if migrations fail
 */
export function runMigrations(options: MigrationOptions): void {
  const { databasePath, migrationsPath, log = writeStdout } = options;

  log(`[migrate] Database: ${databasePath}`);
  log(`[migrate] Migrations: ${migrationsPath}`);

  const db = new Database(databasePath);

  try {
    // Create migrations tracking table if it doesn't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS _prisma_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        migration_name TEXT NOT NULL UNIQUE,
        logs TEXT,
        rolled_back_at DATETIME,
        finished_at DATETIME,
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        applied_steps_count INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Ensure Prisma checksum column exists for legacy databases
    const columns = db.prepare("PRAGMA table_info('_prisma_migrations')").all() as Array<{
      name: string;
    }>;
    const hasChecksum = columns.some((column) => column.name === 'checksum');
    if (!hasChecksum) {
      db.exec("ALTER TABLE _prisma_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''");
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

      const sql = readFileSync(sqlPath, 'utf-8');
      const checksum = createHash('sha256').update(sql).digest('hex');

      try {
        applySingleMigration(db, migrationName, sql, checksum, log);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`[migrate] Failed to apply migration ${migrationName}: ${message}`);
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
    writeStderr('DATABASE_PATH environment variable is required');
    process.exit(1);
  }

  if (!migrationsPath) {
    writeStderr('MIGRATIONS_PATH environment variable is required');
    process.exit(1);
  }

  try {
    runMigrations({ databasePath, migrationsPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`Migration failed: ${message}`);
    process.exit(1);
  }
}
