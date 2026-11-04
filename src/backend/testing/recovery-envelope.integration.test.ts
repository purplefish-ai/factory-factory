import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { exportDataSchema, type ExportData } from '@/shared/schemas/export-data.schema';
import definitions from '@/shared/testing/recovery-automation-definitions-v8.fixture.json';
import fullJson from '@/shared/testing/recovery-base-json-v8.fixture.json';
import workspaceJson from '@/shared/testing/recovery-base-json-workspace-v8.fixture.json';
import fixed from '@/shared/testing/recovery-base-v8.fixture.json';
import { malformedRecoveryCases } from '@/shared/testing/recovery-envelope.fixture';
import periodicConfig from '@/shared/testing/recovery-periodic-config-v8.fixture.json';
import periodicHistory from '@/shared/testing/recovery-periodic-history-v8.fixture.json';
import periodicLinks from '@/shared/testing/recovery-periodic-links-v8.fixture.json';
import slack from '@/shared/testing/recovery-slack-connections-v8.fixture.json';
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
it('roundtrips the complete base graph with explicit null task links from published v7 through the current profile', async () => {
  database.prisma = source.prisma;
  await Reflect.apply(dataBackupService.importData, dataBackupService, [v7]);
  // Native profiles import as isolated managed copies; keep this exact graph
  // witness limited to fixture accounts, with no unrelated bootstrap login.
  for (const db of [source, destination]) {
    expect(
      await db.prisma.agentSession.count({ where: { codexAccountId: 'codex-native-default' } })
    ).toBe(0);
    await db.prisma.codexAccount.delete({ where: { id: 'codex-native-default' } });
  }
  const exported = await dataBackupService.exportData('test');
  expect(exported.data.projects).toEqual(v7.data.projects);
  expect(exported.data.agentSessions).toEqual(v7.data.agentSessions);
  expect(exported.data.terminalSessions).toEqual(v7.data.terminalSessions);
  expect(exported.data.codexAccounts).toEqual(v7.data.codexAccounts);
  expect(exported.data.userSettings).toEqual(v7.data.userSettings);
  const associations = (
    workspaces: readonly {
      id: string;
      projectId: string;
      parentWorkspaceId: string | null;
      prs: readonly { id: string; url: string; number: number | null }[];
    }[]
  ) =>
    workspaces
      .map(({ id, projectId, parentWorkspaceId, prs }) => ({
        id,
        projectId,
        parentWorkspaceId,
        prs: prs.map(({ id, url, number }) => ({ id, url, number })),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  expect(associations(exported.data.workspaces)).toEqual(associations(v7.data.workspaces));
  expect(exported.meta.schemaVersion).toBe(8);
  expect(exported.meta).toHaveProperty('recovery', slack.meta.recovery);
  expect(exported.data).toHaveProperty('recovery', {
    baseJson: { version: 1, jsonStorage: [] },
    periodicConfig: { version: 1, tasks: [] },
    periodicHistory: { version: 1, executions: [], jsonStorage: [] },
    automationDefinitions: { version: 1, definitions: [] },
    slackConnections: { version: 1, connections: [] },
  });
  expect(exportDataSchema.parse(exported)).toEqual(exported);
  const expectedLinks = v7.data.workspaces
    .map(({ id }) => ({ id, periodicTaskId: null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  expect(
    exported.data.workspaces
      .map((workspace) => ({
        id: workspace.id,
        periodicTaskId: 'periodicTaskId' in workspace ? workspace.periodicTaskId : undefined,
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  ).toEqual(expectedLinks);
  database.prisma = destination.prisma;
  const result = await dataBackupService.importData(exported);
  expect(result.workspaces.imported).toBe(3);
  expect(await destination.prisma.workspace.count()).toBe(3);
  expect(
    await destination.prisma.workspace.findMany({
      select: { id: true, periodicTaskId: true },
      orderBy: { id: 'asc' },
    })
  ).toEqual(expectedLinks);
  const baseGraph = (data: ExportData['data']) => {
    if (!('recovery' in data)) {
      throw new Error('Expected current recovery export');
    }
    const { recovery: _recovery, ...base } = data;
    // All fixture timestamps tie, so compare workspace identities in stable order.
    return { ...base, workspaces: [...base.workspaces].sort((a, b) => a.id.localeCompare(b.id)) };
  };
  const roundtripped = await dataBackupService.exportData('destination-roundtrip');
  expect(baseGraph(roundtripped.data)).toEqual(baseGraph(exported.data));
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

it('imports the frozen workspace-only profile with historical PR/session null normalization', async () => {
  const result = await Reflect.apply(dataBackupService.importData, dataBackupService, [
    workspaceJson,
  ]);
  expect(result.workspaces).toEqual({ imported: 3, skipped: 0 });
  expect(result.agentSessions).toEqual({ imported: 1, skipped: 0 });
  expect(result.recovery.manifest).toEqual(workspaceJson.meta.recovery);
  expect(
    await destination.prisma
      .$queryRaw`SELECT typeof("creationMetadata") AS storage, json_type("creationMetadata") AS kind FROM "Workspace" WHERE id = 'root'`
  ).toEqual([{ storage: 'text', kind: 'null' }]);
  expect(
    await destination.prisma
      .$queryRaw`SELECT typeof("observation") AS storage, json_type("observation") AS kind FROM "WorkspacePR" WHERE id = 'pr-root'`
  ).toEqual([{ storage: 'null', kind: null }]);
  expect(
    await destination.prisma
      .$queryRaw`SELECT typeof("providerMetadata") AS storage, json_type("providerMetadata") AS kind FROM "AgentSession" WHERE id = 'session'`
  ).toEqual([{ storage: 'null', kind: null }]);
});

describe('cold profile recovery imports', () => {
  let ownedDatabase: IntegrationDatabase | undefined;
  beforeEach(async () => {
    ownedDatabase = await createIntegrationDatabase();
    database.prisma = ownedDatabase.prisma;
  }, 30_000);
  afterEach(async () => {
    database.prisma = destination.prisma;
    const owned = ownedDatabase;
    ownedDatabase = undefined;
    if (owned) {
      await destroyIntegrationDatabase(owned);
    }
  }, 30_000);
  it.each([
    fixed,
    workspaceJson,
    fullJson,
    periodicConfig,
    periodicLinks,
    periodicHistory,
    definitions,
    slack,
  ])(
    'imports genuine $meta.recovery.profile with its exact manifest and definition authority',
    async (raw) => {
      const isolated = ownedDatabase!;
      const result = await Reflect.apply(dataBackupService.importData, dataBackupService, [raw]);
      expect(raw.data.projects.length).toBeGreaterThan(0);
      expect(result.projects).toEqual({ imported: raw.data.projects.length, skipped: 0 });
      expect(result.workspaces).toEqual({ imported: raw.data.workspaces.length, skipped: 0 });
      expect(result.agentSessions).toEqual({ imported: raw.data.agentSessions.length, skipped: 0 });
      expect(result.terminalSessions).toEqual({
        imported: raw.data.terminalSessions.length,
        skipped: 0,
      });
      expect(await isolated.prisma.project.count()).toBe(raw.data.projects.length);
      expect(await isolated.prisma.workspace.count()).toBe(raw.data.workspaces.length);
      expect(result.recovery.manifest).toEqual(raw.meta.recovery);
      if (raw === slack) {
        expect(result.recovery.slackConnections).toEqual({
          model: 'AgentConnection',
          imported: 2,
          skipped: 0,
          sourceEnabled: 1,
          restoredDisabled: 2,
          reasons: { EXISTING_IDENTITY: 0 },
        });
        expect(
          await isolated.prisma.agentConnection.findMany({ orderBy: { id: 'asc' } })
        ).toMatchObject([
          { id: 'slack-recovered-disabled', isEnabled: false, credentialsEncrypted: null },
          { id: 'slack-recovered-enabled', isEnabled: false, credentialsEncrypted: null },
        ]);
      } else {
        expect(result.recovery).not.toHaveProperty('slackConnections');
        expect(await isolated.prisma.agentConnection.count()).toBe(0);
      }
      if (raw === definitions || raw === slack) {
        expect(result.recovery.automationDefinitions).toEqual({
          model: 'AgentDefinition',
          imported: 1,
          skipped: 0,
          sourceEnabled: 1,
          restoredDisabled: 1,
          reasons: { EXISTING_IDENTITY: 0, INCOMPLETE_DEPENDENCY: 0 },
        });
        expect(await isolated.prisma.agentDefinition.findMany()).toMatchObject([
          {
            id: 'body-definition',
            isEnabled: false,
            instructions:
              definitions.data.recovery.automationDefinitions.definitions[0]!.instructions,
          },
        ]);
      } else {
        expect(result.recovery).not.toHaveProperty('automationDefinitions');
        expect(await isolated.prisma.agentDefinition.count()).toBe(0);
      }
    }
  );
});
