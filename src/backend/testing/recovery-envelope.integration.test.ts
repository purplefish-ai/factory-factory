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
import workspaceJson from '@/shared/testing/recovery-base-json-workspace-v8.fixture.json';
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
  if (raw.meta.schemaVersion === 7) {
    await destination.prisma.codexAccount.create({
      data: { id: 'account', label: 'Local login', kind: 'MANAGED', enabled: false },
    });
  }
  const result = await Reflect.apply(dataBackupService.importData, dataBackupService, [raw]);
  expect(result.projects).toEqual({ imported: 1, skipped: 0 });
  expect(result.workspaces).toEqual({ imported: 3, skipped: 0 });
  expect(result.agentSessions).toEqual({ imported: 1, skipped: 0 });
  expect(result.terminalSessions).toEqual({ imported: 1, skipped: 0 });
  expect(result.userSettings).toEqual({ imported: false, skipped: false });
  expect(await destination.prisma.project.count()).toBe(1);
  expect(await destination.prisma.workspace.count()).toBe(3);
  expect(
    await destination.prisma
      .$queryRaw`SELECT id, typeof("creationMetadata") AS storage, json_type("creationMetadata") AS kind FROM "Workspace" ORDER BY id`
  ).toEqual([
    { id: 'child', storage: 'null', kind: null },
    { id: 'healthy', storage: 'null', kind: null },
    { id: 'root', storage: 'null', kind: null },
  ]);
  expect(
    await destination.prisma.agentSession.findUniqueOrThrow({ where: { id: 'session' } })
  ).toMatchObject({ status: 'COMPLETED', providerProcessPid: null });
  if (raw.meta.schemaVersion === 4 || raw.meta.schemaVersion === 5) {
    // Independent historical semantics: v4 synthesizes identity; v5 preserves nested PR identity.
    const prId = raw.meta.schemaVersion === 4 ? 'legacy-pr-root' : 'pr-root';
    expect(
      await destination.prisma.workspacePR.findUniqueOrThrow({ where: { id: prId } })
    ).toMatchObject({
      workspaceId: 'root',
      url: 'https://github.com/o/r/pull/1',
      number: 1,
      state: 'OPEN',
      revision: 0,
    });
    expect(
      await destination.prisma.agentSession.findUniqueOrThrow({ where: { id: 'session' } })
    ).toMatchObject({
      workspaceId: 'root',
      workspacePrId: prId,
      providerSessionId: 'history',
      workflow: 'ratchet',
      codexAccountId: null,
    });
    expect(
      await destination.prisma.workspacePRMonitoring.findUniqueOrThrow({
        where: { workspaceId: 'root' },
      })
    ).toMatchObject({
      enabled: false,
      recipientSessionId: null,
      deliveryMode: 'MAIN',
      eventEpoch: 1,
      deliveryPauseReason: 'LEGACY_FIXER',
      legacySessionIds: ['session'],
    });
    expect(await destination.prisma.workspacePREvent.count()).toBe(0);
  }
  if (raw.meta.schemaVersion === 7) {
    const session = await destination.prisma.agentSession.findUniqueOrThrow({
      where: { id: 'session' },
      include: { codexAccount: true },
    });
    expect(session.codexAccountId).not.toBe('account');
    expect(session.codexAccountId).toMatch(/^imported-codex-/);
    expect(session.codexAccount).toMatchObject({
      label: 'Imported account',
      kind: 'MANAGED',
      identityKey: null,
    });
    expect(
      await destination.prisma.codexAccount.findUniqueOrThrow({ where: { id: 'account' } })
    ).toMatchObject({ label: 'Local login', enabled: false });
  }
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
  if (raw.meta.schemaVersion === 7) {
    expect(await destination.prisma.codexAccount.count()).toBe(3);
  }
});
it('exports only the existing serialized base data plus v8 coverage, then restores into another SQLite database', async () => {
  database.prisma = source.prisma;
  await Reflect.apply(dataBackupService.importData, dataBackupService, [v7]);
  const exported = await dataBackupService.exportData('test');
  expect(exported.meta.schemaVersion).toBe(8);
  expect(exported.meta).toHaveProperty('recovery', workspaceJson.meta.recovery);
  expect(exported.data).toHaveProperty('recovery', { baseJson: { version: 1, jsonStorage: [] } });
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
