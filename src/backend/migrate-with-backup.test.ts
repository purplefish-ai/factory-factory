import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnknownAppliedMigrationsError } from './migrate';
import {
  getPreMigrationBackupDirectory,
  type MigrateWithBackupOptions,
  MigrationBackupError,
  runMigrationsWithBackup,
} from './migrate-with-backup';
import { configService } from './services/config.service';

const ORIGINAL_ENV = { ...process.env };

describe('runMigrationsWithBackup', () => {
  let tempDir: string;
  let databasePath: string;
  let migrationsPath: string;
  let backupDirectory: string;
  let clock: number;
  let logs: string[];
  let warnings: string[];

  const addMigration = (name: string, sql: string) => {
    mkdirSync(join(migrationsPath, name), { recursive: true });
    writeFileSync(join(migrationsPath, name, 'migration.sql'), sql, 'utf-8');
  };

  const migrate = (overrides: Partial<MigrateWithBackupOptions> = {}) =>
    runMigrationsWithBackup({
      databasePath,
      migrationsPath,
      log: (msg) => logs.push(msg),
      warn: (msg) => warnings.push(msg),
      now: () => new Date(clock++ * 1000),
      ...overrides,
    });

  const backups = () => (existsSync(backupDirectory) ? readdirSync(backupDirectory).sort() : []);

  const tablesIn = (path: string) => {
    const db = new Database(path, { readonly: true });
    try {
      return (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
    } finally {
      db.close();
    }
  };

  const appliedMigrations = () => {
    const db = new Database(databasePath, { readonly: true });
    try {
      return (
        db
          .prepare('SELECT migration_name FROM _prisma_migrations ORDER BY migration_name')
          .all() as Array<{
          migration_name: string;
        }>
      ).map((row) => row.migration_name);
    } finally {
      db.close();
    }
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ff-migrate-backup-test-'));
    databasePath = join(tempDir, 'data.db');
    migrationsPath = join(tempDir, 'migrations');
    backupDirectory = getPreMigrationBackupDirectory(databasePath);
    mkdirSync(migrationsPath);
    clock = 1_800_000_000;
    logs = [];
    warnings = [];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps backups beside the database', () => {
    expect(backupDirectory).toBe(join(tempDir, 'db-backups'));
  });

  it('does not back up a new database', async () => {
    addMigration('001_users', 'CREATE TABLE users (id INTEGER PRIMARY KEY);');

    await migrate();

    expect(tablesIn(databasePath)).toContain('users');
    expect(backups()).toEqual([]);
  });

  it('does not back up when nothing is pending', async () => {
    addMigration('001_users', 'CREATE TABLE users (id INTEGER PRIMARY KEY);');
    await migrate();

    await migrate();

    expect(backups()).toEqual([]);
  });

  it('snapshots the pre-migration database, readable only by its owner, before migrating', async () => {
    addMigration('001_users', 'CREATE TABLE users (id INTEGER PRIMARY KEY);');
    await migrate();
    // An open writer keeps its commit in the WAL; the online backup must still include it.
    const writer = new Database(databasePath);
    writer.pragma('journal_mode = WAL');
    writer.prepare('INSERT INTO users (id) VALUES (7)').run();
    addMigration('002_posts', 'CREATE TABLE posts (id INTEGER PRIMARY KEY);');

    try {
      await migrate();
    } finally {
      writer.close();
    }

    expect(backups()).toEqual(['data.db-pre-migration-20270115T080000000Z.db']);
    const backupPath = join(backupDirectory, backups()[0] ?? '');
    expect(tablesIn(backupPath)).not.toContain('posts');
    expect(tablesIn(databasePath)).toContain('posts');
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(statSync(backupDirectory).mode & 0o777).toBe(0o700);
    const backup = new Database(backupPath, { readonly: true });
    try {
      expect(backup.prepare('SELECT id FROM users').all()).toEqual([{ id: 7 }]);
    } finally {
      backup.close();
    }
    expect(logs.some((msg) => msg.includes(backupPath) && msg.includes('1 migration'))).toBe(true);
  });

  it('keeps a bounded number of backups and leaves unrelated files alone', async () => {
    addMigration('000_base', 'CREATE TABLE base (id INTEGER PRIMARY KEY);');
    await migrate();
    mkdirSync(backupDirectory, { recursive: true });
    writeFileSync(join(backupDirectory, 'keep-me.db'), '');
    writeFileSync(join(backupDirectory, 'other-pre-migration-20000101T000000000Z.db'), '');
    writeFileSync(join(backupDirectory, 'data.sqlite-pre-migration-20000101T000000000Z.db'), '');

    for (let index = 1; index <= 5; index += 1) {
      addMigration(`00${index}_table`, `CREATE TABLE t${index} (id INTEGER PRIMARY KEY);`);
      await migrate();
    }

    const own = backups().filter((name) => name.startsWith('data.db-pre-migration-'));
    expect(own).toHaveLength(3);
    // The three newest survive: taken before migrations 3, 4 and 5.
    expect(tablesIn(join(backupDirectory, own[0] ?? ''))).toContain('t2');
    expect(tablesIn(join(backupDirectory, own[0] ?? ''))).not.toContain('t3');
    expect(backups()).toContain('keep-me.db');
    expect(backups()).toContain('other-pre-migration-20000101T000000000Z.db');
    expect(backups()).toContain('data.sqlite-pre-migration-20000101T000000000Z.db');
  });

  it('removes partial copies left by an interrupted backup once they are stale', async () => {
    addMigration('001_users', 'CREATE TABLE users (id INTEGER PRIMARY KEY);');
    await migrate();
    mkdirSync(backupDirectory, { mode: 0o755 });
    chmodSync(backupDirectory, 0o755);
    const stale = 'data.db-pre-migration-20000101T000000000Z.db.partial';
    const recent = 'data.db-pre-migration-20000102T000000000Z.db.partial';
    writeFileSync(join(backupDirectory, stale), '');
    writeFileSync(join(backupDirectory, recent), '');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(join(backupDirectory, stale), twoHoursAgo, twoHoursAgo);
    addMigration('002_posts', 'CREATE TABLE posts (id INTEGER PRIMARY KEY);');

    await migrate();

    expect(backups()).not.toContain(stale);
    expect(backups()).toContain(recent);
    // An existing, more permissive directory is tightened too.
    expect(statSync(backupDirectory).mode & 0o777).toBe(0o700);
  });

  it('never reuses a backup name another launch has claimed', async () => {
    addMigration('001_users', 'CREATE TABLE users (id INTEGER PRIMARY KEY);');
    await migrate();
    mkdirSync(backupDirectory);
    const claimed = 'data.db-pre-migration-20270115T080000000Z.db';
    writeFileSync(join(backupDirectory, `${claimed}.partial`), 'in progress elsewhere');
    addMigration('002_posts', 'CREATE TABLE posts (id INTEGER PRIMARY KEY);');

    await migrate();

    expect(backups()).toEqual([
      `${claimed}.partial`,
      'data.db-pre-migration-20270115T080000001Z.db',
    ]);
  });

  it('names the backup when a migration fails', async () => {
    addMigration('001_users', 'CREATE TABLE users (id INTEGER PRIMARY KEY);');
    await migrate();
    addMigration('002_broken', 'CREATE TABLE broken (id INTEGER PRIMARY KEY); INVALID SQL;');

    const failure = migrate();

    await expect(failure).rejects.toThrow(/Failed to apply migration 002_broken/);
    const [backup] = backups();
    expect(backup).toBeDefined();
    await expect(failure).rejects.toThrow(join(backupDirectory, backup ?? ''));
    expect(logs.some((msg) => msg.includes(join(backupDirectory, backup ?? '')))).toBe(true);
  });

  it('does not back up a database it refuses to downgrade', async () => {
    addMigration('001_users', 'CREATE TABLE users (id INTEGER PRIMARY KEY);');
    await migrate();
    const db = new Database(databasePath);
    db.prepare(
      "INSERT INTO _prisma_migrations (id, checksum, migration_name, finished_at) VALUES ('x', '', '009_newer', CURRENT_TIMESTAMP)"
    ).run();
    db.close();
    addMigration('002_posts', 'CREATE TABLE posts (id INTEGER PRIMARY KEY);');

    await expect(migrate()).rejects.toBeInstanceOf(UnknownAppliedMigrationsError);
    expect(backups()).toEqual([]);

    await migrate({ unknownMigrations: 'warn' });
    expect(backups()).toHaveLength(1);
  });

  describe('when the backup cannot be written', () => {
    let blocked: string;

    beforeEach(() => {
      addMigration('001_users', 'CREATE TABLE users (id INTEGER PRIMARY KEY);');
      return migrate().then(() => {
        addMigration('002_posts', 'CREATE TABLE posts (id INTEGER PRIMARY KEY);');
        // A file where the backup directory should be: the real failure, not a stub.
        blocked = join(tempDir, 'not-a-directory');
        writeFileSync(blocked, '');
      });
    });

    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
      configService.reload();
    });

    it('stops before any migration runs, naming the reason and the variable that overrides it', async () => {
      const failure = migrate({ backupDirectory: blocked });

      await expect(failure).rejects.toBeInstanceOf(MigrationBackupError);
      await expect(failure).rejects.toThrow(/ENOTDIR|EEXIST|not a directory/i);
      await expect(failure).rejects.toThrow('FF_ALLOW_MIGRATION_WITHOUT_BACKUP=1');
      expect(tablesIn(databasePath)).not.toContain('posts');
      expect(appliedMigrations()).toEqual(['001_users']);
    });

    it('proceeds, with a warning, when FF_ALLOW_MIGRATION_WITHOUT_BACKUP=1 is set', async () => {
      process.env.FF_ALLOW_MIGRATION_WITHOUT_BACKUP = '1';
      configService.reload();

      await migrate({ backupDirectory: blocked });

      expect(tablesIn(databasePath)).toContain('posts');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('could not back up the database');
      expect(warnings[0]).toContain('FF_ALLOW_MIGRATION_WITHOUT_BACKUP');
    });

    it('still starts a database with nothing to migrate', async () => {
      await migrate({ backupDirectory: join(tempDir, 'ok-backups') });
      warnings.length = 0;

      await migrate({ backupDirectory: blocked });

      expect(warnings).toEqual([]);
    });
  });
});
