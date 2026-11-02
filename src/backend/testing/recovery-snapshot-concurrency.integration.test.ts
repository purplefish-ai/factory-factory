import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { TunedPrismaBetterSqlite3 } from '@/backend/lib/sqlite-adapter';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { PrismaClient } from '@prisma-gen/client';

const state = vi.hoisted(() => ({ prisma: undefined as unknown }));
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
  let injected = false;
  state.prisma = db.prisma.$extends({
    query: {
      project: {
        async findMany({ args, query }) {
          const projects = await query(args);
          if (!injected) {
            injected = true;
            await writer.project.create({
              data: {
                id: 'concurrent',
                name: 'Concurrent',
                slug: 'concurrent',
                repoPath: '/repo',
                worktreeBasePath: '/trees',
                workspaces: {
                  create: { id: 'concurrent-workspace', name: 'Concurrent workspace' },
                },
              },
            });
            await writer.codexAccount.create({
              data: { id: 'concurrent-account', label: 'Concurrent account', kind: 'MANAGED' },
            });
          }
          return projects;
        },
      },
    },
  });
  const backup = await dataBackupService.exportData('test');
  expect(injected).toBe(true);
  expect(await writer.project.count({ where: { id: 'concurrent' } })).toBe(1);
  expect(backup.data.projects.some((row) => row.id === 'concurrent')).toBe(false);
  expect(backup.data.workspaces.some((row) => row.id === 'concurrent-workspace')).toBe(false);
  expect(backup.data.codexAccounts.some((row) => row.id === 'concurrent-account')).toBe(false);
});
