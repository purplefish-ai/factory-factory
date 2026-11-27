/**
 * Writes the upgrade check's SQL seed from the rows in
 * src/backend/testing/upgrade/seed-rows.ts, after loading it into a throwaway
 * database migrated to the last release to prove it is complete: a row in every
 * table and every enum value in use. Run it whenever the rows change and after
 * `node scripts/update-last-release-migrations.mjs <version>`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LAST_RELEASE_SEED_FILE,
  loadSeed,
  measureSeedCoverage,
  migrateToLastRelease,
  readLastRelease,
} from '@/backend/testing/upgrade/last-release';
import { seedTables } from '@/backend/testing/upgrade/seed-rows';
import { renderSeedSql } from '@/backend/testing/upgrade/seed-sql';

const lastRelease = readLastRelease();
const sql = renderSeedSql(seedTables);
const directory = mkdtempSync(join(tmpdir(), 'ff-upgrade-seed-'));
try {
  const databasePath = join(directory, 'seed.db');
  migrateToLastRelease(databasePath, lastRelease);
  loadSeed(databasePath, sql);
  const coverage = measureSeedCoverage(databasePath, lastRelease);
  if (coverage.emptyTables.length > 0 || coverage.missingEnumValues.length > 0) {
    throw new Error(
      `The seed is incomplete. Tables without rows: ${coverage.emptyTables.join(', ') || 'none'}. ` +
        `Enum values never stored: ${coverage.missingEnumValues.join(', ') || 'none'}.`
    );
  }
  writeFileSync(LAST_RELEASE_SEED_FILE, sql);
  const rows = Object.values(coverage.tableRowCounts).reduce((sum, count) => sum + count, 0);
  process.stdout.write(
    `Wrote ${LAST_RELEASE_SEED_FILE}: ${Object.keys(coverage.tableRowCounts).length} tables, ${rows} rows, ` +
      `${Object.keys(lastRelease.enumColumns).length} enum columns covered.\n`
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
