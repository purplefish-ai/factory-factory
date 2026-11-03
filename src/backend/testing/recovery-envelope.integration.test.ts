import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { expectBackupWriterUnopened } from '@/backend/services/settings/resources/backup-writer.test-support';
import v6 from '@/backend/testing/fixtures/published-v6.json';
import v7 from '@/backend/testing/fixtures/published-v7.json';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import {
  publishedVersion4Backup,
  publishedVersion5Backup,
} from '@/backend/testing/legacy-backup.fixture';
import { adminRouter } from '@/backend/trpc/admin.trpc';
import type { Context } from '@/backend/trpc/trpc';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import fixed from '@/shared/testing/recovery-base-v8.fixture.json';
import { malformedRecoveryCases } from '@/shared/testing/recovery-envelope.fixture';
import type { PrismaClient } from '@prisma-gen/client';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return database.prisma;
  },
}));
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
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await clearIntegrationDatabase(source.prisma);
  await clearIntegrationDatabase(destination.prisma);
  database.prisma = destination.prisma;
});
it.each([
  ['published v4', publishedVersion4Backup(), 6],
  ['published v5', publishedVersion5Backup(), 6],
  ['published v6 c2c6cce6a', v6, 6],
  ['published v7 b41137176', v7, 7],
  ['frozen base-1 v8', fixed, 8],
])('imports raw %s and reports actual repeated skips', async (_name, raw, normalizedVersion) => {
  expect(exportDataSchema.parse(raw).meta.schemaVersion).toBe(normalizedVersion);
  const result = await Reflect.apply(dataBackupService.importData, dataBackupService, [raw]);
  expect(result.projects).toEqual({ imported: 1, skipped: 0 });
  expect(result.workspaces).toEqual({ imported: 3, skipped: 0 });
  expect(result.agentSessions).toEqual({ imported: 1, skipped: 0 });
  expect(result.terminalSessions).toEqual({ imported: 1, skipped: 0 });
  expect(result.userSettings).toEqual({ imported: false, skipped: false });
  expect(await destination.prisma.project.count()).toBe(1);
  expect(await destination.prisma.workspace.count()).toBe(3);
  expect(
    await destination.prisma.agentSession.findUniqueOrThrow({ where: { id: 'session' } })
  ).toMatchObject({ status: 'COMPLETED', providerProcessPid: null });
  expect(await destination.prisma.workspacePRMonitoring.findFirstOrThrow()).toMatchObject({
    enabled: false,
  });
  expect(result.recovery).toMatchObject({
    status: 'PARTIAL',
    unreportedTotals: 'EMBEDDED_ROWS_AND_ACCOUNT_MAPPINGS',
    manifest: normalizedVersion === 8 ? fixed.meta.recovery : null,
  });
  const repeated = await Reflect.apply(dataBackupService.importData, dataBackupService, [raw]);
  expect(repeated.projects).toEqual({ imported: 0, skipped: 1 });
  expect(repeated.workspaces).toEqual({ imported: 0, skipped: 3 });
  expect(repeated.agentSessions).toEqual({ imported: 0, skipped: 1 });
  expect(repeated.terminalSessions).toEqual({ imported: 0, skipped: 1 });
});
it('exports only the existing serialized base data plus v8 coverage, then restores into another SQLite database', async () => {
  database.prisma = source.prisma;
  await Reflect.apply(dataBackupService.importData, dataBackupService, [v7]);
  const exported = await dataBackupService.exportData('test');
  expect(exported.meta.schemaVersion).toBe(8);
  expect(exported.meta).toHaveProperty('recovery', fixed.meta.recovery);
  expect(exported.data).toHaveProperty('recovery', {});
  const legacy = exportDataSchema.parse({
    ...exported,
    meta: { ...exported.meta, schemaVersion: 7 },
  });
  const { recovery: _sections, ...base } = exported.data as typeof exported.data & {
    recovery: unknown;
  };
  expect(base).toEqual(legacy.data);
  database.prisma = destination.prisma;
  const result = await dataBackupService.importData(exported);
  expect(result.workspaces.imported).toBe(3);
  expect(await destination.prisma.workspace.count()).toBe(3);
});
it.each(malformedRecoveryCases)(
  'rejects %s before service or router opens the writer',
  async (_name, mutate) => {
    const file = structuredClone(fixed);
    mutate(file);
    await expectBackupWriterUnopened(async () => {
      await expect(
        Reflect.apply(dataBackupService.importData, dataBackupService, [file])
      ).rejects.toThrow();
      const caller = adminRouter.createCaller({
        appContext: { services: { dataBackupService } },
      } as unknown as Context);
      await expect(Reflect.apply(caller.importData, caller, [file])).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });
  }
);
it('rolls back a valid v8 import after a late write failure without returning a report', async () => {
  await destination.prisma.$executeRawUnsafe(
    "CREATE TRIGGER fail_terminal BEFORE INSERT ON TerminalSession BEGIN SELECT RAISE(ABORT, 'late write'); END"
  );
  await expect(
    Reflect.apply(dataBackupService.importData, dataBackupService, [fixed])
  ).rejects.toThrow(/terminalSession.create/);
  expect(await destination.prisma.project.count()).toBe(0);
  expect(await destination.prisma.workspace.count()).toBe(0);
  expect(await destination.prisma.agentSession.count()).toBe(0);
  await destination.prisma.$executeRawUnsafe('DROP TRIGGER fail_terminal');
});
