import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import { Prisma } from '@prisma-gen/client';
import type { PrismaClient } from '@prisma-gen/client';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';

const state = vi.hoisted(() => ({
  prisma: undefined as PrismaClient | undefined,
  beforeAccounts: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!state.prisma) {
      throw new Error('Missing test database');
    }
    return state.prisma;
  },
}));
vi.mock('@/backend/services/codex-accounts', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/backend/services/codex-accounts')>();
  return {
    ...original,
    exportCodexAccountMetadata: async (tx?: Prisma.TransactionClient) => {
      await state.beforeAccounts?.();
      return original.exportCodexAccountMetadata(tx);
    },
  };
});
import { dataBackupService } from '@/backend/orchestration/data-backup/data-backup.service';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
  await db.prisma.project.create({
    data: { id: 'p', name: 'Before', slug: 'p', repoPath: '/tmp/p', worktreeBasePath: '/tmp/w' },
  });
  await db.prisma.workspace.create({ data: { id: 'w', projectId: 'p', name: 'W' } });
  await db.prisma.periodicTask.create({
    data: {
      id: 'periodic',
      projectId: 'p',
      name: 'Before task',
      prompt: 'Before prompt',
      cadence: 'DAILY',
      scheduledTime: '10:00',
      timezone: 'UTC',
      nextRunAt: new Date('2026-01-01T10:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  await db.prisma.workspace.update({ where: { id: 'w' }, data: { periodicTaskId: 'periodic' } });
  await db.prisma.periodicTaskExecution.create({
    data: {
      id: 'history',
      periodicTaskId: 'periodic',
      status: 'RUNNING',
      launchSnapshot: Prisma.DbNull,
    },
  });
  await db.prisma.codexAccount.create({
    data: { id: 'before-account', label: 'Before account', kind: 'MANAGED' },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 's',
      workspaceId: 'w',
      workflow: 'followup',
      provider: 'CODEX',
      model: 'default',
      codexAccountId: 'before-account',
    },
  });
}, 30_000);
afterAll(async () => destroyIntegrationDatabase(db));

it('exports account metadata and session bindings from one snapshot while the application writer commits', async () => {
  const reachedAccounts = deferred();
  const writerCommitted = deferred();
  state.beforeAccounts = async () => {
    reachedAccounts.resolve();
    await writerCommitted.promise;
  };
  const pendingExport = dataBackupService.exportData('snapshot-test');
  try {
    await reachedAccounts.promise;
    await db.prisma.$transaction(async (tx) => {
      await tx.periodicTaskExecution.update({
        where: { id: 'history' },
        data: {
          status: 'COMPLETED',
          launchSnapshot: Prisma.JsonNull,
          errorMessage: 'Writer committed',
          completedAt: new Date('2026-10-01T00:00:00.000Z'),
        },
      });
      await tx.codexAccount.create({
        data: { id: 'after-account', label: 'After', kind: 'MANAGED' },
      });
      await tx.agentSession.update({
        where: { id: 's' },
        data: { codexAccountId: 'after-account' },
      });
      await tx.codexAccount.delete({ where: { id: 'before-account' } });
      await tx.workspace.update({ where: { id: 'w' }, data: { periodicTaskId: null } });
      await tx.project.update({ where: { id: 'p' }, data: { name: 'After' } });
      await tx.periodicTask.update({
        where: { id: 'periodic' },
        data: {
          prompt: 'After prompt',
          timezone: 'Asia/Tokyo',
          scheduledTime: '22:30',
          nextRunAt: new Date('2026-10-01T13:30:00.000Z'),
          updatedAt: new Date('2026-10-01T00:00:00.000Z'),
        },
      });
    });
  } finally {
    writerCommitted.resolve();
    state.beforeAccounts = undefined;
  }
  const exported = exportDataSchema.parse(await pendingExport);
  expect(exported.meta.schemaVersion).toBe(8);
  expect(exported.data).toHaveProperty('recovery.periodicHistory.executions', [
    expect.objectContaining({
      id: 'history',
      status: 'RUNNING',
      launchSnapshot: null,
      errorMessage: null,
      completedAt: null,
    }),
  ]);
  expect(exported.data).toHaveProperty('recovery.periodicHistory.jsonStorage', []);
  expect(
    await db.prisma.periodicTaskExecution.findUniqueOrThrow({ where: { id: 'history' } })
  ).toMatchObject({ status: 'COMPLETED', errorMessage: 'Writer committed' });
  expect(
    await db.prisma
      .$queryRaw`SELECT json_type(launchSnapshot) AS kind FROM PeriodicTaskExecution WHERE id = 'history'`
  ).toEqual([{ kind: 'null' }]);
  expect(exported.data.projects[0]?.name).toBe('Before');
  expect(exported.data.workspaces[0]).toHaveProperty('periodicTaskId', 'periodic');
  expect(await db.prisma.workspace.findUniqueOrThrow({ where: { id: 'w' } })).toHaveProperty(
    'periodicTaskId',
    null
  );
  expect(exported.data).toHaveProperty('recovery.periodicConfig.tasks', [
    expect.objectContaining({
      id: 'periodic',
      prompt: 'Before prompt',
      timezone: 'UTC',
      scheduledTime: '10:00',
      nextRunAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  ]);
  expect(
    await db.prisma.periodicTask.findUniqueOrThrow({ where: { id: 'periodic' } })
  ).toMatchObject({
    prompt: 'After prompt',
    timezone: 'Asia/Tokyo',
    scheduledTime: '22:30',
    nextRunAt: new Date('2026-10-01T13:30:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  });
  expect(exported.data.agentSessions[0]?.codexAccountId).toBe('before-account');
  expect(exported.data.codexAccounts).toEqual([
    {
      id: 'codex-native-default',
      label: 'Native default',
      kind: 'NATIVE_DEFAULT',
      enabled: true,
      identityKey: null,
    },
    {
      id: 'before-account',
      label: 'Before account',
      kind: 'MANAGED',
      enabled: true,
      identityKey: null,
    },
  ]);
  expect(await db.prisma.agentSession.findUnique({ where: { id: 's' } })).toMatchObject({
    codexAccountId: 'after-account',
  });
});
