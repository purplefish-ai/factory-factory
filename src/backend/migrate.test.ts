import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations, UnknownAppliedMigrationsError } from './migrate';

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

  it('handles interleaved FK PRAGMAs emitted by Prisma redefine-table migrations', () => {
    createMigrationDir('001_enable_foreign_keys');
    setupMigration(
      '001_enable_foreign_keys',
      `CREATE TABLE fk_setup (id INTEGER PRIMARY KEY);
PRAGMA foreign_keys=ON;`
    );

    createMigrationDir('002_interleaved_pragma_test');
    setupMigration(
      '002_interleaved_pragma_test',
      `CREATE TABLE parent (id INTEGER PRIMARY KEY);
CREATE TABLE child (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES parent(id)
);
INSERT INTO parent (id) VALUES (1);
INSERT INTO child (id, parent_id) VALUES (10, 1);
ALTER TABLE child ADD COLUMN name TEXT;
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE new_parent (
  id INTEGER PRIMARY KEY,
  extra TEXT
);
INSERT INTO new_parent (id) SELECT id FROM parent;
DROP TABLE parent;
ALTER TABLE new_parent RENAME TO parent;
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;`
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
      expect(appliedMigrations).toEqual(['001_enable_foreign_keys', '002_interleaved_pragma_test']);

      const parentRows = db.prepare('SELECT COUNT(*) as count FROM parent').get() as {
        count: number;
      };
      expect(parentRows.count).toBe(1);

      const childColumns = db.prepare("PRAGMA table_info('child')").all() as Array<{
        name: string;
      }>;
      expect(childColumns.some((column) => column.name === 'name')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('rejects migrations with multi-line string literals', () => {
    createMigrationDir('001_multiline_string_literal');
    setupMigration(
      '001_multiline_string_literal',
      `CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT NOT NULL);
INSERT INTO notes (content) VALUES ('line one
-- this is string content, not a SQL comment
line three');`
    );

    expect(() =>
      runMigrations({
        databasePath,
        migrationsPath,
        log: () => {
          /* no-op */
        },
      })
    ).toThrow(/multi-line string literal/i);

    const db = new Database(databasePath);
    try {
      const appliedMigrations = getAppliedMigrations(db);
      expect(appliedMigrations).toHaveLength(0);

      const notesTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'")
        .all() as Array<{ name: string }>;
      expect(notesTable).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('migrates ClaudeSession rows to AgentSession with locked mapping and indexes', () => {
    createMigrationDir('001_agent_session_cutover');
    const migrationSqlPath = join(
      process.cwd(),
      'prisma',
      'migrations',
      '20260212163000_agent_session_provider_cutover',
      'migration.sql'
    );
    setupMigration('001_agent_session_cutover', readFileSync(migrationSqlPath, 'utf-8'));

    const db = new Database(databasePath);
    try {
      db.exec(`
        CREATE TABLE "Project" (
          "id" TEXT NOT NULL PRIMARY KEY
        );

        CREATE TABLE "Workspace" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "projectId" TEXT NOT NULL,
          "name" TEXT NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'READY',
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL
        );

        CREATE TABLE "UserSettings" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "userId" TEXT NOT NULL
        );

        CREATE TABLE "ClaudeSession" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "workspaceId" TEXT NOT NULL,
          "name" TEXT,
          "workflow" TEXT NOT NULL,
          "model" TEXT NOT NULL DEFAULT 'sonnet',
          "status" TEXT NOT NULL DEFAULT 'IDLE',
          "claudeSessionId" TEXT,
          "claudeProjectPath" TEXT,
          "claudeProcessPid" INTEGER,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL
        );
      `);

      db.prepare('INSERT INTO "Project" ("id") VALUES (?)').run('proj-1');
      db.prepare(
        'INSERT INTO "Workspace" ("id", "projectId", "name", "status", "updatedAt") VALUES (?, ?, ?, ?, ?)'
      ).run('ws-1', 'proj-1', 'Workspace 1', 'READY', '2026-02-01T10:00:00.000Z');
      db.prepare('INSERT INTO "UserSettings" ("id", "userId") VALUES (?, ?)').run(
        'settings-1',
        'default'
      );
      db.prepare(
        `INSERT INTO "ClaudeSession"
           ("id", "workspaceId", "name", "workflow", "model", "status", "claudeSessionId", "claudeProjectPath", "claudeProcessPid", "createdAt", "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'session-1',
        'ws-1',
        'Chat 1',
        'followup',
        'sonnet',
        'RUNNING',
        'claude-abc',
        '/tmp/project',
        4242,
        '2026-02-01T10:01:00.000Z',
        '2026-02-01T10:02:00.000Z'
      );

      runMigrations({
        databasePath,
        migrationsPath,
        log: () => {
          // no-op
        },
      });

      const migrated = db
        .prepare(
          `SELECT "id", "workspaceId", "name", "workflow", "model", "status",
                  "provider", "providerSessionId", "providerProjectPath",
                  "providerProcessPid", "providerMetadata", "createdAt", "updatedAt"
           FROM "AgentSession"
           WHERE "id" = ?`
        )
        .get('session-1') as Record<string, unknown> | undefined;

      expect(migrated).toMatchObject({
        id: 'session-1',
        workspaceId: 'ws-1',
        name: 'Chat 1',
        workflow: 'followup',
        model: 'sonnet',
        status: 'RUNNING',
        provider: 'CLAUDE',
        providerSessionId: 'claude-abc',
        providerProjectPath: '/tmp/project',
        providerProcessPid: 4242,
        providerMetadata: null,
        createdAt: '2026-02-01T10:01:00.000Z',
        updatedAt: '2026-02-01T10:02:00.000Z',
      });

      const legacyTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ClaudeSession'")
        .all() as Array<{ name: string }>;
      expect(legacyTable).toHaveLength(0);

      const indexNames = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='AgentSession'")
          .all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(indexNames).toEqual(
        expect.arrayContaining([
          'AgentSession_workspaceId_idx',
          'AgentSession_status_idx',
          'AgentSession_provider_idx',
          'AgentSession_workspaceId_provider_idx',
        ])
      );

      const queryPlan = db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT * FROM "AgentSession" WHERE "workspaceId" = ? AND "provider" = ?'
        )
        .all('ws-1', 'CLAUDE') as Record<string, unknown>[];
      expect(JSON.stringify(queryPlan)).toContain('AgentSession_workspaceId_provider_idx');
    } finally {
      db.close();
    }
  });

  describe('database integrity checks', () => {
    const silent = () => {
      /* no-op */
    };

    const addMigration = (name: string, sql: string) => {
      createMigrationDir(name);
      setupMigration(name, sql);
    };

    const migrate = (overrides: Partial<Parameters<typeof runMigrations>[0]> = {}) => {
      const warnings: string[] = [];
      runMigrations({
        databasePath,
        migrationsPath,
        log: silent,
        warn: (msg) => warnings.push(msg),
        ...overrides,
      });
      return warnings;
    };

    const recordForeignMigration = (name: string, finished: boolean) => {
      const db = new Database(databasePath);
      try {
        db.prepare(
          `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at)
           VALUES (?, 'abc', ?, CURRENT_TIMESTAMP, ${finished ? 'CURRENT_TIMESTAMP' : 'NULL'})`
        ).run(`id-${name}`, name);
      } finally {
        db.close();
      }
    };

    const withDatabase = <T>(read: (db: Database.Database) => T): T => {
      const db = new Database(databasePath);
      try {
        return read(db);
      } finally {
        db.close();
      }
    };

    it('refuses a database with applied migrations this build does not ship, before applying anything', () => {
      addMigration('001_users', 'CREATE TABLE users (id INTEGER PRIMARY KEY);');
      migrate();
      recordForeignMigration('003_from_newer_version', true);
      recordForeignMigration('002_also_newer', true);
      addMigration('004_pending', 'CREATE TABLE pending (id INTEGER PRIMARY KEY);');

      let thrown: unknown;
      try {
        migrate();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnknownAppliedMigrationsError);
      const error = thrown as UnknownAppliedMigrationsError;
      expect(error.migrationNames).toEqual(['002_also_newer', '003_from_newer_version']);
      expect(error.message).toContain('002_also_newer, 003_from_newer_version');
      expect(error.message).toContain('Upgrade Factory Factory');
      expect(error.message).toContain(databasePath);
      expect(withDatabase(getAppliedMigrations)).not.toContain('004_pending');
    });

    it('only warns about unknown applied migrations when allowed, and still applies pending ones', () => {
      addMigration('001_users', 'CREATE TABLE users (id INTEGER PRIMARY KEY);');
      migrate();
      recordForeignMigration('002_other_branch', true);
      addMigration('003_this_branch', 'CREATE TABLE this_branch (id INTEGER PRIMARY KEY);');

      const warnings = migrate({ unknownMigrations: 'warn' });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('002_other_branch');
      expect(warnings[0]).toContain('WARNING');
      expect(withDatabase(getAppliedMigrations)).toContain('003_this_branch');
    });

    it('ignores unknown migrations that never finished', () => {
      addMigration('001_users', 'CREATE TABLE users (id INTEGER PRIMARY KEY);');
      migrate();
      recordForeignMigration('002_failed_elsewhere', false);

      expect(migrate()).toEqual([]);
    });

    it('warns, without failing, when an applied migration changed on disk', () => {
      addMigration('001_users', 'CREATE TABLE users (id INTEGER PRIMARY KEY);');
      addMigration('002_posts', 'CREATE TABLE posts (id INTEGER PRIMARY KEY);');
      migrate();
      setupMigration('001_users', 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);');

      const warnings = migrate();

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('001_users');
      expect(warnings[0]).not.toContain('002_posts');
    });

    it('does not compare legacy empty checksums or line-ending-only changes', () => {
      addMigration(
        '001_users',
        'CREATE TABLE users (id INTEGER PRIMARY KEY);\nCREATE TABLE a (id INTEGER);\n'
      );
      addMigration('002_posts', 'CREATE TABLE posts (id INTEGER PRIMARY KEY);');
      migrate();
      withDatabase((db) =>
        db
          .prepare("UPDATE _prisma_migrations SET checksum = '' WHERE migration_name = '002_posts'")
          .run()
      );
      setupMigration(
        '001_users',
        'CREATE TABLE users (id INTEGER PRIMARY KEY);\r\nCREATE TABLE a (id INTEGER);\r\n'
      );
      setupMigration('002_posts', 'CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT);');

      expect(migrate()).toEqual([]);
    });

    it('reports foreign key violations left by a migration that disabled foreign keys', () => {
      addMigration(
        '001_tables',
        `CREATE TABLE users (id INTEGER PRIMARY KEY);
CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id));`
      );
      addMigration(
        '002_orphan_rebuild',
        `PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
INSERT INTO posts (id, user_id) VALUES (1, 42);
INSERT INTO posts (id, user_id) VALUES (2, 43);
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;`
      );

      const warnings = migrate();

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('002_orphan_rebuild');
      expect(warnings[0]).toContain('posts -> users (2)');
      expect(withDatabase(getAppliedMigrations)).toEqual(['001_tables', '002_orphan_rebuild']);
    });

    it('reports only violations a migration added, and accepts PRAGMAs without semicolons', () => {
      addMigration(
        '001_tables',
        `CREATE TABLE users (id INTEGER PRIMARY KEY);
CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id));`
      );
      migrate();
      withDatabase((db) => {
        db.pragma('foreign_keys = OFF');
        db.prepare('INSERT INTO posts (id, user_id) VALUES (1, 42)').run();
      });
      addMigration(
        '002_rebuild_keeps_old_orphan',
        `PRAGMA foreign_keys=OFF
CREATE TABLE notes (id INTEGER PRIMARY KEY);
PRAGMA foreign_keys=ON`
      );
      addMigration(
        '003_adds_orphan',
        `PRAGMA foreign_keys=OFF
INSERT INTO posts (id, user_id) VALUES (2, 43);
PRAGMA foreign_keys=ON`
      );

      const warnings = migrate();

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('003_adds_orphan left 1 new row(s)');
      expect(warnings[0]).toContain('posts -> users (1)');
    });

    it('does not run the foreign key check after migrations that keep foreign keys on', () => {
      addMigration(
        '001_tables',
        `CREATE TABLE users (id INTEGER PRIMARY KEY);
CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id));`
      );
      migrate();
      withDatabase((db) => {
        db.pragma('foreign_keys = OFF');
        db.prepare('INSERT INTO posts (id, user_id) VALUES (1, 42)').run();
      });
      addMigration('002_plain', 'CREATE TABLE plain (id INTEGER PRIMARY KEY);');

      expect(migrate()).toEqual([]);
    });
  });
});
