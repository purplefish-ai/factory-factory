import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { TunedPrismaBetterSqlite3 } from '@/backend/lib/sqlite-adapter';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import {
  withBackupImport,
  withBackupSnapshot,
} from '@/backend/services/settings/resources/backup-snapshot';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { PrismaClient } from '@prisma-gen/client';

const state = vi.hoisted(() => ({
  prisma: undefined as unknown,
  onProjectWrite: undefined as (() => Promise<void>) | undefined,
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
            if (query.sql.trimStart().startsWith('INSERT') && query.sql.includes('Project')) {
              await state.onProjectWrite?.();
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
afterEach(() => {
  state.onProjectRead = undefined;
  state.onProjectWrite = undefined;
});
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

async function incomingBackup(id: string) {
  state.prisma = db.prisma;
  await db.prisma.project.create({
    data: { id, name: id, slug: id, repoPath: `/${id}`, worktreeBasePath: `/${id}-trees` },
  });
  const backup = await dataBackupService.exportData('test');
  await db.prisma.project.delete({ where: { id } });
  return backup;
}
function createOrdinaryProject(id: string) {
  return db.prisma.project.create({
    data: { id, name: id, slug: id, repoPath: `/${id}`, worktreeBasePath: `/${id}-trees` },
  });
}
it('keeps an accepted ordinary write when the import later fails before its first write', async () => {
  const backup = await incomingBackup('import-read-failure');
  let accepted = false;
  state.onProjectRead = async () => {
    state.onProjectRead = undefined;
    await createOrdinaryProject('accepted-during-import-failure');
    accepted = true;
    throw new Error('Injected import read failure');
  };
  await expect(dataBackupService.importData(backup)).rejects.toThrow(
    'Injected import read failure'
  );
  expect(accepted).toBe(true);
  expect(await db.prisma.project.count({ where: { id: 'accepted-during-import-failure' } })).toBe(
    1
  );
  expect(await db.prisma.project.count({ where: { id: 'import-read-failure' } })).toBe(0);
});
it('rolls back only import rows and rejects a competing ordinary writer while holding the write lock', async () => {
  const backup = await incomingBackup('import-write-failure');
  await db.prisma.$executeRaw`PRAGMA busy_timeout = 0`;
  let checked = false;
  state.onProjectWrite = async () => {
    state.onProjectWrite = undefined;
    checked = true;
    await expect(createOrdinaryProject('rejected-competing-write')).rejects.toMatchObject({
      code: 'P1008',
    });
    throw new Error('Injected import write failure');
  };
  try {
    await expect(dataBackupService.importData(backup)).rejects.toThrow(
      'Injected import write failure'
    );
  } finally {
    await db.prisma.$executeRaw`PRAGMA busy_timeout = 5000`;
  }
  expect(checked).toBe(true);
  expect(await db.prisma.project.count({ where: { id: 'rejected-competing-write' } })).toBe(0);
  expect(await db.prisma.project.count({ where: { id: 'import-write-failure' } })).toBe(0);
});
it('fails closed on a changed import snapshot, preserves the accepted writer and permits explicit retry', async () => {
  const backup = await incomingBackup('import-retry');
  state.onProjectRead = async () => {
    state.onProjectRead = undefined;
    await createOrdinaryProject('accepted-before-import-write');
  };
  await expect(dataBackupService.importData(backup)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await db.prisma.project.count({ where: { id: 'accepted-before-import-write' } })).toBe(1);
  expect(await db.prisma.project.count({ where: { id: 'import-retry' } })).toBe(0);
  await dataBackupService.importData(backup);
  expect(await db.prisma.project.count({ where: { id: 'import-retry' } })).toBe(1);
});

it('preserves production connection pragmas on the private writer and commits its writes', async () => {
  await withBackupImport(db.prisma, async (tx) => {
    await expect(tx.$queryRaw`PRAGMA busy_timeout`).resolves.toEqual([{ timeout: 5000n }]);
    await expect(tx.$queryRaw`PRAGMA journal_mode`).resolves.toEqual([{ journal_mode: 'wal' }]);
    await expect(tx.$queryRaw`PRAGMA synchronous`).resolves.toEqual([{ synchronous: 1n }]);
    await expect(tx.$queryRaw`PRAGMA temp_store`).resolves.toEqual([{ temp_store: 2n }]);
    await expect(tx.$queryRaw`PRAGMA cache_size`).resolves.toEqual([{ cache_size: -65_536n }]);
    await tx.project.create({
      data: {
        id: 'private-writer-committed',
        name: 'Private commit',
        slug: 'private-writer-committed',
        repoPath: '/private',
        worktreeBasePath: '/private-trees',
      },
    });
  });
  expect(await db.prisma.project.count({ where: { id: 'private-writer-committed' } })).toBe(1);
});

it.each([
  { name: 'snapshot', run: withBackupSnapshot },
  { name: 'import', run: withBackupImport },
])(
  'keeps a private $name transaction valid beyond Prisma default five seconds',
  async ({ name, run }) => {
    // The new case intentionally crosses the default interactive timeout; existing test limits stay unchanged.
    const result = await run(db.prisma, async (tx) => {
      const before = await tx.project.count();
      await new Promise((resolve) => setTimeout(resolve, 5500));
      expect(await tx.project.count()).toBe(before);
      if (name === 'import') {
        await tx.project.create({
          data: {
            id: 'long-budget-import',
            name: 'Bounded long import',
            slug: 'long-budget-import',
            repoPath: '/long',
            worktreeBasePath: '/long-trees',
          },
        });
      }
      return before;
    });
    expect(await db.prisma.project.count()).toBe(result + Number(name === 'import'));
    if (name === 'import') {
      expect(
        await db.prisma.project.findUnique({ where: { id: 'long-budget-import' } })
      ).toMatchObject({ name: 'Bounded long import' });
    }
  },
  15_000
);
