/**
 * Writes the upgrade check's SQL seed from the rows in
 * src/backend/testing/upgrade/seed-rows.ts, after loading it into a throwaway
 * database migrated to the last release to prove it is complete: a row in every
 * table and every enum value in use. Do not run it by hand: the re-pin step,
 * `node scripts/update-last-release-migrations.mjs <version>`, runs it and
 * records the seed's digest, which the check compares. The seed changes only
 * when re-pinning or adding rows for a new table or value.
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

// During a re-pin the digest is still empty; the re-pin step records it after this run.
const lastRelease = readLastRelease({ seedPending: true });
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
