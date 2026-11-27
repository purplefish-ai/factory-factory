#!/usr/bin/env node

// Pins the upgrade check to a published release: reads the migration directory
// names and the Prisma enums out of the published `factory-factory` package and
// rewrites src/backend/testing/fixtures/upgrade/last-release.json. Run it by
// hand when a release has been published (see docs/npm-release-security.md); CI
// never runs it. Usage: node scripts/update-last-release-migrations.mjs <version>

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
 * `{ EnumName: [values] }` for every `enum` block of a Prisma schema.
 * @param {string} schema
 * @returns {Record<string, string[]>}
 */
export function parsePrismaEnums(schema) {
  const enums = {};
  for (const [, name, body] of schema.matchAll(/^enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
    enums[name] = body
      .split('\n')
      .map(stripComments)
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[0]);
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

/** The fixture for one published version, from its file listing and its schema text. */
export function buildLastRelease({ version, files, schema }) {
  const migrations = listPackedMigrations(files);
  if (migrations.length === 0) {
    throw new Error(`${PACKAGE_NAME}@${version} lists no prisma/migrations/*/migration.sql`);
  }
  const enums = parsePrismaEnums(schema);
  if (Object.keys(enums).length === 0) {
    throw new Error(`${PACKAGE_NAME}@${version} has no enums in prisma/schema.prisma`);
  }
  return { version, migrations, enums, enumColumns: parseEnumColumns(schema, enums) };
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
  const schema = execFileSync('tar', ['-xzOf', tarball, 'package/prisma/schema.prisma'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  return { files, schema };
}

/** A published migration the repository no longer has cannot be replayed by the check. */
function assertRepositoryHasMigrations(migrations) {
  const directory = join(repositoryRoot, 'prisma/migrations');
  const present = new Set(readdirSync(directory));
  const missing = migrations.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(
      `prisma/migrations lacks migrations the published package ships: ${missing.join(', ')}. ` +
        'Release from a commit on main that contains them.'
    );
  }
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
    assertRepositoryHasMigrations(lastRelease.migrations);
    writeFileSync(LAST_RELEASE_PATH, formatLastRelease(lastRelease));
    process.stdout.write(
      `Pinned ${PACKAGE_NAME}@${version}: ${lastRelease.migrations.length} migrations, ` +
        `${Object.keys(lastRelease.enums).length} enums, ` +
        `${Object.keys(lastRelease.enumColumns).length} enum columns.\n` +
        'Regenerate the seed next: pnpm exec tsx scripts/generate-upgrade-seed.ts\n'
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
