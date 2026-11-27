import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildLastRelease,
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
    expect(enums).toEqual({ Color: ['RED', 'GREEN'], Size: ['SMALL', 'LARGE'] });
    expect(parseEnumColumns(fakeSchema, enums)).toEqual({
      'Paint.color': 'Color',
      'Paint.size': 'Size',
      'brushes.shade_color': 'Color',
    });
  });

  it('builds the fixture for a published listing and rejects an empty one', () => {
    const files = ['package/prisma/migrations/20260101000000_first/migration.sql'];
    expect(buildLastRelease({ version: '1.2.3', files, schema: fakeSchema })).toEqual({
      version: '1.2.3',
      migrations: ['20260101000000_first'],
      enums: { Color: ['RED', 'GREEN'], Size: ['SMALL', 'LARGE'] },
      enumColumns: { 'Paint.color': 'Color', 'Paint.size': 'Size', 'brushes.shade_color': 'Color' },
    });
    expect(() => buildLastRelease({ version: '1.2.3', files: [], schema: fakeSchema })).toThrow(
      'lists no prisma/migrations'
    );
    expect(() => buildLastRelease({ version: '1.2.3', files, schema: 'model A {}' })).toThrow(
      'no enums'
    );
  });

  it('writes JSON that round-trips through the formatter', () => {
    const lastRelease = buildLastRelease({
      version: '1.2.3',
      files: ['package/prisma/migrations/20260101000000_first/migration.sql'],
      schema: fakeSchema,
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
        'node',
        [join(import.meta.dirname, 'update-last-release-migrations.mjs'), ...args],
        { encoding: 'utf8' }
      );
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.stderr).toContain('Usage:');
    }
  });
});
