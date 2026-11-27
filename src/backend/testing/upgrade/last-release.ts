import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { runMigrations } from '@/backend/migrate';

const FIXTURE_DIRECTORY = join(import.meta.dirname, '..', 'fixtures', 'upgrade');
export const REPOSITORY_MIGRATIONS = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'prisma',
  'migrations'
);

export const LAST_RELEASE_FILE = join(FIXTURE_DIRECTORY, 'last-release.json');
export const LAST_RELEASE_SEED_FILE = join(FIXTURE_DIRECTORY, 'last-release-seed.sql');

/**
 * What the last published package shipped, written by
 * `scripts/update-last-release-migrations.mjs` when a release is cut.
 */
const lastReleaseSchema = z
  .strictObject({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    migrations: z.array(z.string().min(1)).min(1),
    /** SHA-256 of each migration's `migration.sql` as published, by migration name. */
    checksums: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    /** Every Prisma enum of the release's schema and its values. */
    enums: z.record(z.string(), z.array(z.string().min(1)).min(1)),
    /** `Table.column` to the enum it stores, for columns typed with an enum. */
    enumColumns: z.record(z.string(), z.string()),
  })
  .refine((release) => release.migrations.every((name) => release.checksums[name] !== undefined), {
    message: 'Every migration needs a published checksum',
  });
export type LastRelease = z.infer<typeof lastReleaseSchema>;

export function readLastRelease(): LastRelease {
  return lastReleaseSchema.parse(JSON.parse(readFileSync(LAST_RELEASE_FILE, 'utf8')));
}

export function readLastReleaseSeedSql(): string {
  return readFileSync(LAST_RELEASE_SEED_FILE, 'utf8');
}

/** Listed migrations that this repository no longer has (a published migration was edited away). */
export function findMissingMigrations(
  migrations: readonly string[],
  migrationsPath = REPOSITORY_MIGRATIONS
): string[] {
  return migrations.filter((name) => !existsSync(join(migrationsPath, name, 'migration.sql')));
}

/** Listed migrations whose SQL here differs from the bytes the release published. */
export function findEditedMigrations(
  lastRelease: Pick<LastRelease, 'migrations' | 'checksums'>,
  migrationsPath = REPOSITORY_MIGRATIONS
): string[] {
  return lastRelease.migrations.filter((name) => {
    const path = join(migrationsPath, name, 'migration.sql');
    const published = lastRelease.checksums[name];
    return (
      existsSync(path) &&
      createHash('sha256').update(readFileSync(path)).digest('hex') !== published
    );
  });
}

/**
 * Create `databasePath` as the last release left it: only the migrations that
 * release shipped, applied in order by the real migrator. The repository's copies
 * are the published ones, because a released migration is never edited.
 */
export function migrateToLastRelease(
  databasePath: string,
  lastRelease: LastRelease = readLastRelease(),
  migrationsPath = REPOSITORY_MIGRATIONS
): void {
  const missing = findMissingMigrations(lastRelease.migrations, migrationsPath);
  if (missing.length > 0) {
    throw new Error(
      `prisma/migrations lacks ${missing.length} migration(s) shipped in ${lastRelease.version}: ` +
        `${missing.join(', ')}. A released migration must never be renamed, edited away or deleted.`
    );
  }
  const edited = findEditedMigrations(lastRelease, migrationsPath);
  if (edited.length > 0) {
    throw new Error(
      `${edited.length} migration(s) shipped in ${lastRelease.version} were edited after release: ` +
        `${edited.join(', ')}. Users already ran the published SQL; write a new migration instead.`
    );
  }
  const staging = mkdtempSync(join(tmpdir(), 'ff-last-release-migrations-'));
  try {
    for (const name of lastRelease.migrations) {
      mkdirSync(join(staging, name));
      cpSync(join(migrationsPath, name, 'migration.sql'), join(staging, name, 'migration.sql'));
    }
    runMigrations({
      databasePath,
      migrationsPath: staging,
      log: () => {
        // Silent: the check reports its own progress.
      },
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Insert the seed with foreign keys enforced, so a row with a missing parent fails loudly. */
export function loadSeed(databasePath: string, seedSql = readLastReleaseSeedSql()): void {
  const db = new Database(databasePath);
  try {
    db.pragma('foreign_keys = ON');
    db.exec(seedSql);
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      throw new Error(`Seed leaves ${violations.length} foreign key violation(s)`);
    }
  } finally {
    db.close();
  }
}

export interface SeedCoverage {
  /** Application tables with no seeded row. */
  emptyTables: string[];
  /** `Table.column=VALUE` for every enum value no seeded row stores. */
  missingEnumValues: string[];
  tableRowCounts: Record<string, number>;
}

const quoted = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

/** Whether the seeded database has a row in every table and every enum value in its column. */
export function measureSeedCoverage(databasePath: string, lastRelease: LastRelease): SeedCoverage {
  const db = new Database(databasePath, { readonly: true });
  try {
    const tables = z
      .array(z.object({ name: z.string() }))
      .parse(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
          )
          .all()
      )
      .map((row) => row.name);
    const tableRowCounts = Object.fromEntries(
      tables.map((table) => [
        table,
        z
          .object({ count: z.number() })
          .parse(db.prepare(`SELECT count(*) AS count FROM ${quoted(table)}`).get()).count,
      ])
    );
    const missingEnumValues = Object.entries(lastRelease.enumColumns).flatMap(
      ([tableColumn, enumName]) => {
        const [table = '', column = ''] = tableColumn.split('.');
        const stored = new Set(
          z
            .array(z.object({ value: z.string().nullable() }))
            .parse(
              db.prepare(`SELECT DISTINCT ${quoted(column)} AS value FROM ${quoted(table)}`).all()
            )
            .map((row) => row.value)
        );
        const values = lastRelease.enums[enumName];
        if (!values) {
          throw new Error(`${tableColumn} names enum ${enumName}, which last-release.json lacks`);
        }
        return values
          .filter((value) => !stored.has(value))
          .map((value) => `${tableColumn}=${value}`);
      }
    );
    return {
      emptyTables: tables.filter((table) => tableRowCounts[table] === 0),
      missingEnumValues,
      tableRowCounts,
    };
  } finally {
    db.close();
  }
}
