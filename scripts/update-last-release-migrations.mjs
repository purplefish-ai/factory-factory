#!/usr/bin/env node

// Pins the upgrade check to a published release: reads the migration directory
// names, their SQL checksums and the Prisma enums out of the published
// `factory-factory` package and rewrites
// src/backend/testing/fixtures/upgrade/last-release.json. Run it by
// hand when a release has been published (see docs/npm-release-security.md); CI
// never runs it. Usage: node scripts/update-last-release-migrations.mjs <version>

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PACKAGE_NAME = 'factory-factory';
const SEMVER = /^\d+\.\d+\.\d+$/;
const MIGRATION_PATH = /^(?:package\/)?prisma\/migrations\/([^/]+)\/migration\.sql$/;
const repositoryRoot = resolve(import.meta.dirname, '..');
export const LAST_RELEASE_PATH = join(
  repositoryRoot,
  'src/backend/testing/fixtures/upgrade/last-release.json'
);
const SEED_PATH = join(
  repositoryRoot,
  'src/backend/testing/fixtures/upgrade/last-release-seed.sql'
);

/** Migration directory names that ship a migration.sql, sorted as the migrator applies them. */
export function listPackedMigrations(files) {
  return files
    .flatMap((file) => {
      const match = MIGRATION_PATH.exec(file);
      return match ? [match[1]] : [];
    })
    .sort();
}

const stripComments = (line) => line.replace(/\/\/.*$/, '').trim();

/**
 * `{ EnumName: [stored values] }` for every `enum` block of a Prisma schema. A
 * value with `@map("x")` is stored in SQLite as `x`, so that is the value listed.
 * @param {string} schema
 * @returns {Record<string, string[]>}
 */
export function parsePrismaEnums(schema) {
  const enums = {};
  for (const [, name, body] of schema.matchAll(/^enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
    enums[name] = body
      .split('\n')
      .map(stripComments)
      .filter((line) => line && !line.startsWith('@@'))
      .map((line) => /@map\("([^"]+)"\)/.exec(line)?.[1] ?? line.split(/\s+/)[0]);
  }
  return enums;
}

/**
 * `{ "Table.column": "EnumName" }` for every model field typed with an enum.
 * Tables and columns are the SQLite names, so `@@map` and `@map` apply.
 * @param {string} schema
 * @param {Record<string, string[]>} enums
 * @returns {Record<string, string>}
 */
export function parseEnumColumns(schema, enums) {
  const columns = {};
  for (const [, model, body] of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const lines = body.split('\n').map(stripComments).filter(Boolean);
    const table = lines.flatMap((line) => /^@@map\("([^"]+)"\)/.exec(line)?.slice(1) ?? [])[0];
    for (const line of lines) {
      const field = /^(\w+)\s+(\w+)(\?|\[\])?(\s|$)/.exec(line);
      if (!field || field[3] === '[]' || !Object.hasOwn(enums, field[2])) {
        continue;
      }
      const column = /@map\("([^"]+)"\)/.exec(line)?.[1] ?? field[1];
      columns[`${table ?? model}.${column}`] = field[2];
    }
  }
  return Object.fromEntries(Object.entries(columns).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** SHA-256 of a migration's exact bytes. */
export function checksumOf(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * The fixture for one published version, from its file listing, its schema text
 * and the SQL of each migration it ships (name to contents).
 * @param {{
 *   version: string,
 *   files: string[],
 *   schema: string,
 *   migrationSql: Record<string, string | Uint8Array>,
 * }} input
 */
export function buildLastRelease({ version, files, schema, migrationSql }) {
  const migrations = listPackedMigrations(files);
  if (migrations.length === 0) {
    throw new Error(`${PACKAGE_NAME}@${version} lists no prisma/migrations/*/migration.sql`);
  }
  const enums = parsePrismaEnums(schema);
  if (Object.keys(enums).length === 0) {
    throw new Error(`${PACKAGE_NAME}@${version} has no enums in prisma/schema.prisma`);
  }
  const checksums = Object.fromEntries(
    migrations.map((name) => {
      const sql = migrationSql[name];
      if (sql === undefined) {
        throw new Error(`${PACKAGE_NAME}@${version} has no SQL for migration ${name}`);
      }
      return [name, checksumOf(sql)];
    })
  );
  // The seed digest is filled in once the seed is regenerated for this release.
  return {
    version,
    migrations,
    checksums,
    seedDigest: '',
    enums,
    enumColumns: parseEnumColumns(schema, enums),
  };
}

export function formatLastRelease(lastRelease) {
  return `${JSON.stringify(lastRelease, null, 2)}\n`;
}

/** Download the published tarball into `directory` and read what the fixture needs. */
function readPublishedPackage(version, directory) {
  execFileSync(
    'npm',
    ['pack', '--silent', `${PACKAGE_NAME}@${version}`, '--pack-destination', directory],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  );
  const tarball = join(directory, `${PACKAGE_NAME}-${version}.tgz`);
  const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\n')
    .filter(Boolean);
  const extracted = join(directory, 'extracted');
  mkdirSync(extracted);
  execFileSync('tar', [
    '-xzf',
    tarball,
    '-C',
    extracted,
    'package/prisma/schema.prisma',
    'package/prisma/migrations',
  ]);
  const schema = readFileSync(join(extracted, 'package/prisma/schema.prisma'), 'utf8');
  const migrationSql = Object.fromEntries(
    listPackedMigrations(files).map((name) => [
      name,
      readFileSync(join(extracted, 'package/prisma/migrations', name, 'migration.sql')),
    ])
  );
  return { files, schema, migrationSql };
}

/**
 * The check replays this repository's copies of the published migrations, so
 * each must exist and match the published bytes: a released migration is never
 * edited.
 */
function assertRepositoryHasPublishedMigrations({ migrations, checksums }) {
  const directory = join(repositoryRoot, 'prisma/migrations');
  const problems = migrations.flatMap((name) => {
    const path = join(directory, name, 'migration.sql');
    if (!existsSync(path)) {
      return [`${name} is missing`];
    }
    return checksumOf(readFileSync(path)) === checksums[name] ? [] : [`${name} differs`];
  });
  if (problems.length > 0) {
    throw new Error(
      `prisma/migrations does not match the published package: ${problems.join('; ')}. ` +
        'Release from a commit on main that contains the shipped migrations unchanged.'
    );
  }
}

function writeLastRelease(lastRelease) {
  writeFileSync(LAST_RELEASE_PATH, formatLastRelease(lastRelease));
  // Keep the committed layout: the repository formatter, not JSON.stringify, owns it.
  execFileSync('pnpm', ['exec', 'oxfmt', '--write', LAST_RELEASE_PATH], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

/** The generator opens only throwaway databases; keep the owner's settings out of it anyway. */
function regenerateSeed() {
  const env = { ...process.env };
  for (const name of ['DATABASE_PATH', 'BASE_DIR', 'NODE_ENV', 'BACKEND_PORT']) {
    delete env[name];
  }
  execFileSync('pnpm', ['exec', 'tsx', 'scripts/generate-upgrade-seed.ts'], {
    cwd: repositoryRoot,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

function main(argv) {
  const [version, ...rest] = argv;
  if (!(version && SEMVER.test(version)) || rest.length > 0) {
    process.stderr.write(`Usage: node scripts/update-last-release-migrations.mjs <x.y.z>\n`);
    process.exit(2);
  }
  const directory = mkdtempSync(join(tmpdir(), 'ff-last-release-'));
  try {
    const lastRelease = buildLastRelease({ version, ...readPublishedPackage(version, directory) });
    assertRepositoryHasPublishedMigrations(lastRelease);
    writeLastRelease(lastRelease);
    regenerateSeed();
    // The digest is what lets the check refuse a seed edited outside a re-pin.
    writeLastRelease({ ...lastRelease, seedDigest: checksumOf(readFileSync(SEED_PATH)) });
    process.stdout.write(
      `Pinned ${PACKAGE_NAME}@${version}: ${lastRelease.migrations.length} migrations, ` +
        `${Object.keys(lastRelease.enums).length} enums, ` +
        `${Object.keys(lastRelease.enumColumns).length} enum columns.\n` +
        'Seed regenerated and its digest recorded; commit last-release.json and last-release-seed.sql.\n'
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (!existsSync(join(repositoryRoot, 'prisma/migrations'))) {
    throw new Error('Run this from a Factory Factory checkout.');
  }
  main(process.argv.slice(2));
}
