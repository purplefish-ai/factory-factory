import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { expectBackupWriterUnopened } from '@/backend/services/settings/resources/backup-writer.test-support';
import { adminRouter } from '@/backend/trpc/admin.trpc';
import type { Context } from '@/backend/trpc/trpc';
import fixed from '@/shared/testing/recovery-base-json-workspace-v8.fixture.json';
import { malformedWorkspaceJsonCases } from '@/shared/testing/recovery-json-storage.fixture';
import { Prisma, type PrismaClient } from '@prisma-gen/client';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  clearIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';
const state = vi.hoisted(() => ({
  prisma: undefined as PrismaClient | undefined,
  beforeAccounts: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('@/backend/db', () => ({
  get prisma() {
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
let source: IntegrationDatabase;
let destination: IntegrationDatabase;
beforeAll(async () => {
  source = await createIntegrationDatabase();
  destination = await createIntegrationDatabase();
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(source);
  await destroyIntegrationDatabase(destination);
});
beforeEach(async () => {
  await clearIntegrationDatabase(source.prisma);
  await clearIntegrationDatabase(destination.prisma);
  state.prisma = destination.prisma;
});
const physical = (prisma: PrismaClient) =>
  prisma.$queryRaw`SELECT id, typeof("creationMetadata") AS storage, json_type("creationMetadata") AS kind FROM "Workspace" ORDER BY id`;
it('roundtrips physical SQL NULL, JSON null and structured values through the public service', async () => {
  state.prisma = source.prisma;
  await source.prisma.project.create({
    data: { id: 'p', name: 'P', slug: 'p', repoPath: '/tmp/p', worktreeBasePath: '/tmp/w' },
  });
  const values = [
    Prisma.DbNull,
    Prisma.JsonNull,
    { nested: null },
    [null, 3],
    'text',
    7,
    false,
    Prisma.JsonNull,
    Prisma.JsonNull,
  ];
  const ids = [
    'sql',
    'json|reserved',
    '__proto__',
    'a|b',
    'string',
    'number',
    'boolean',
    'constructor',
    '',
  ];
  for (let i = 0; i < values.length; i++) {
    await source.prisma.workspace.create({
      data: { id: ids[i]!, projectId: 'p', name: `W${i}`, creationMetadata: values[i]! },
    });
  }
  // URLs are unique within a workspace, but may legitimately repeat across workspaces.
  for (const workspaceId of ['sql', '']) {
    await source.prisma.workspacePR.create({
      data: { workspaceId, url: 'https://github.com/o/r/pull/1', number: 1, state: 'OPEN' },
    });
  }
  const before = await physical(source.prisma);
  expect(before).toEqual(
    expect.arrayContaining([
      { id: 'sql', storage: 'null', kind: null },
      { id: '', storage: 'text', kind: 'null' },
      { id: '__proto__', storage: 'text', kind: 'object' },
    ])
  );
  const backup = await dataBackupService.exportData('test');
  expect(backup.data).toHaveProperty('recovery.baseJson', {
    version: 1,
    jsonStorage: ['', 'constructor', 'json|reserved'].map((id) => ({
      model: 'Workspace',
      identity: [id],
      field: 'creationMetadata',
    })),
  });
  state.prisma = destination.prisma;
  const result = await dataBackupService.importData(backup);
  expect(result.workspaces).toEqual({ imported: 9, skipped: 0 });
  expect(await physical(destination.prisma)).toEqual(before);
  expect(
    await destination.prisma.workspacePR.count({ where: { url: 'https://github.com/o/r/pull/1' } })
  ).toBe(2);
  for (const id of ids) {
    expect(
      (await destination.prisma.workspace.findUniqueOrThrow({ where: { id } })).creationMetadata
    ).toEqual(
      (await source.prisma.workspace.findUniqueOrThrow({ where: { id } })).creationMetadata
    );
  }
});
it.each(malformedWorkspaceJsonCases)(
  'rejects %s at public service and router before opening writer',
  async (_name, mutate) => {
    const file = structuredClone(fixed);
    mutate(file);
    await expectBackupWriterUnopened(async () => {
      await expect(
        Reflect.apply(dataBackupService.importData, dataBackupService, [file])
      ).rejects.toBeInstanceOf(ZodError);
      const caller = adminRouter.createCaller({
        appContext: { services: { dataBackupService } },
      } as unknown as Context);
      await expect(Reflect.apply(caller.importData, caller, [file])).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });
    expect(await destination.prisma.workspace.count()).toBe(0);
  }
);
it('declares an empty section for all SQL NULL rows and restores explicit SQL NULL', async () => {
  state.prisma = source.prisma;
  await source.prisma.project.create({
    data: { id: 'p', name: 'P', slug: 'p', repoPath: '/tmp/p', worktreeBasePath: '/tmp/w' },
  });
  await source.prisma.workspace.create({
    data: { id: 'sql', projectId: 'p', name: 'SQL', creationMetadata: Prisma.DbNull },
  });
  const backup = await dataBackupService.exportData('test');
  expect(backup.meta).toHaveProperty('recovery.capabilities', { baseJson: 1 });
  expect(backup.data).toHaveProperty('recovery.baseJson', { version: 1, jsonStorage: [] });
  state.prisma = destination.prisma;
  await dataBackupService.importData(backup);
  expect(await physical(destination.prisma)).toEqual([{ id: 'sql', storage: 'null', kind: null }]);
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it('captures rows and markers from the same readonly snapshot across an application commit', async () => {
  state.prisma = source.prisma;
  await source.prisma.project.create({
    data: { id: 'p', name: 'P', slug: 'p', repoPath: '/tmp/p', worktreeBasePath: '/tmp/w' },
  });
  await source.prisma.workspace.create({
    data: { id: 'sql', projectId: 'p', name: 'SQL', creationMetadata: Prisma.DbNull },
  });
  const reached = deferred();
  const committed = deferred();
  state.beforeAccounts = async () => {
    reached.resolve();
    await committed.promise;
  };
  const pending = dataBackupService.exportData('test');
  try {
    await reached.promise;
    await source.prisma.workspace.update({
      where: { id: 'sql' },
      data: { creationMetadata: Prisma.JsonNull },
    });
  } finally {
    committed.resolve();
    state.beforeAccounts = undefined;
  }
  const backup = await pending;
  expect(backup.data.workspaces[0]?.creationMetadata).toBeNull();
  expect(backup.data).toHaveProperty('recovery.baseJson.jsonStorage', []);
  expect(await physical(source.prisma)).toEqual([{ id: 'sql', storage: 'text', kind: 'null' }]);
  state.prisma = destination.prisma;
  await dataBackupService.importData(backup);
  expect(await physical(destination.prisma)).toEqual([{ id: 'sql', storage: 'null', kind: null }]);
});
it('leaves collision storage untouched, imports unrelated marked rows and reports actual repeated skips', async () => {
  await destination.prisma.project.create({
    data: {
      id: 'local',
      name: 'Local',
      slug: 'local',
      repoPath: '/local',
      worktreeBasePath: '/local/w',
    },
  });
  await destination.prisma.workspace.create({
    data: {
      id: 'root',
      projectId: 'local',
      name: 'Local workspace',
      creationMetadata: { local: null },
    },
  });
  const file = structuredClone(fixed);
  file.data.recovery.baseJson.jsonStorage.push({
    model: 'Workspace',
    identity: ['healthy'],
    field: 'creationMetadata',
  });
  const localBefore = await destination.prisma.workspace.findUniqueOrThrow({
    where: { id: 'root' },
  });
  const result = await Reflect.apply(dataBackupService.importData, dataBackupService, [file]);
  expect(result.workspaces).toEqual({ imported: 1, skipped: 2 });
  expect(await destination.prisma.workspace.findUniqueOrThrow({ where: { id: 'root' } })).toEqual(
    localBefore
  );
  expect(await physical(destination.prisma)).toEqual([
    { id: 'healthy', storage: 'text', kind: 'null' },
    { id: 'root', storage: 'text', kind: 'object' },
  ]);
  expect(result.recovery.unreportedTotals).toBe('EMBEDDED_ROWS_AND_ACCOUNT_MAPPINGS');
  const repeated = await Reflect.apply(dataBackupService.importData, dataBackupService, [file]);
  expect(repeated.workspaces).toEqual({ imported: 0, skipped: 3 });
});
it('rolls back marked workspace writes when a later insert fails', async () => {
  await destination.prisma.$executeRawUnsafe(
    "CREATE TRIGGER fail_terminal BEFORE INSERT ON TerminalSession BEGIN SELECT RAISE(ABORT, 'late write'); END"
  );
  try {
    await expect(
      Reflect.apply(dataBackupService.importData, dataBackupService, [fixed])
    ).rejects.toThrow(/terminalSession.create/);
    expect(await destination.prisma.project.count()).toBe(0);
    expect(await destination.prisma.workspace.count()).toBe(0);
    expect(await destination.prisma.agentSession.count()).toBe(0);
  } finally {
    await destination.prisma.$executeRawUnsafe('DROP TRIGGER fail_terminal');
  }
});
