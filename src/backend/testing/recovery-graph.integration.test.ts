import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { configService } from '@/backend/services/config.service';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import { type PrismaClient } from '@prisma-gen/client';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!database.prisma) {
      throw new Error('Missing test DB');
    }
    return database.prisma;
  },
}));
let db: IntegrationDatabase;
beforeEach(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
  vi.spyOn(configService, 'getBaseDir').mockReturnValue(db.tempDir);
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Recovery',
      slug: 'recovery',
      repoPath: '/test',
      worktreeBasePath: '/test-trees',
    },
  });
  await db.prisma.workspace.create({
    data: { id: 'workspace', projectId: 'project', name: 'Recovery' },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 'session',
      workspaceId: 'workspace',
      workflow: 'default',
      model: 'default',
      provider: 'CODEX',
    },
  });
}, 30_000);
afterEach(async () => {
  await destroyIntegrationDatabase(db);
});

it('rejects a missing required schedule parent atomically instead of silently losing executions', async () => {
  await db.prisma.periodicTask.create({
    data: {
      id: 'task',
      projectId: 'project',
      name: 'task',
      prompt: 'go',
      cadence: 'DAILY',
      nextRunAt: new Date(),
    },
  });
  await db.prisma.periodicTaskExecution.create({
    data: { id: 'execution', periodicTaskId: 'task', status: 'COMPLETED' },
  });
  const backup = await dataBackupService.exportData('test');
  backup.data.durable!.periodicTask = [];
  await db.prisma.periodicTask.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await expect(dataBackupService.importData(backup)).rejects.toThrow(/required parent/i);
  expect(await db.prisma.project.count()).toBe(0);
});
it('rejects missing automation parents while preserving required history atomically', async () => {
  await db.prisma.agentDefinition.create({
    data: { id: 'definition', projectId: 'project', name: 'agent', instructions: 'go' },
  });
  await db.prisma.agentRun.create({
    data: {
      id: 'run',
      agentDefinitionId: 'definition',
      idempotencyKey: 'run',
      definitionSnapshot: {},
      input: {},
      status: 'COMPLETED',
    },
  });
  const backup = await dataBackupService.exportData('test');
  backup.data.durable!.agentDefinition = [];
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await expect(dataBackupService.importData(backup)).rejects.toThrow(/required parent/i);
  expect(await db.prisma.project.count()).toBe(0);
});
it('rejects an archive without its required workspace before any parent is imported', async () => {
  const backup = await dataBackupService.exportData('test');
  const timestamp = '2026-01-01T00:00:00.000Z';
  const metadata = {
    name: null,
    workflow: 'default',
    provider: 'CODEX' as const,
    model: 'default',
    startedAt: timestamp,
    completedAt: timestamp,
  };
  const transcript = JSON.stringify({
    version: 1,
    workspaceId: 'missing',
    sessionId: 'deleted',
    metadata,
    messages: [],
  });
  backup.data.archives!.entries.push({
    id: 'archive',
    workspaceId: 'missing',
    sessionId: 'deleted',
    ...metadata,
    archiveKey: 'a'.repeat(64),
    transcript,
    byteLength: Buffer.byteLength(transcript),
    sha256: createHash('sha256').update(transcript).digest('hex'),
  });
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await expect(dataBackupService.importData(backup)).rejects.toThrow(/required parent/i);
  expect(await db.prisma.project.count()).toBe(0);
});

it('reports retained identities skipped for local collisions or rejected parents alongside imported history', async () => {
  await db.prisma.periodicTask.create({
    data: {
      id: 'task',
      projectId: 'project',
      name: 'local task',
      prompt: 'go',
      cadence: 'DAILY',
      nextRunAt: new Date(),
    },
  });
  await db.prisma.periodicTaskExecution.create({
    data: { id: 'execution', periodicTaskId: 'task', status: 'COMPLETED' },
  });
  await db.prisma.decisionLog.create({
    data: { id: 'decision', agentId: 'deleted-session', decision: 'kept', reasoning: 'historical' },
  });
  const backup = await dataBackupService.exportData('test');
  await db.prisma.periodicTaskExecution.deleteMany();
  await db.prisma.decisionLog.deleteMany();
  const result = await dataBackupService.importData(backup);
  expect(result.recovery.models).toEqual(
    expect.arrayContaining([
      { model: 'PeriodicTask', imported: 0, skipped: 1 },
      { model: 'PeriodicTaskExecution', imported: 0, skipped: 1 },
      { model: 'DecisionLog', imported: 1, skipped: 0 },
    ])
  );
  expect(result.recovery.skipped).toEqual(
    expect.arrayContaining([
      { model: 'PeriodicTask', identity: 'task', reason: 'EXISTING_IDENTITY' },
      {
        model: 'PeriodicTaskExecution',
        identity: 'execution',
        reason: 'CONFLICTING_IDENTITY_OR_PARENT',
      },
    ])
  );
  expect(await db.prisma.periodicTaskExecution.count()).toBe(0);
  expect(await db.prisma.decisionLog.count()).toBe(1);
});

it('roundtrips a supported cross-project child created by the actual workspace owner', async () => {
  const { WorkspaceCreationService } = await vi.importActual<
    typeof import('@/backend/services/workspace')
  >('@/backend/services/workspace');
  const { createChildWorkspace } = await vi.importActual<
    typeof import('@/backend/orchestration/workspace-children.orchestrator')
  >('@/backend/orchestration/workspace-children.orchestrator');
  const { createLogger } = await vi.importActual<
    typeof import('@/backend/services/logger.service')
  >('@/backend/services/logger.service');
  await db.prisma.project.create({
    data: {
      id: 'child-project',
      name: 'Child repository',
      slug: 'child-repository',
      repoPath: '/child-repo',
      worktreeBasePath: '/child-trees',
    },
  });
  const creation = new WorkspaceCreationService({
    logger: createLogger('recovery-cross-project-test'),
  });
  const childId = await createChildWorkspace(
    { parentWorkspaceId: 'workspace', projectId: 'child-project', name: 'Cross-project child' },
    {
      findProject: (id) =>
        db.prisma.project.findUnique({ where: { id }, include: { workspaces: true } }),
      launchWorkspace: async (source) => ({
        workspace: await creation.create(source),
        defaultSessionId: null,
      }),
    }
  );
  const backup = await dataBackupService.exportData('test');
  const origins = await db.prisma.workspaceChildOrigin.findMany();
  expect(origins).toEqual([
    expect.objectContaining({ parentWorkspaceId: 'workspace', childWorkspaceId: childId }),
  ]);
  await db.prisma.workspace.deleteMany();
  await db.prisma.workspaceChildOrigin.deleteMany();
  await db.prisma.project.deleteMany();
  await expect(dataBackupService.importData(backup)).resolves.toMatchObject({
    projects: { imported: 2, skipped: 0 },
    workspaces: { imported: 2, skipped: 0 },
  });
  expect(await db.prisma.workspace.findUnique({ where: { id: childId } })).toMatchObject({
    projectId: 'child-project',
    parentWorkspaceId: 'workspace',
    creationSource: 'CHILD_WORKSPACE',
  });
  expect(await db.prisma.workspace.findUnique({ where: { id: 'workspace' } })).toMatchObject({
    projectId: 'project',
  });
  expect(await db.prisma.workspaceChildOrigin.findMany()).toEqual(origins);
});
it.each(['missing-parent', 'workspace'])(
  'still rejects missing or cyclic workspace ancestry: %s',
  async (parentWorkspaceId) => {
    const backup = await dataBackupService.exportData('test');
    backup.data.workspaces[0]!.parentWorkspaceId = parentWorkspaceId;
    await db.prisma.workspace.deleteMany();
    await db.prisma.project.deleteMany();
    await expect(dataBackupService.importData(backup)).rejects.toThrow(
      /required parent|ancestry cycle/i
    );
    expect(await db.prisma.project.count()).toBe(0);
  }
);

it('rejects lifecycle history bound to a session in another imported workspace before any writes', async () => {
  await db.prisma.workspace.create({
    data: { id: 'other-workspace', projectId: 'project', name: 'Other' },
  });
  await db.prisma.sessionLifecycleEvent.create({
    data: {
      id: 'lifecycle',
      workspaceId: 'workspace',
      sessionId: 'session',
      kind: 'TURN_INTERRUPTED',
      reason: 'PROVIDER_ERROR',
      message: 'Original session failure',
      dedupeKey: 'failure',
    },
  });
  const backup = await dataBackupService.exportData('test');
  backup.data.durable!.sessionLifecycleEvent[0]!.workspaceId = 'other-workspace';
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await expect(dataBackupService.importData(backup)).rejects.toThrow(
    /SessionLifecycleEvent.sessionId/
  );
  expect(await db.prisma.project.count()).toBe(0);
  expect(await db.prisma.sessionLifecycleEvent.count()).toBe(0);
});

it('retains lifecycle history for a matching live session and a deleted session', async () => {
  const rows = await Promise.all(
    ['session', 'deleted-session'].map((sessionId) =>
      db.prisma.sessionLifecycleEvent.create({
        data: {
          id: `lifecycle-${sessionId}`,
          workspaceId: 'workspace',
          sessionId,
          kind: 'TURN_INTERRUPTED',
          reason: 'PROVIDER_ERROR',
          message: 'Retained failure',
          dedupeKey: 'failure',
        },
      })
    )
  );
  const backup = await dataBackupService.exportData('test');
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  const result = await dataBackupService.importData(backup);
  expect(result.recovery.models).toContainEqual({
    model: 'SessionLifecycleEvent',
    imported: 2,
    skipped: 0,
  });
  expect(await db.prisma.sessionLifecycleEvent.findMany({ orderBy: { id: 'asc' } })).toEqual(
    rows.sort((a, b) => a.id.localeCompare(b.id))
  );
});

it.each([4, 5, 6, 7] as const)(
  'keeps legacy v%s missing-parent recovery as a reported skip',
  async (schemaVersion) => {
    const backup = await dataBackupService.exportData('test');
    backup.meta.recovery = undefined;
    backup.data.durable = undefined;
    backup.data.archives = undefined;
    backup.data.agentSessions = [];
    backup.data.workspaces[0]!.parentWorkspaceId = 'missing-parent';
    await db.prisma.workspace.deleteMany();
    await db.prisma.project.deleteMany();
    const legacy = exportDataSchema.parse({ ...backup, meta: { ...backup.meta, schemaVersion } });
    const result = await dataBackupService.importData(legacy);
    expect(result.projects.imported).toBe(1);
    expect(result.workspaces).toEqual({ imported: 0, skipped: 1 });
    expect(await db.prisma.workspace.count()).toBe(0);
  }
);
