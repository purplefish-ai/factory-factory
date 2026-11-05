import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { PrismaClient } from '@prisma-gen/client';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!state.prisma) {
      throw new Error('Missing database');
    }
    return state.prisma;
  },
}));
import { withBackupImport } from './backup-snapshot';
import { dataBackupAccessor } from './data-backup.accessor';

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
}, 30_000);
beforeEach(async () => clearIntegrationDatabase(db.prisma));
afterAll(async () => destroyIntegrationDatabase(db));

it('preserves an accepted ordinary write before the import transaction first accesses SQLite', async () => {
  const failure = new Error('late import failure');
  let ordinaryAccepted = false;
  await expect(
    dataBackupAccessor.runInTransaction(async (tx) => {
      await db.prisma.project.create({
        data: {
          id: 'ordinary',
          name: 'Ordinary',
          slug: 'ordinary',
          repoPath: '/p',
          worktreeBasePath: '/w',
        },
      });
      ordinaryAccepted = true;
      await tx.project.create({
        data: {
          id: 'imported',
          name: 'Imported',
          slug: 'imported',
          repoPath: '/p',
          worktreeBasePath: '/w',
        },
      });
      throw failure;
    })
  ).rejects.toBe(failure);
  expect(ordinaryAccepted).toBe(true);
  expect(await db.prisma.project.findUnique({ where: { id: 'ordinary' } })).not.toBeNull();
  expect(await db.prisma.project.findUnique({ where: { id: 'imported' } })).toBeNull();
});

it('rejects missing files without creating them and uses the configured physical busy timeout', async () => {
  const missing = join(db.tempDir, 'missing.db');
  const source: Pick<PrismaClient, '$queryRaw'> = {
    $queryRaw: vi.fn().mockResolvedValue([{ name: 'main', file: missing }]),
  };
  await expect(withBackupImport(source, (tx) => tx.project.findMany())).rejects.toMatchObject({
    code: 'SQLITE_CANTOPEN',
    message: 'unable to open database file',
  });
  expect(existsSync(missing)).toBe(false);
  await expect(
    withBackupImport(db.prisma, (tx) => tx.$queryRaw`PRAGMA busy_timeout`)
  ).resolves.toEqual([{ timeout: 5000n }]);
  expect(await db.prisma.$queryRaw`PRAGMA journal_mode`).toEqual([{ journal_mode: 'wal' }]);
});

// Set a short busy wait only on this private test connection before its first
// database read/write. This still exercises native contention rather than the
// immediate failure of a read-to-write lock upgrade; the configured 5s default
// is verified independently above and again on the fresh retry connection.
it('bounds the actual private writer busy wait and disconnects before a fresh whole transaction', async () => {
  const holder = new Database(db.databasePath);
  holder.exec('BEGIN IMMEDIATE');
  let busyWaitStarted = 0;
  try {
    await expect(
      dataBackupAccessor.runInTransaction(async (tx) => {
        await expect(tx.$queryRaw`PRAGMA busy_timeout = 50`).resolves.toEqual([{ timeout: 50n }]);
        busyWaitStarted = performance.now();
        return tx.project.create({
          data: {
            id: 'contended',
            name: 'Contended',
            slug: 'contended',
            repoPath: '/p',
            worktreeBasePath: '/w',
          },
        });
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(busyWaitStarted).toBeGreaterThan(0);
    const busyWaitMs = performance.now() - busyWaitStarted;
    expect(busyWaitMs).toBeGreaterThanOrEqual(25);
    expect(busyWaitMs).toBeLessThan(5000);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  expect(await db.prisma.project.count()).toBe(0);
  await dataBackupAccessor.runInTransaction(async (tx) => {
    await expect(tx.$queryRaw`PRAGMA busy_timeout`).resolves.toEqual([{ timeout: 5000n }]);
    return tx.project.create({
      data: { id: 'retry', name: 'Retry', slug: 'retry', repoPath: '/p', worktreeBasePath: '/w' },
    });
  });
  expect(await db.prisma.project.count()).toBe(1);
}, 25_000);
