import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findMissingMigrations,
  loadSeed,
  type LastRelease,
  measureSeedCoverage,
  migrateToLastRelease,
  readLastRelease,
  readLastReleaseSeedSql,
} from './last-release';
import { seedTables } from './seed-rows';
import { renderSeedSql, sqlLiteral } from './seed-sql';

const directories: string[] = [];
function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ff-upgrade-seed-test-'));
  directories.push(directory);
  return join(directory, 'seed.db');
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('the last-release pin', () => {
  it('lists only migrations this repository still has, in applied order', () => {
    const { migrations } = readLastRelease();
    expect(findMissingMigrations(migrations)).toEqual([]);
    expect(migrations).toEqual([...migrations].sort());
    expect(new Set(migrations).size).toBe(migrations.length);
  });

  it('fails loudly when a listed migration is missing from the repository', () => {
    const lastRelease: LastRelease = {
      ...readLastRelease(),
      migrations: ['20260101000000_never_existed'],
    };
    expect(findMissingMigrations(lastRelease.migrations)).toEqual(['20260101000000_never_existed']);
    expect(() => migrateToLastRelease(temporaryDatabase(), lastRelease)).toThrow(
      /lacks 1 migration\(s\).*20260101000000_never_existed/
    );
  });
});

describe('the seed', () => {
  it('is exactly what the generator writes from the rows, so it cannot rot unnoticed', () => {
    expect(readLastReleaseSeedSql()).toBe(renderSeedSql(seedTables));
  });

  it('loads into the last release schema with a row in every table and every enum value', () => {
    const databasePath = temporaryDatabase();
    const lastRelease = readLastRelease();
    migrateToLastRelease(databasePath, lastRelease);
    loadSeed(databasePath);
    const coverage = measureSeedCoverage(databasePath, lastRelease);
    expect(coverage.emptyTables).toEqual([]);
    expect(coverage.missingEnumValues).toEqual([]);
    expect(Object.keys(coverage.tableRowCounts).length).toBeGreaterThanOrEqual(38);
  });

  it('reports a table or an enum value the seed leaves out', () => {
    const databasePath = temporaryDatabase();
    const lastRelease = readLastRelease();
    migrateToLastRelease(databasePath, lastRelease);
    loadSeed(databasePath);
    const db = new Database(databasePath);
    try {
      db.exec('DELETE FROM "SessionLifecycleEvent"');
      db.exec('DELETE FROM "TerminalSession" WHERE "status" = \'FAILED\'');
    } finally {
      db.close();
    }
    const coverage = measureSeedCoverage(databasePath, lastRelease);
    expect(coverage.emptyTables).toEqual(['SessionLifecycleEvent']);
    expect(coverage.missingEnumValues).toContain('TerminalSession.status=FAILED');
    expect(coverage.missingEnumValues).toContain('SessionLifecycleEvent.reason=USER_STOP');
  });

  it('writes values the way SQLite stores them', () => {
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(true)).toBe('1');
    expect(sqlLiteral(false)).toBe('0');
    expect(sqlLiteral(4101)).toBe('4101');
    expect(sqlLiteral("it's")).toBe("'it''s'");
    expect(sqlLiteral({ a: ["it's", 1, null] })).toBe(`'{"a":["it''s",1,null]}'`);
    expect(() => sqlLiteral(Number.NaN)).toThrow('finite');
  });
});
