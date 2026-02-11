import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate';

describe('runMigrations', () => {
  let tempDir: string;
  let databasePath: string;
  let migrationsPath: string;

  const setupMigration = (name: string, sql: string) => {
    const migrationDir = join(migrationsPath, name);
    writeFileSync(join(migrationDir, 'migration.sql'), sql, 'utf-8');
  };

  const createMigrationDir = (name: string) => {
    const migrationDir = join(migrationsPath, name);
    const fs = require('node:fs');
    fs.mkdirSync(migrationDir, { recursive: true });
  };

  const getAppliedMigrations = (db: Database.Database): string[] => {
    const rows = db
      .prepare('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL')
      .all() as Array<{ migration_name: string }>;
    return rows.map((row) => row.migration_name);
  };

  const getIncompleteMigrations = (db: Database.Database): string[] => {
    const rows = db
      .prepare('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL')
      .all() as Array<{ migration_name: string }>;
    return rows.map((row) => row.migration_name);
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ff-migrate-test-'));
    databasePath = join(tempDir, 'test.db');
    migrationsPath = join(tempDir, 'migrations');
    const fs = require('node:fs');
    fs.mkdirSync(migrationsPath, { recursive: true });
  });

  afterEach(() => {
    const fs = require('node:fs');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates _prisma_migrations table on first run', () => {
    runMigrations({
      databasePath,
      migrationsPath,
      log: () => {
        /* no-op */
      },
    });

    const db = new Database(databasePath);
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'")
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(1);
      expect(tables[0]?.name).toBe('_prisma_migrations');
    } finally {
      db.close();
    }
  });

  it('applies a successful migration', () => {
    createMigrationDir('001_create_users');
    setupMigration(
      '001_create_users',
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);'
    );

    runMigrations({
      databasePath,
      migrationsPath,
      log: () => {
        /* no-op */
      },
    });

    const db = new Database(databasePath);
    try {
      const appliedMigrations = getAppliedMigrations(db);
      expect(appliedMigrations).toEqual(['001_create_users']);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('applies multiple migrations in order', () => {
    createMigrationDir('001_create_users');
    setupMigration(
      '001_create_users',
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);'
    );

    createMigrationDir('002_create_posts');
    setupMigration(
      '002_create_posts',
      'CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT);'
    );

    runMigrations({
      databasePath,
      migrationsPath,
      log: () => {
        /* no-op */
      },
    });

    const db = new Database(databasePath);
    try {
      const appliedMigrations = getAppliedMigrations(db);
      expect(appliedMigrations).toEqual(['001_create_users', '002_create_posts']);
    } finally {
      db.close();
    }
  });

  it('skips already applied migrations', () => {
    createMigrationDir('001_create_users');
    setupMigration(
      '001_create_users',
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);'
    );

    // Apply first time
    runMigrations({
      databasePath,
      migrationsPath,
      log: () => {
        /* no-op */
      },
    });

    // Apply second time
    const logs: string[] = [];
    runMigrations({ databasePath, migrationsPath, log: (msg) => logs.push(msg) });

    expect(logs.some((log) => log.includes('Skipping already applied'))).toBe(true);
  });

  it('rolls back entire migration on failure (transaction behavior)', () => {
    createMigrationDir('001_failing_migration');
    // First statement succeeds, second fails - transaction should roll back both
    setupMigration(
      '001_failing_migration',
      `CREATE TABLE test_table (id INTEGER PRIMARY KEY);
       CREATE TABLE duplicate_table (id INTEGER);
       CREATE TABLE duplicate_table (id INTEGER);` // Duplicate table creation will fail
    );

    const db = new Database(databasePath);
    try {
      expect(() =>
        runMigrations({
          databasePath,
          migrationsPath,
          log: () => {
            /* no-op */
          },
        })
      ).toThrow();

      // Verify no tables were created
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_table'")
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(0);

      // Verify no migration record exists
      const appliedMigrations = getAppliedMigrations(db);
      expect(appliedMigrations).toHaveLength(0);

      // Verify no incomplete migration record exists
      const incompleteMigrations = getIncompleteMigrations(db);
      expect(incompleteMigrations).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('allows retry after failed migration with full rollback', () => {
    createMigrationDir('001_initially_failing');
    // Set up a migration that will fail
    setupMigration(
      '001_initially_failing',
      `CREATE TABLE users (id INTEGER PRIMARY KEY);
       INVALID SQL STATEMENT;` // This will cause a failure
    );

    const db = new Database(databasePath);
    try {
      // First attempt should fail
      expect(() =>
        runMigrations({
          databasePath,
          migrationsPath,
          log: () => {
            /* no-op */
          },
        })
      ).toThrow();

      // Verify nothing was applied
      const tablesAfterFail = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
        .all() as Array<{ name: string }>;
      expect(tablesAfterFail).toHaveLength(0);

      // Fix the migration
      setupMigration('001_initially_failing', 'CREATE TABLE users (id INTEGER PRIMARY KEY);');

      // Second attempt should succeed
      runMigrations({
        databasePath,
        migrationsPath,
        log: () => {
          /* no-op */
        },
      });

      // Verify migration was applied
      const appliedMigrations = getAppliedMigrations(db);
      expect(appliedMigrations).toEqual(['001_initially_failing']);

      const tablesAfterFix = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
        .all() as Array<{ name: string }>;
      expect(tablesAfterFix).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('stops processing migrations after a failure', () => {
    createMigrationDir('001_successful');
    setupMigration('001_successful', 'CREATE TABLE users (id INTEGER PRIMARY KEY);');

    createMigrationDir('002_failing');
    setupMigration('002_failing', 'INVALID SQL;');

    createMigrationDir('003_should_not_run');
    setupMigration('003_should_not_run', 'CREATE TABLE posts (id INTEGER PRIMARY KEY);');

    const db = new Database(databasePath);
    try {
      expect(() =>
        runMigrations({
          databasePath,
          migrationsPath,
          log: () => {
            /* no-op */
          },
        })
      ).toThrow();

      // First migration should have succeeded
      const appliedMigrations = getAppliedMigrations(db);
      expect(appliedMigrations).toEqual(['001_successful']);

      // Third migration should not have run
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'")
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('handles migration with no migration.sql file', () => {
    createMigrationDir('001_empty_migration');
    // Don't create migration.sql file

    const logs: string[] = [];
    runMigrations({ databasePath, migrationsPath, log: (msg) => logs.push(msg) });

    expect(logs.some((log) => log.includes('No migration.sql found'))).toBe(true);
  });

  it('adds checksum column to legacy databases', () => {
    // Create database with old schema (no checksum column)
    const db = new Database(databasePath);
    db.exec(`
      CREATE TABLE _prisma_migrations (
        id TEXT PRIMARY KEY,
        migration_name TEXT NOT NULL UNIQUE,
        logs TEXT,
        rolled_back_at DATETIME,
        finished_at DATETIME,
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        applied_steps_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.close();

    // Run migrations to trigger checksum column addition
    runMigrations({
      databasePath,
      migrationsPath,
      log: () => {
        /* no-op */
      },
    });

    const db2 = new Database(databasePath);
    try {
      const columns = db2.prepare("PRAGMA table_info('_prisma_migrations')").all() as Array<{
        name: string;
      }>;
      const hasChecksum = columns.some((column) => column.name === 'checksum');
      expect(hasChecksum).toBe(true);
    } finally {
      db2.close();
    }
  });

  it('handles PRAGMA statements outside transaction', () => {
    createMigrationDir('001_pragma_test');
    // Migration with PRAGMA statements (similar to Prisma-generated migrations)
    setupMigration(
      '001_pragma_test',
      `-- Test PRAGMA handling
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;`
    );

    // Enable foreign key enforcement to test that PRAGMAs work
    const db = new Database(databasePath);
    db.pragma('foreign_keys = ON');
    db.close();

    runMigrations({
      databasePath,
      migrationsPath,
      log: () => {
        /* no-op */
      },
    });

    const db2 = new Database(databasePath);
    try {
      // Verify migration was applied
      const appliedMigrations = getAppliedMigrations(db2);
      expect(appliedMigrations).toEqual(['001_pragma_test']);

      // Verify tables were created
      const tables = db2
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users', 'posts')")
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(2);

      // Verify foreign key constraint exists
      const fks = db2.prepare('PRAGMA foreign_key_list(posts)').all() as Array<{
        table: string;
      }>;
      expect(fks).toHaveLength(1);
      expect(fks[0]?.table).toBe('users');
    } finally {
      db2.close();
    }
  });
});
