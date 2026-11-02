import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { TunedPrismaBetterSqlite3 } from '@/backend/lib/sqlite-adapter';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { PrismaClient } from '@prisma-gen/client';

const state = vi.hoisted(() => ({
  prisma: undefined as unknown,
  onProjectRead: undefined as
    | ((tryReaderWrite: () => Promise<unknown>) => Promise<void>)
    | undefined,
}));
vi.mock('@prisma/adapter-better-sqlite3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisma/adapter-better-sqlite3')>();
  return {
    ...actual,
    PrismaBetterSqlite3: class extends actual.PrismaBetterSqlite3 {
      override async connect() {
        const adapter = await super.connect();
        const instrument = (target: Pick<typeof adapter, 'queryRaw' | 'executeRaw'>) => {
          const queryRaw = target.queryRaw.bind(target);
          target.queryRaw = async (query) => {
            const result = await queryRaw(query);
            if (query.sql.trimStart().startsWith('SELECT') && query.sql.includes('Project')) {
              await state.onProjectRead?.(() =>
                target.executeRaw({
                  sql: 'UPDATE "Project" SET "name" = "name"',
                  args: [],
                  argTypes: [],
                })
              );
            }
            return result;
          };
        };
        instrument(adapter);
        const startTransaction = adapter.startTransaction.bind(adapter);
        adapter.startTransaction = async (isolation) => {
          const tx = await startTransaction(isolation);
          instrument(tx);
          return tx;
        };
        return adapter;
      }
    },
  };
});
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!state.prisma) {
      throw new Error('Missing snapshot test database');
    }
    return state.prisma;
  },
}));
let db: IntegrationDatabase;
let writer: PrismaClient;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  writer = new PrismaClient({ adapter: new TunedPrismaBetterSqlite3({ url: db.databasePath }) });
  await writer.$connect();
}, 30_000);
afterAll(async () => {
  if (writer) {
    await writer.$disconnect();
  }
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});

it('exports one relational snapshot even when another connection commits during its reads', async () => {
  state.prisma = db.prisma;
  let injected = false;
  state.onProjectRead = async () => {
    if (injected) {
      return;
    }
    injected = true;
    await writer.project.create({
      data: {
        id: 'concurrent',
        name: 'Concurrent',
        slug: 'concurrent',
        repoPath: '/repo',
        worktreeBasePath: '/trees',
        workspaces: { create: { id: 'concurrent-workspace', name: 'Concurrent workspace' } },
      },
    });
    await writer.codexAccount.create({
      data: { id: 'concurrent-account', label: 'Concurrent account', kind: 'MANAGED' },
    });
  };
  const backup = await dataBackupService.exportData('test');
  state.onProjectRead = undefined;
  expect(injected).toBe(true);
  expect(await writer.project.count({ where: { id: 'concurrent' } })).toBe(1);
  expect(backup.data.projects.some((row) => row.id === 'concurrent')).toBe(false);
  expect(backup.data.workspaces.some((row) => row.id === 'concurrent-workspace')).toBe(false);
  expect(backup.data.codexAccounts.some((row) => row.id === 'concurrent-account')).toBe(false);
});

it('excludes ordinary writes on the same Prisma client from its relational snapshot', async () => {
  state.prisma = db.prisma;
  let injected = false;
  state.onProjectRead = async () => {
    if (injected) {
      return;
    }
    injected = true;
    await db.prisma.project.create({
      data: {
        id: 'same-client-project',
        name: 'Same client',
        slug: 'same-client',
        repoPath: '/same-client',
        worktreeBasePath: '/same-client-trees',
      },
    });
    await db.prisma.agentDefinition.create({
      data: {
        id: 'same-client-definition',
        projectId: 'same-client-project',
        name: 'Concurrent definition',
        instructions: 'Retain this accepted write',
      },
    });
  };
  const backup = await dataBackupService.exportData('test');
  state.onProjectRead = undefined;
  expect(injected).toBe(true);
  expect(await db.prisma.agentDefinition.count({ where: { id: 'same-client-definition' } })).toBe(
    1
  );
  expect(backup.data.projects.some((row) => row.id === 'same-client-project')).toBe(false);
  expect(
    backup.data.durable!.agentDefinition.some((row) => row.id === 'same-client-definition')
  ).toBe(false);
});

it('never rolls back an accepted ordinary write when the export read later fails', async () => {
  state.prisma = db.prisma;
  let injected = false;
  state.onProjectRead = async () => {
    if (injected) {
      return;
    }
    injected = true;
    await db.prisma.project.create({
      data: {
        id: 'accepted-during-failure',
        name: 'Keep accepted',
        slug: 'accepted-during-failure',
        repoPath: '/accepted',
        worktreeBasePath: '/accepted-trees',
      },
    });
    throw new Error('Injected snapshot read failure');
  };
  await expect(dataBackupService.exportData('test')).rejects.toThrow(
    'Injected snapshot read failure'
  );
  state.onProjectRead = undefined;
  expect(injected).toBe(true);
  expect(await db.prisma.project.count({ where: { id: 'accepted-during-failure' } })).toBe(1);
});

it('enforces a physically read-only snapshot connection', async () => {
  state.prisma = db.prisma;
  let checked = false;
  state.onProjectRead = async (tryReaderWrite) => {
    if (checked) {
      return;
    }
    checked = true;
    await expect(tryReaderWrite()).rejects.toThrow(/read.?only/i);
  };
  await dataBackupService.exportData('test');
  state.onProjectRead = undefined;
  expect(checked).toBe(true);
});
