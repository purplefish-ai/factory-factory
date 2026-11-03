import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import { sessionLifecycleService } from '@/backend/services/session';
import { terminalService } from '@/backend/services/terminal';
import { exportDataSchema, type ExportData } from '@/shared/schemas/export-data.schema';
import fixed from '@/shared/testing/recovery-base-json-workspace-v8.fixture.json';
import type { PrismaClient } from '@prisma-gen/client';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!state.prisma) {
      throw new Error('Missing database');
    }
    return state.prisma;
  },
}));
import { dataBackupService } from '@/backend/orchestration/data-backup.service';

let db: IntegrationDatabase;
let backup: ExportData;
const project = (id: string) => ({
  id,
  slug: id,
  name: id,
  repoPath: '/p',
  worktreeBasePath: '/w',
});
beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
  await db.prisma.project.create({ data: project('import-project') });
  await db.prisma.workspace.create({
    data: {
      id: 'import-workspace',
      projectId: 'import-project',
      name: 'Imported',
      runScript: { create: {} },
      prDiscovery: { create: {} },
      prs: { create: { id: 'import-pr', url: 'https://github.com/o/r/pull/1' } },
    },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'import-child',
      projectId: 'import-project',
      name: 'Child',
      parentWorkspaceId: 'import-workspace',
    },
  });
  await db.prisma.workspace.create({
    data: { id: 'skipped', projectId: 'import-project', name: 'Skipped' },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 'import-session',
      workspaceId: 'import-workspace',
      workspacePrId: 'import-pr',
      workflow: 'pr-monitoring',
      model: 'default',
      provider: 'CODEX',
      providerSessionId: 'retained-provider-id',
      codexAccountId: 'codex-native-default',
    },
  });
  await db.prisma.workspacePRDedicatedSession.create({
    data: { prId: 'import-pr', sessionId: 'import-session' },
  });
  await db.prisma.workspacePRMonitoring.create({
    data: {
      workspaceId: 'import-workspace',
      enabled: true,
      deliveryMode: 'DEDICATED',
      bindingRevision: 7,
    },
  });
  await db.prisma.workspacePREvent.create({
    data: {
      id: 'import-event',
      workspaceId: 'import-workspace',
      kind: 'MONITORING_ENABLED',
      deduplicationKey: 'import-event',
      payload: {
        kind: 'MONITORING_ENABLED',
        workspaceId: 'import-workspace',
        bindingRevision: 7,
        replyToPrComments: true,
      },
      state: 'DISPATCHING',
      attempts: 1,
      deliveryId: 'import-delivery',
      deliverySessionId: 'import-session',
      deliveryProvider: 'CODEX',
      deliveryProviderSessionId: 'retained-provider-id',
      deliveryBindingRevision: 7,
      deliveryText: 'retained frozen delivery',
    },
  });
  await db.prisma.terminalSession.create({
    data: { id: 'import-terminal', workspaceId: 'import-workspace', name: 'Terminal' },
  });
  await db.prisma.userSettings.create({ data: { userId: 'default' } });
  backup = exportDataSchema.parse(await dataBackupService.exportData('isolation-test'));
}, 30_000);
beforeEach(async () => {
  vi.spyOn(sessionLifecycleService, 'startSession').mockRejectedValue(
    new Error('Unexpected runtime start')
  );
  vi.spyOn(terminalService, 'createTerminal').mockImplementation(() => {
    throw new Error('Unexpected terminal start');
  });
  await clearIntegrationDatabase(db.prisma);
  await db.prisma.workspaceChildOrigin.deleteMany();
  await db.prisma.workspaceLaunchOrigin.deleteMany();
});
afterEach(() => {
  try {
    expect(sessionLifecycleService.startSession).not.toHaveBeenCalled();
    expect(terminalService.createTerminal).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});
afterAll(async () => destroyIntegrationDatabase(db));

async function seedSkippedWorkspace() {
  await db.prisma.project.create({ data: project('local-project') });
  await db.prisma.workspace.create({
    data: { id: 'skipped', projectId: 'local-project', name: 'Local skipped' },
  });
  await db.prisma.workspaceLaunchOrigin.create({
    data: {
      runId: 'local-run',
      workspaceId: 'skipped',
      projectId: 'local-project',
      childHistoryVersion: 1,
    },
  });
}

async function expectRolledBack() {
  expect(await db.prisma.project.findUnique({ where: { id: 'import-project' } })).toBeNull();
  expect(await db.prisma.workspace.findUnique({ where: { id: 'import-workspace' } })).toBeNull();
  expect(await db.prisma.workspace.findUnique({ where: { id: 'import-child' } })).toBeNull();
  expect(await db.prisma.agentSession.count()).toBe(0);
  expect(await db.prisma.codexAccount.count()).toBe(1);
  expect(await db.prisma.workspacePR.count()).toBe(0);
  expect(await db.prisma.workspacePRDedicatedSession.count()).toBe(0);
  expect(await db.prisma.workspacePRMonitoring.count()).toBe(0);
  expect(await db.prisma.workspacePREvent.count()).toBe(0);
  expect(await db.prisma.workspacePRDelivery.count()).toBe(0);
  expect(await db.prisma.workspacePRDiscovery.count()).toBe(0);
  expect(await db.prisma.workspaceRunScript.count()).toBe(0);
  expect(await db.prisma.workspaceChildOrigin.count()).toBe(0);
  expect(await db.prisma.terminalSession.count()).toBe(0);
  expect(await db.prisma.userSettings.count()).toBe(0);
}

it('commits the existing base graph and account mapping through the private transaction', async () => {
  await seedSkippedWorkspace();
  const result = await dataBackupService.importData(backup);
  expect(result).toEqual({
    recovery: expect.objectContaining({
      status: 'PARTIAL',
      manifest: fixed.meta.recovery,
      unreportedTotals: 'EMBEDDED_ROWS_AND_ACCOUNT_MAPPINGS',
      warnings: expect.any(Array),
    }),
    inertTransforms: {
      workspaceWorkflows: 2,
      workspaceInitializations: 2,
      workspaceArchives: 0,
      runScripts: 0,
      terminalSessions: 0,
      agentSessions: 0,
      monitors: 1,
      heldReceipts: 1,
      cancelledFacts: 0,
      explanations: [
        'Restored processes remain stopped. Start them manually when ready.',
        'Unfinished workspace initialization and archiving require manual recovery; original status is retained in the workspace error.',
        'PR monitoring is disabled. Unsettled imported receipts remain blocked even after reenable; unclaimed pending facts are cancelled without claiming delivery.',
      ],
    },
    projects: { imported: 1, skipped: 0 },
    workspaces: { imported: 2, skipped: 1 },
    agentSessions: { imported: 1, skipped: 0 },
    terminalSessions: { imported: 1, skipped: 0 },
    userSettings: { imported: true, skipped: false },
  });
  const session = await db.prisma.agentSession.findUniqueOrThrow({
    where: { id: 'import-session' },
  });
  expect(session.codexAccountId).not.toBe('codex-native-default');
  expect(
    await db.prisma.codexAccount.findUnique({ where: { id: session.codexAccountId! } })
  ).toMatchObject({ kind: 'MANAGED' });
  expect(
    await db.prisma.workspacePRDedicatedSession.findUnique({ where: { prId: 'import-pr' } })
  ).toMatchObject({ sessionId: 'import-session' });
  expect(await db.prisma.workspacePRMonitoring.count()).toBe(2);
  expect(await db.prisma.workspacePREvent.count()).toBe(1);
  expect(await db.prisma.workspacePRDelivery.count()).toBe(1);
  expect(await db.prisma.workspaceChildOrigin.count()).toBe(1);
  expect(
    await db.prisma.workspaceLaunchOrigin.findUnique({ where: { runId: 'local-run' } })
  ).toMatchObject({ childHistoryVersion: 1 });
  expect(await db.prisma.workspace.findUnique({ where: { id: 'skipped' } })).toMatchObject({
    name: 'Local skipped',
    projectId: 'local-project',
  });
});

it('rolls back every owner after a late settings failure and preserves ordinary accepted writes', async () => {
  await seedSkippedWorkspace();
  await db.prisma.project.create({ data: project('ordinary-before') });
  const admin = new Database(db.databasePath);
  admin.exec(
    `CREATE TRIGGER fail_import_settings AFTER INSERT ON UserSettings BEGIN SELECT RAISE(ABORT, 'deliberate late import failure'); END;`
  );
  try {
    await expect(dataBackupService.importData(backup)).rejects.toMatchObject({ code: 'P2003' });
  } finally {
    admin.exec('DROP TRIGGER fail_import_settings');
    admin.close();
  }
  await expectRolledBack();
  expect(
    await db.prisma.workspaceLaunchOrigin.findUnique({ where: { runId: 'local-run' } })
  ).toMatchObject({ childHistoryVersion: 1 });
  expect(await db.prisma.project.findUnique({ where: { id: 'ordinary-before' } })).not.toBeNull();
  await db.prisma.project.create({ data: project('ordinary-after') });
  expect(await db.prisma.project.findUnique({ where: { id: 'ordinary-after' } })).not.toBeNull();
});

// The configured synchronous SQLite busy wait is 5s; allow scheduling overhead.
it('bounds held-writer contention, returns whole-import CONFLICT and permits a fresh import', async () => {
  const holder = new Database(db.databasePath);
  holder.exec('BEGIN IMMEDIATE');
  const started = Date.now();
  let failure: unknown;
  try {
    try {
      await dataBackupService.importData(backup);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ApplicationError);
    expect(failure).toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('Retry the whole import'),
    });
    expect(Date.now() - started).toBeLessThan(20_000);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  await expectRolledBack();
  await expect(dataBackupService.importData(backup)).resolves.toMatchObject({
    projects: { imported: 1 },
  });
  await db.prisma.project.create({ data: project('ordinary-after-contention') });
}, 25_000);

it('rejects invalid input before discovering or opening a private writer', async () => {
  const discovery = vi.spyOn(db.prisma, '$queryRaw');
  try {
    const imported = Reflect.apply(dataBackupService.importData, dataBackupService, [
      {
        ...backup,
        data: {
          ...backup.data,
          projects: backup.data.projects.map((row) => ({ ...row, slug: '' })),
        },
      },
    ]);
    await expect(imported).rejects.toBeInstanceOf(ZodError);
    await expect(imported).rejects.toMatchObject({
      issues: [
        expect.objectContaining({
          code: 'too_small',
          minimum: 1,
          path: ['data', 'projects', 0, 'slug'],
        }),
      ],
    });
    expect(discovery).not.toHaveBeenCalled();
    await expectRolledBack();
  } finally {
    discovery.mockRestore();
  }
});
