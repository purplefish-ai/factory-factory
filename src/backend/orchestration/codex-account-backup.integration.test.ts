import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  clearIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import type { PrismaClient } from '@prisma-gen/client';
import { dataBackupService } from './data-backup.service';
const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!state.prisma) {
      throw new Error('Missing database');
    }
    return state.prisma;
  },
}));
let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
}, 30_000);
afterAll(async () => destroyIntegrationDatabase(db));
beforeEach(async () => {
  await clearIntegrationDatabase(db.prisma);
  await db.prisma.project.create({
    data: { id: 'p', name: 'P', slug: 'p', repoPath: '/tmp/p', worktreeBasePath: '/tmp/w' },
  });
  await db.prisma.workspace.create({ data: { id: 'w', projectId: 'p', name: 'W' } });
  await db.prisma.codexAccount.create({
    data: { id: 'managed-b', label: 'Work', kind: 'MANAGED', identityKey: 'a'.repeat(64) },
  });
  await db.prisma.codexAccount.upsert({
    where: { id: 'codex-native-default' },
    update: {},
    create: { id: 'codex-native-default', label: 'Native default', kind: 'NATIVE_DEFAULT' },
  });
  for (const [id, codexAccountId] of [
    ['managed-chat', 'managed-b'],
    ['native-chat', 'codex-native-default'],
  ]) {
    await db.prisma.agentSession.create({
      data: {
        id,
        workspaceId: 'w',
        workflow: 'followup',
        provider: 'CODEX',
        model: 'default',
        codexAccountId,
      },
    });
  }
});
it('roundtrips managed bindings into a fresh database and isolates imported native homes', async () => {
  const exported = exportDataSchema.parse(await dataBackupService.exportData('test'));
  expect(exported.meta.schemaVersion).toBe(7);
  expect(exported.data.codexAccounts).toHaveLength(2);
  await clearIntegrationDatabase(db.prisma);
  await dataBackupService.importData(exported);
  expect(await db.prisma.agentSession.findUnique({ where: { id: 'managed-chat' } })).toMatchObject({
    codexAccountId: 'managed-b',
  });
  const native = await db.prisma.agentSession.findUniqueOrThrow({ where: { id: 'native-chat' } });
  expect(native.codexAccountId).not.toBe('codex-native-default');
  expect(
    await db.prisma.codexAccount.findUnique({ where: { id: native.codexAccountId! } })
  ).toMatchObject({ kind: 'MANAGED', identityKey: null });
  expect(await db.prisma.codexAccount.count()).toBe(3);
});
it('repeatedly roundtrips an imported native fallback identity with one import suffix', async () => {
  await db.prisma.codexAccount.update({
    where: { id: 'codex-native-default' },
    data: { identityKey: `native-email:${'b'.repeat(64)}` },
  });
  let backup = exportDataSchema.parse(await dataBackupService.exportData('test'));
  for (let round = 0; round < 3; round += 1) {
    await clearIntegrationDatabase(db.prisma);
    await dataBackupService.importData(backup);
    backup = exportDataSchema.parse(await dataBackupService.exportData('test'));
    const session = backup.data.agentSessions.find((row) => row.id === 'native-chat');
    const account = backup.data.codexAccounts.find((row) => row.id === session?.codexAccountId);
    expect(account?.kind).toBe('MANAGED');
    expect(account?.identityKey).toMatch(/^native-email:b{64}:imported:[A-Za-z0-9_-]+$/);
    expect(account?.identityKey?.match(/:imported:/g)).toHaveLength(1);
  }
});

it('imports published version 6 without account fields as legacy native bindings', async () => {
  const exported = await dataBackupService.exportData('test');
  const { codexAccounts: _accounts, ...historicalData } = exported.data;
  const historical = {
    ...exported,
    meta: { ...exported.meta, schemaVersion: 6 },
    data: {
      ...historicalData,
      agentSessions: exported.data.agentSessions.map(({ codexAccountId: _account, ...row }) => row),
    },
  };
  const normalized = exportDataSchema.parse(historical);
  expect(normalized.meta.schemaVersion).toBe(6);
  expect(normalized.data.codexAccounts).toEqual([]);
  expect(normalized.data.agentSessions.every((row) => row.codexAccountId === null)).toBe(true);
  await clearIntegrationDatabase(db.prisma);
  await dataBackupService.importData(normalized);
  expect(await db.prisma.agentSession.findMany({ orderBy: { id: 'asc' } })).toEqual([
    expect.objectContaining({ id: 'managed-chat', codexAccountId: null }),
    expect.objectContaining({ id: 'native-chat', codexAccountId: null }),
  ]);
});

it.each([6, 7])(
  'rejects missing account metadata even when an account-bearing backup claims version %s',
  async (schemaVersion) => {
    const exported = await dataBackupService.exportData('test');
    const invalid = {
      ...exported,
      meta: { ...exported.meta, schemaVersion },
      data: { ...exported.data, codexAccounts: [] },
    };
    expect(exportDataSchema.safeParse(invalid).success).toBe(false);
    await expect(dataBackupService.importData(invalid as typeof exported)).rejects.toThrow(
      /account metadata/
    );
    expect(await db.prisma.codexAccount.count()).toBe(2);
  }
);
