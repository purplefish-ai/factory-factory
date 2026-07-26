/**
 * Enum drift guard.
 *
 * `src/shared/core/enums.ts` hand-mirrors the enums declared in
 * `prisma/schema.prisma` so that client code can use them without importing
 * generated Prisma types. That mirror is only safe if it stays in sync: a value
 * added to the schema but not here (or renamed on one side) produces a runtime
 * mismatch between what the database stores and what the UI branches on.
 *
 * This test parses the schema and asserts every shared enum matches its Prisma
 * counterpart exactly. Enums that are intentionally Prisma-only (consumed via
 * `@prisma-gen/client` and never mirrored) are allowed to have no shared twin.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as sharedEnums from './enums';

const SCHEMA_PATH = fileURLToPath(new URL('../../../prisma/schema.prisma', import.meta.url));

/** Enums declared in the Prisma schema that are deliberately not mirrored into shared. */
const PRISMA_ONLY_ENUMS = new Set(['RatchetDispatchOutcome', 'NotificationDirection']);

/** Parse `enum Name { A B }` blocks out of a Prisma schema, ignoring comments. */
function parsePrismaEnums(schema: string): Map<string, string[]> {
  const enums = new Map<string, string[]>();
  const blockPattern = /^enum\s+(\w+)\s*\{([^}]*)\}/gm;

  for (const match of schema.matchAll(blockPattern)) {
    const [, name, body] = match;
    if (!name || body === undefined) {
      continue;
    }

    const values = body
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => line.length > 0);

    enums.set(name, values);
  }

  return enums;
}

/** Shared enums are exported as const objects; everything else in the module is ignored. */
function collectSharedEnums(): Map<string, Record<string, string>> {
  const collected = new Map<string, Record<string, string>>();

  for (const [name, value] of Object.entries(sharedEnums)) {
    if (typeof value === 'object' && value !== null) {
      collected.set(name, value as Record<string, string>);
    }
  }

  return collected;
}

const prismaEnums = parsePrismaEnums(readFileSync(SCHEMA_PATH, 'utf8'));
const sharedEnumsByName = collectSharedEnums();

describe('prisma <-> shared enum drift guard', () => {
  it('parses the enums out of the Prisma schema', () => {
    // Guards the parser itself: a schema reformat that breaks parsing would
    // otherwise make every assertion below vacuously pass.
    expect(prismaEnums.size).toBeGreaterThan(0);
    expect(prismaEnums.get('WorkspaceStatus')).toEqual([
      'NEW',
      'PROVISIONING',
      'READY',
      'FAILED',
      'ARCHIVING',
      'ARCHIVED',
    ]);
  });

  it('exports a shared mirror for every Prisma enum that is not Prisma-only', () => {
    const missing = [...prismaEnums.keys()].filter(
      (name) => !(PRISMA_ONLY_ENUMS.has(name) || sharedEnumsByName.has(name))
    );

    expect(missing).toEqual([]);
  });

  it('does not export shared enums that no longer exist in the Prisma schema', () => {
    const orphaned = [...sharedEnumsByName.keys()].filter((name) => !prismaEnums.has(name));

    expect(orphaned).toEqual([]);
  });

  it.each([...sharedEnumsByName.keys()])('keeps %s synchronized with the Prisma schema', (name) => {
    const shared = sharedEnumsByName.get(name);
    const prismaValues = prismaEnums.get(name);

    expect(shared).toBeDefined();
    expect(prismaValues).toBeDefined();

    // Shared enums are `{ VALUE: 'VALUE' }` maps, so keys and values must both
    // match the schema — a typo'd value is as breaking as a missing one.
    expect(Object.keys(shared ?? {}).sort()).toEqual([...(prismaValues ?? [])].sort());
    expect(Object.values(shared ?? {}).sort()).toEqual([...(prismaValues ?? [])].sort());
  });
});
