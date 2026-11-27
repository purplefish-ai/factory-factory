import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildLastRelease,
  checksumOf,
  formatLastRelease,
  LAST_RELEASE_PATH,
  listPackedMigrations,
  parseEnumColumns,
  parsePrismaEnums,
} from './update-last-release-migrations.mjs';

const fakeSchema = `
enum Color {
  RED    // the first
  GREEN
}

/// Not an enum value list.
enum Size {
  SMALL
  LARGE
}

enum Phase {
  PENDING @map("pending")
  DONE
  @@map("phase")
}

model Paint {
  id    String @id
  color Color  @default(RED)
  size  Size?
  tags  Color[]
  name  String
}

model Brush {
  id     String @id
  shade  Color  @map("shade_color")
  @@map("brushes")
}
`;

describe('update-last-release-migrations', () => {
  it('lists the migrations of a package, in applied order, and nothing else', () => {
    expect(
      listPackedMigrations([
        'package/prisma/migrations/20260102000000_second/migration.sql',
        'package/prisma/migrations/20260101000000_first/migration.sql',
        'package/prisma/migrations/migration_lock.toml',
        'package/prisma/migrations/20260103000000_empty/README.md',
        'package/prisma/schema.prisma',
        'package/dist/prisma/migrations/20260104000000_other/migration.sql',
      ])
    ).toEqual(['20260101000000_first', '20260102000000_second']);
  });

  it('reads enums and the columns that store them, by SQLite table and column name', () => {
    const enums = parsePrismaEnums(fakeSchema);
    expect(enums).toEqual({
      Color: ['RED', 'GREEN'],
      Size: ['SMALL', 'LARGE'],
      Phase: ['pending', 'DONE'],
    });
    expect(parseEnumColumns(fakeSchema, enums)).toEqual({
      'Paint.color': 'Color',
      'Paint.size': 'Size',
      'brushes.shade_color': 'Color',
    });
  });

  const fakeFiles = [
    'package/prisma/migrations/20260102000000_second/migration.sql',
    'package/prisma/migrations/20260101000000_first/migration.sql',
  ];
  const fakeSql = {
    '20260101000000_first': 'CREATE TABLE "A" ("id" TEXT NOT NULL PRIMARY KEY);\n',
    '20260102000000_second': 'ALTER TABLE "A" ADD COLUMN "name" TEXT;\n',
  };

  it('builds the fixture for a published listing and rejects an incomplete one', () => {
    expect(
      buildLastRelease({
        version: '1.2.3',
        files: fakeFiles,
        schema: fakeSchema,
        migrationSql: fakeSql,
      })
    ).toEqual({
      version: '1.2.3',
      migrations: ['20260101000000_first', '20260102000000_second'],
      checksums: {
        '20260101000000_first': checksumOf(fakeSql['20260101000000_first']),
        '20260102000000_second': checksumOf(fakeSql['20260102000000_second']),
      },
      enums: { Color: ['RED', 'GREEN'], Size: ['SMALL', 'LARGE'], Phase: ['pending', 'DONE'] },
      enumColumns: { 'Paint.color': 'Color', 'Paint.size': 'Size', 'brushes.shade_color': 'Color' },
    });
    const build = (overrides: Partial<Parameters<typeof buildLastRelease>[0]>) =>
      buildLastRelease({
        version: '1.2.3',
        files: fakeFiles,
        schema: fakeSchema,
        migrationSql: fakeSql,
        ...overrides,
      });
    expect(() => build({ files: [] })).toThrow('lists no prisma/migrations');
    expect(() => build({ schema: 'model A {}' })).toThrow('no enums');
    expect(() => build({ migrationSql: {} })).toThrow('has no SQL for migration');
  });

  it('records a different checksum when a migration differs by one byte', () => {
    expect(checksumOf(fakeSql['20260101000000_first'])).not.toBe(
      checksumOf(`${fakeSql['20260101000000_first']} `)
    );
    expect(checksumOf('x')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('writes JSON that round-trips through the formatter', () => {
    const lastRelease = buildLastRelease({
      version: '1.2.3',
      files: fakeFiles,
      schema: fakeSchema,
      migrationSql: fakeSql,
    });
    expect(JSON.parse(formatLastRelease(lastRelease))).toEqual(lastRelease);
    expect(formatLastRelease(lastRelease).endsWith('\n')).toBe(true);
  });

  it('keeps every enum value the pinned release used, because migrations are additive', () => {
    const committed = z
      .object({ migrations: z.array(z.string()), enums: z.record(z.string(), z.array(z.string())) })
      .parse(JSON.parse(readFileSync(LAST_RELEASE_PATH, 'utf8')));
    const schema = readFileSync(join(import.meta.dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
    // Every enum value the pinned release used still exists: migrations are additive.
    const current = parsePrismaEnums(schema);
    for (const [name, values] of Object.entries(committed.enums)) {
      expect(current[name], name).toEqual(expect.arrayContaining(values));
    }
  });

  it('refuses a missing or malformed version without touching the registry', () => {
    for (const args of [[], ['latest'], ['1.2'], ['1.2.3', 'extra']]) {
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dirname, 'update-last-release-migrations.mjs'), ...args],
        { encoding: 'utf8' }
      );
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.stderr).toContain('Usage:');
    }
  });
});
