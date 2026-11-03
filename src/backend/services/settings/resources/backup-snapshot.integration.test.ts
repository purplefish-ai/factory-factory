import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { PrismaClient } from '@prisma-gen/client';
import { withBackupSnapshot } from './backup-snapshot';

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
}, 30_000);
afterAll(async () => destroyIntegrationDatabase(db));

it.each([
  'INSERT INTO "Project" ("id") VALUES (\'forbidden\')',
  'UPDATE "Project" SET "name" = \'forbidden\'',
])('physically rejects SQL writes through the private export transaction: %s', async (sql) => {
  await expect(
    withBackupSnapshot(db.prisma, async (tx) => {
      await tx.$executeRaw`PRAGMA query_only = OFF`;
      return tx.$executeRawUnsafe(sql);
    })
  ).rejects.toThrow(/readonly/i);
  await db.prisma.project.upsert({
    where: { id: 'writer' },
    create: {
      id: 'writer',
      name: 'Writer',
      slug: 'writer',
      repoPath: '/tmp/p',
      worktreeBasePath: '/tmp/w',
    },
    update: { name: 'Writer survived' },
  });
  expect(await db.prisma.project.count()).toBe(1);
});

it('rejects nonexistent files without creating them', async () => {
  const missing = join(db.tempDir, 'missing.db');
  const source: Pick<PrismaClient, '$queryRaw'> = {
    $queryRaw: vi.fn().mockResolvedValue([{ name: 'main', file: missing }]),
  };
  await expect(withBackupSnapshot(source, (tx) => tx.project.findMany())).rejects.toThrow();
  expect(existsSync(missing)).toBe(false);
});

it('reads the physical connection busy timeout and leaves the writer journal in WAL', async () => {
  const result = await withBackupSnapshot(db.prisma, (tx) => tx.$queryRaw`PRAGMA busy_timeout`);
  expect(result).toEqual([{ timeout: 5000n }]);
  expect(await db.prisma.$queryRaw`PRAGMA journal_mode`).toEqual([{ journal_mode: 'wal' }]);
});
