import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, inject, it, vi } from 'vitest';
import { TunedPrismaBetterSqlite3 } from '@/backend/lib/sqlite-adapter';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';
import setupIntegrationDatabase from './integration-db.global-setup';

const databases: IntegrationDatabase[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) {
    await destroyIntegrationDatabase(db);
    expect(existsSync(db.tempDir)).toBe(false);
  }
  vi.unstubAllEnvs();
});

it('provides a fully migrated template containing every current migration checksum', () => {
  const templatePath = inject('integrationDatabaseTemplate');
  expect(templatePath).toBeTypeOf('string');
  const template = new Database(templatePath, { readonly: true });
  try {
    const migrationsPath = join(process.cwd(), 'prisma/migrations');
    const expected = readdirSync(migrationsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(migrationsPath, name, 'migration.sql')))
      .sort()
      .map((name) => ({
        migration_name: name,
        checksum: createHash('sha256')
          .update(readFileSync(join(migrationsPath, name, 'migration.sql')))
          .digest('hex'),
        applied_steps_count: 1,
      }));
    expect(
      template
        .prepare(
          'SELECT migration_name, checksum, applied_steps_count FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name'
        )
        .all()
    ).toEqual(expected);
    expect(template.pragma('foreign_key_check')).toEqual([]);
  } finally {
    template.close();
  }
});

it('keeps each database private, writable with WAL, and independent of the template', async () => {
  const templatePath = inject('integrationDatabaseTemplate');
  const templateBefore = readFileSync(templatePath);
  const first = await createIntegrationDatabase();
  databases.push(first);
  await first.prisma.project.create({
    data: {
      name: 'Only first',
      slug: 'only-first',
      repoPath: '/tmp/only-first',
      worktreeBasePath: '/tmp/worktrees',
    },
  });
  expect(await first.prisma.$queryRawUnsafe('PRAGMA journal_mode')).toEqual([
    { journal_mode: 'wal' },
  ]);
  expect(
    await first.prisma.codexAccount.findUnique({ where: { id: 'codex-native-default' } })
  ).toBeTruthy();

  const second = await createIntegrationDatabase();
  databases.push(second);
  expect(second.databasePath).not.toBe(first.databasePath);
  expect(second.tempDir).not.toBe(first.tempDir);
  expect(second.databasePath).not.toBe(templatePath);
  expect(await second.prisma.project.count()).toBe(0);
  expect(await first.prisma.project.count()).toBe(1);
  expect(readFileSync(templatePath)).toEqual(templateBefore);
  // Cold Prisma engine setup can exceed the default timeout under V8 coverage.
}, 30_000);

it('rebinds runtime modules and environment to the new private database', async () => {
  vi.stubEnv('BASE_DIR', '/tmp/unused-integration-base');
  const first = await createIntegrationDatabase();
  databases.push(first);
  const firstRuntime = await vi.importActual<typeof import('@/backend/db')>('@/backend/db');
  expect(firstRuntime.prisma).toBe(first.prisma);
  expect(firstRuntime.getCurrentDatabasePath()).toBe(first.databasePath);

  const second = await createIntegrationDatabase();
  databases.push(second);
  const secondRuntime = await vi.importActual<typeof import('@/backend/db')>('@/backend/db');
  expect(secondRuntime.prisma).toBe(second.prisma);
  expect(secondRuntime.getCurrentDatabasePath()).toBe(second.databasePath);
});

it('removes the closed migration template at project teardown', () => {
  let templatePath = '';
  const cleanup = setupIntegrationDatabase({
    config: { root: process.cwd() },
    onTestsRerun: () => {
      // This test exercises project setup and teardown only.
    },
    provide: (_key, value) => {
      templatePath = value;
    },
  });
  try {
    const connection = new Database(templatePath, { readonly: true });
    try {
      expect(connection.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      connection.close();
    }
  } finally {
    cleanup();
  }
  expect(existsSync(templatePath)).toBe(false);
});

it('removes the migration template when project setup fails', () => {
  let templatePath = '';
  expect(() =>
    setupIntegrationDatabase({
      config: { root: process.cwd() },
      onTestsRerun: () => {
        // This test exercises project setup and teardown only.
      },
      provide: (_key, value) => {
        templatePath = value;
        throw new Error('Project setup failed');
      },
    })
  ).toThrow('Project setup failed');
  expect(templatePath).not.toBe('');
  expect(existsSync(templatePath)).toBe(false);
});

it('removes its private directory and runtime client when connecting fails', async () => {
  let databasePath: string | undefined;
  vi.spyOn(TunedPrismaBetterSqlite3.prototype, 'connect').mockImplementationOnce(() => {
    databasePath = process.env.DATABASE_PATH;
    return Promise.reject(new Error('Connection failed'));
  });
  await expect(createIntegrationDatabase()).rejects.toThrow('Connection failed');
  expect(databasePath).toBeTypeOf('string');
  if (!databasePath) {
    throw new Error('Database path was not configured');
  }
  expect(existsSync(dirname(databasePath))).toBe(false);
  expect(globalThis.prismaGlobal).toBeUndefined();
});

it('restores the active client and environment when a second creation fails', async () => {
  const first = await createIntegrationDatabase();
  databases.push(first);
  vi.stubEnv('BASE_DIR', first.tempDir);
  vi.spyOn(TunedPrismaBetterSqlite3.prototype, 'connect').mockRejectedValueOnce(
    new Error('Second connection failed')
  );

  await expect(createIntegrationDatabase()).rejects.toThrow('Second connection failed');
  expect(globalThis.prismaGlobal === first.prisma).toBe(true);
  expect(process.env.DATABASE_PATH).toBe(first.databasePath);
  expect(process.env.BASE_DIR).toBe(first.tempDir);
  const runtime = await vi.importActual<typeof import('@/backend/db')>('@/backend/db');
  expect(runtime.prisma).toBe(first.prisma);
  expect(runtime.getCurrentDatabasePath()).toBe(first.databasePath);
  expect(await runtime.prisma.project.count()).toBe(0);
}, 30_000);
