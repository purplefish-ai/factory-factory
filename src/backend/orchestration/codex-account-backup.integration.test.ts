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
it.each([6, 7])(
  'rejects incomplete account metadata in version %s before import',
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
