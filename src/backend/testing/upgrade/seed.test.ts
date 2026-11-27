import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findEditedMigrations,
  describeSeedDrift,
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

describe('the pinned migrations', () => {
  it('are exactly the bytes the release published', () => {
    expect(findEditedMigrations(readLastRelease())).toEqual([]);
  });

  it('refuse to replay a migration edited after release', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ff-edited-migration-'));
    directories.push(directory);
    mkdirSync(join(directory, '20260101000000_first'));
    writeFileSync(join(directory, '20260101000000_first', 'migration.sql'), 'SELECT 1;\n');
    const published = createHash('sha256').update('SELECT 2;\n').digest('hex');
    const lastRelease: LastRelease = {
      ...readLastRelease(),
      migrations: ['20260101000000_first'],
      checksums: { '20260101000000_first': published },
    };
    expect(findEditedMigrations(lastRelease, directory)).toEqual(['20260101000000_first']);
    expect(() => migrateToLastRelease(temporaryDatabase(), lastRelease, directory)).toThrow(
      /edited after release: 20260101000000_first/
    );
  });
});

/**
 * A failure in this file or in the upgrade check means the code broke upgrades
 * from the pinned release. Fix the code. The seed changes only when re-pinning
 * or adding rows for a new table or value, with
 * `scripts/update-last-release-migrations.mjs`, which records the seed's digest.
 */
describe('the seed', () => {
  it('is the seed the pin recorded, so it cannot be rewritten to satisfy a break', () => {
    expect(describeSeedDrift(readLastRelease(), readLastReleaseSeedSql())).toBeUndefined();
    const message = describeSeedDrift(
      readLastRelease(),
      `${readLastReleaseSeedSql()}-- loosened\n`
    );
    expect(message).toContain(`fix the code, not the seed`);
    expect(message).toContain(`upgrades from ${readLastRelease().version}`);
    expect(message).toContain('scripts/update-last-release-migrations.mjs');
  });

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
    expect(Object.keys(coverage.tableRowCounts).sort()).toEqual(Object.keys(seedTables).sort());
  });

  it('reports a table or an enum value the seed leaves out', () => {
    const databasePath = temporaryDatabase();
    const lastRelease = readLastRelease();
    migrateToLastRelease(databasePath, lastRelease);
    loadSeed(databasePath);
    const db = new Database(databasePath);
    try {
      db.exec('DELETE FROM "SessionLifecycleEvent"');
      db.exec('DELETE FROM "WorkspacePREvent" WHERE "batchId" = \'seed-delivery-blocked\'');
      db.exec('DELETE FROM "WorkspacePRDelivery" WHERE "id" = \'seed-delivery-blocked\'');
      db.exec('DELETE FROM "TerminalSession" WHERE "status" = \'FAILED\'');
    } finally {
      db.close();
    }
    const coverage = measureSeedCoverage(databasePath, lastRelease);
    expect(coverage.emptyTables).toEqual(['SessionLifecycleEvent']);
    expect(coverage.missingEnumValues).toContain('TerminalSession.status=FAILED');
    expect(coverage.missingEnumValues).toContain('SessionLifecycleEvent.reason=USER_STOP');
    // A string-typed column with a closed set of values is checked the same way.
    expect(coverage.missingEnumValues).toContain('WorkspacePRDelivery.state=BLOCKED');
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
