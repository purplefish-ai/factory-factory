import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import setupIntegrationDatabase from './integration-db.global-setup';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ff-template-watch-test-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const writeMigration = (name: string, sql: string) => {
    const directory = join(root, 'prisma', 'migrations', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'migration.sql'), sql);
  };
  writeMigration('001_initial', 'CREATE TABLE Snapshot (original TEXT);');
  let templatePath = '';
  let rerun: (() => void | Promise<void>) | undefined;
  const cleanup = setupIntegrationDatabase({
    config: { root },
    provide: (_key, value) => {
      templatePath = value;
    },
    onTestsRerun: (callback) => {
      rerun = () => callback([]);
    },
  });
  cleanups.push(cleanup);
  return {
    templatePath,
    writeMigration,
    cleanup,
    rerun: async () => {
      if (!rerun) {
        throw new Error('Watch rerun hook was not registered');
      }
      await rerun();
    },
    copy: () => {
      const path = join(root, 'copy.db');
      copyFileSync(templatePath, path);
      return new Database(path);
    },
  };
}

it('includes added migrations in private copies on the next watch rerun', async () => {
  const f = fixture();
  const sql = 'ALTER TABLE Snapshot ADD COLUMN added TEXT;';
  f.writeMigration('002_added', sql);
  await f.rerun();
  const db = f.copy();
  try {
    expect(db.prepare('SELECT added FROM Snapshot').all()).toEqual([]);
    expect(
      db
        .prepare('SELECT checksum FROM _prisma_migrations WHERE migration_name = ?')
        .get('002_added')
    ).toEqual({ checksum: createHash('sha256').update(sql).digest('hex') });
  } finally {
    db.close();
  }
});

it('rebuilds from scratch when existing migration SQL changes', async () => {
  const f = fixture();
  const sql = 'CREATE TABLE Snapshot (edited TEXT);';
  f.writeMigration('001_initial', sql);
  await f.rerun();
  const db = f.copy();
  try {
    expect(db.prepare('SELECT edited FROM Snapshot').all()).toEqual([]);
    expect(() => db.prepare('SELECT original FROM Snapshot')).toThrow();
    expect(
      db
        .prepare('SELECT checksum FROM _prisma_migrations WHERE migration_name = ?')
        .get('001_initial')
    ).toEqual({ checksum: createHash('sha256').update(sql).digest('hex') });
  } finally {
    db.close();
  }
});

it('retains the existing closed template when migrations have not changed', async () => {
  const f = fixture();
  const before = readFileSync(f.templatePath);
  await f.rerun();
  expect(readFileSync(f.templatePath)).toEqual(before);
});

it('rejects a failed rebuild without exposing partial pages and recovers after SQL is fixed', async () => {
  const f = fixture();
  const before = readFileSync(f.templatePath);
  f.writeMigration('002_added', 'INVALID SQL;');
  await expect(f.rerun()).rejects.toThrow();
  expect(readFileSync(f.templatePath)).toEqual(before);
  expect(readdirSync(dirname(f.templatePath))).toEqual(['template.db']);

  f.writeMigration('002_added', 'ALTER TABLE Snapshot ADD COLUMN recovered TEXT;');
  await f.rerun();
  const db = f.copy();
  try {
    expect(db.prepare('SELECT recovered FROM Snapshot').all()).toEqual([]);
  } finally {
    db.close();
  }
  f.cleanup();
  expect(existsSync(dirname(f.templatePath))).toBe(false);
});
