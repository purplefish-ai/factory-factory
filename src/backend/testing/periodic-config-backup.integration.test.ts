import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { jobRunner } from '@/backend/services/job-runner.service';
import { periodicTaskService } from '@/backend/services/periodic-task';
import { expectBackupWriterUnopened } from '@/backend/services/settings/resources/backup-writer.test-support';
import { exportDataSchema, exportedProjectSchema } from '@/shared/schemas/export-data.schema';
import legacy from '@/shared/testing/recovery-base-json-v8.fixture.json';
import fixed from '@/shared/testing/recovery-periodic-config-v8.fixture.json';
import { Prisma, type PrismaClient } from '@prisma-gen/client';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return state.prisma;
  },
}));
let source: IntegrationDatabase;
let target: IntegrationDatabase;
beforeAll(async () => {
  source = await createIntegrationDatabase();
  target = await createIntegrationDatabase();
}, 30_000);
beforeEach(async () => {
  for (const db of [source, target]) {
    await db.prisma.periodicTaskExecution.deleteMany();
    await db.prisma.workspace.deleteMany();
    await db.prisma.periodicTask.deleteMany();
  }
  await clearIntegrationDatabase(source.prisma);
  await clearIntegrationDatabase(target.prisma);
  state.prisma = source.prisma;
});
afterEach(async () => {
  await periodicTaskService.stop();
  vi.useRealTimers();
});
afterAll(async () => {
  await destroyIntegrationDatabase(source);
  await destroyIntegrationDatabase(target);
});
const project = (id: string) => ({
  id,
  name: id,
  slug: id,
  repoPath: `/${id}`,
  worktreeBasePath: `/w/${id}`,
});

async function producerBackup() {
  await source.prisma.project.create({ data: project('source') });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-31T12:00:00.123Z'));
  const inputs = [
    { name: 'daily', cadence: 'DAILY', scheduledTime: '09:15', timezone: 'America/New_York' },
    { name: 'monthly', cadence: 'MONTHLY', scheduledTime: '23:15', timezone: 'UTC' },
    { name: 'retained', cadence: 'MONTHLY', scheduledTime: null, timezone: null },
    { name: 'time-only', cadence: 'WEEKLY', scheduledTime: '10:45', timezone: null },
    { name: 'zone-only', cadence: 'DAILY', scheduledTime: null, timezone: 'US/Eastern' },
    { name: 'minute', cadence: 'EVERY_MINUTE', scheduledTime: '00:00', timezone: '+01:00' },
    { name: 'disabled', cadence: 'EVERY_FIVE_MINUTES', scheduledTime: null, timezone: null },
  ] as const;
  for (const input of inputs) {
    const task = await periodicTaskService.create({
      ...input,
      projectId: 'source',
      prompt: `${input.name} prompt`,
    });
    if (input.name === 'retained') {
      vi.setSystemTime(new Date('2026-02-02T11:00:00.456Z'));
      await periodicTaskService.update(task.id, { cadence: 'DAILY' });
      vi.setSystemTime(new Date('2026-01-31T12:00:00.123Z'));
    }
    if (input.name === 'disabled') {
      await periodicTaskService.toggleEnabled(task.id, false);
    }
  }
  // Historical fixture: old MONTHLY rows can have no persisted anchor and non-null lastRunAt.
  await source.prisma.periodicTask.create({
    data: {
      id: 'historical-null-anchor',
      projectId: 'source',
      name: 'Legacy monthly',
      prompt: '',
      cadence: 'MONTHLY',
      scheduledDayOfMonth: null,
      isEnabled: false,
      nextRunAt: new Date('2025-03-01T04:00:00.000Z'),
      lastRunAt: new Date('2025-02-01T04:00:00.000Z'),
      createdAt: new Date('2025-01-31T04:00:00.000Z'),
      updatedAt: new Date('2025-02-01T04:01:00.000Z'),
    },
  });
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
  return dataBackupService.exportData('periodic-test');
}

it('roundtrips every scalar and all four timestamps disabled without mutating source input or recomputing overdue slots', async () => {
  const backup = await producerBackup();
  const inputBefore = structuredClone(backup);
  const rows = await source.prisma.periodicTask.findMany({ orderBy: { id: 'asc' } });
  expect(rows.find((t) => t.name === 'retained')).toMatchObject({
    cadence: 'DAILY',
    scheduledDayOfMonth: 31,
  });
  expect(backup.meta).toHaveProperty('recovery', fixed.meta.recovery);
  const wire = 'recovery' in backup.data ? backup.data.recovery.periodicConfig!.tasks : [];
  expect(wire).toHaveLength(8);
  rows.forEach((row, i) => {
    expect(wire[i]).toEqual({
      ...row,
      nextRunAt: row.nextRunAt.toISOString(),
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
    expect(row.nextRunAt.getTime()).toBeLessThan(Date.now());
  });
  state.prisma = target.prisma;
  const result = await dataBackupService.importData(backup);
  expect(result.recovery.periodicConfig).toEqual({
    model: 'PeriodicTask',
    imported: 8,
    skipped: 0,
    sourceEnabled: 6,
    restoredDisabled: 8,
    reasons: { EXISTING_IDENTITY: 0, INCOMPLETE_DEPENDENCY: 0 },
  });
  expect(await target.prisma.periodicTask.findMany({ orderBy: { id: 'asc' } })).toEqual(
    rows.map((row) => ({ ...row, isEnabled: false }))
  );
  expect(await target.prisma.periodicTaskExecution.count()).toBe(0);
  expect(backup).toEqual(inputBefore);
  const reexport = await dataBackupService.exportData('destination');
  expect(reexport.data).toHaveProperty(
    'recovery.periodicConfig.tasks',
    wire.map((row) => ({ ...row, isEnabled: false }))
  );
});

it('overdue restored schedules cannot dispatch; a fresh enabled control dispatches on a separate real poll', async () => {
  const backup = await producerBackup();
  state.prisma = target.prisma;
  await dataBackupService.importData(backup);
  const before = await target.prisma.periodicTask.findMany({ orderBy: { id: 'asc' } });
  const dispatch = vi.fn(async (event: { projectId: string; periodicTaskId: string }) => {
    const workspace = await target.prisma.workspace.create({
      data: {
        name: 'Control launched',
        projectId: event.projectId,
        periodicTaskId: event.periodicTaskId,
      },
    });
    return { workspaceId: workspace.id };
  });
  periodicTaskService.configure({
    timerDispatch: { dispatchTimerEvent: dispatch },
    status: { getWorkspaceStatus: async () => null },
  });
  periodicTaskService.start();
  await jobRunner.waitForCurrentRun('periodic-task-poll');
  await periodicTaskService.stop();
  expect(dispatch).not.toHaveBeenCalled();
  expect(await target.prisma.workspace.count()).toBe(0);
  expect(await target.prisma.periodicTaskExecution.count()).toBe(0);
  expect(await target.prisma.periodicTask.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  const control = await periodicTaskService.create({
    projectId: 'source',
    name: 'Control',
    prompt: 'Control',
    cadence: 'EVERY_MINUTE',
  });
  periodicTaskService.start();
  await jobRunner.waitForCurrentRun('periodic-task-poll');
  await periodicTaskService.stop();
  expect(dispatch).toHaveBeenCalledOnce();
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ periodicTaskId: control.id, kind: 'timer_due' })
  );
  expect(await target.prisma.periodicTaskExecution.findMany()).toEqual([
    expect.objectContaining({
      periodicTaskId: control.id,
      workspaceId: expect.any(String),
      status: 'RUNNING',
    }),
  ]);
  expect(await target.prisma.workspace.count()).toBe(1);
  expect(
    await target.prisma.periodicTask.findMany({
      where: { id: { not: control.id } },
      orderBy: { id: 'asc' },
    })
  ).toEqual(before);
});

it('uses identity priority, skips every skipped parent and preserves enabled local bytes; repeat counts actual skips', async () => {
  state.prisma = target.prisma;
  const file = structuredClone(fixed);
  const template = file.data.projects[0]!;
  file.data.projects = ['incompatible', 'slug-source', 'compatible', 'healthy'].map((id) => ({
    ...template,
    id,
    slug: id,
  }));
  await target.prisma.project.create({
    data: { ...project('incompatible'), repoPath: '/different' },
  });
  await target.prisma.project.create({ data: { ...project('local-slug'), slug: 'slug-source' } });
  const { issueTrackerConfig: _config, ...compatible } = exportedProjectSchema.parse(
    file.data.projects[2]!
  );
  await target.prisma.project.create({ data: compatible });
  await target.prisma.project.create({ data: project('unrelated') });
  const local = await periodicTaskService.create({
    projectId: 'unrelated',
    name: 'Local enabled',
    prompt: 'local bytes',
    cadence: 'EVERY_MINUTE',
  });
  const task = file.data.recovery.periodicConfig.tasks[0]!;
  file.data.recovery.periodicConfig.tasks = [
    { ...task, id: local.id, projectId: 'incompatible' },
    { ...task, id: 'bad-id', projectId: 'incompatible' },
    { ...task, id: 'bad-slug', projectId: 'slug-source' },
    { ...task, id: 'exact-parent', projectId: 'compatible' },
    { ...task, id: 'healthy-task', projectId: 'healthy', isEnabled: false },
  ];
  const projectsBefore = await target.prisma.project.findMany({ orderBy: { id: 'asc' } });
  const result = await dataBackupService.importData(exportDataSchema.parse(file));
  expect(result.recovery.periodicConfig).toEqual({
    model: 'PeriodicTask',
    imported: 1,
    skipped: 4,
    sourceEnabled: 4,
    restoredDisabled: 1,
    reasons: { EXISTING_IDENTITY: 1, INCOMPLETE_DEPENDENCY: 3 },
  });
  expect(await periodicTaskService.get(local.id)).toMatchObject(local);
  expect(await target.prisma.periodicTask.findUniqueOrThrow({ where: { id: local.id } })).toEqual(
    local
  );
  expect(await target.prisma.periodicTask.count()).toBe(2);
  expect(
    await target.prisma.project.findMany({
      where: { id: { not: 'healthy' } },
      orderBy: { id: 'asc' },
    })
  ).toEqual(projectsBefore);
  const tasksBefore = await target.prisma.periodicTask.findMany({ orderBy: { id: 'asc' } });
  const repeat = await dataBackupService.importData(exportDataSchema.parse(file));
  expect(repeat.recovery.periodicConfig).toEqual({
    model: 'PeriodicTask',
    imported: 0,
    skipped: 5,
    sourceEnabled: 4,
    restoredDisabled: 0,
    reasons: { EXISTING_IDENTITY: 2, INCOMPLETE_DEPENDENCY: 3 },
  });
  expect(await target.prisma.periodicTask.findMany({ orderBy: { id: 'asc' } })).toEqual(
    tasksBefore
  );
});

it('rejects malformed or absent source parents before the private writer even when a local parent exists', async () => {
  state.prisma = target.prisma;
  await target.prisma.project.create({ data: project('periodic-project') });
  for (const mutate of [
    (file: typeof fixed) => {
      file.data.projects = [];
    },
    (file: typeof fixed) => {
      file.data.recovery.periodicConfig.tasks[0]!.scheduledTime = '25:00';
    },
    (file: typeof fixed) => {
      Object.assign(file.data.recovery, { periodicConfig: undefined });
    },
  ]) {
    const file = structuredClone(fixed);
    mutate(file);
    await expectBackupWriterUnopened(async () => {
      await expect(
        Reflect.apply(dataBackupService.importData, dataBackupService, [file])
      ).rejects.toThrow();
    });
  }
  expect(await target.prisma.periodicTask.count()).toBe(0);
});

it('rolls back periodic insertion and parents when a later session write aborts', async () => {
  state.prisma = target.prisma;
  const file = structuredClone(fixed);
  // Reuse a published full-base workspace/session shape; new periodic fixture remains independent.
  Object.assign(file.data, {
    workspaces: legacy.data.workspaces.map((w) => ({ ...w, projectId: 'periodic-project' })),
    agentSessions: legacy.data.agentSessions,
    terminalSessions: legacy.data.terminalSessions,
    codexAccounts: legacy.data.codexAccounts,
  });
  await target.prisma.$executeRawUnsafe(
    "CREATE TRIGGER fail_session BEFORE INSERT ON AgentSession WHEN EXISTS (SELECT 1 FROM PeriodicTask WHERE id = 'scheduled-maintenance') BEGIN SELECT RAISE(ABORT, 'late session'); END"
  );
  try {
    await expect(dataBackupService.importData(exportDataSchema.parse(file))).rejects.toThrow(
      /agentSession.create/
    );
    expect(await target.prisma.project.count()).toBe(0);
    expect(await target.prisma.workspace.count()).toBe(0);
    expect(await target.prisma.periodicTask.count()).toBe(0);
    expect(await target.prisma.agentSession.count()).toBe(0);
  } finally {
    await target.prisma.$executeRawUnsafe('DROP TRIGGER fail_session');
  }
});

it('keeps physical SQL NULL and JSON null distinct for all three full-base catalog fields under the new profile', async () => {
  await source.prisma.project.create({ data: project('source') });
  for (const [id, value] of [
    ['sql', Prisma.DbNull],
    ['json', Prisma.JsonNull],
  ] as const) {
    await source.prisma.workspace.create({
      data: { id, projectId: 'source', name: id, creationMetadata: value },
    });
    await source.prisma.workspacePR.create({
      data: { id, workspaceId: id, url: `https://github.com/o/r/pull/${id}`, observation: value },
    });
    await source.prisma.agentSession.create({
      data: {
        id,
        workspaceId: id,
        workflow: 'default',
        provider: 'CLAUDE',
        providerMetadata: value,
      },
    });
  }
  const read = async (prisma: PrismaClient) => ({
    workspaces:
      await prisma.$queryRaw`SELECT id, typeof("creationMetadata") AS storage, json_type("creationMetadata") AS kind FROM "Workspace" ORDER BY id`,
    prs: await prisma.$queryRaw`SELECT id, typeof("observation") AS storage, json_type("observation") AS kind FROM "WorkspacePR" ORDER BY id`,
    sessions:
      await prisma.$queryRaw`SELECT id, typeof("providerMetadata") AS storage, json_type("providerMetadata") AS kind FROM "AgentSession" ORDER BY id`,
  });
  const states = [
    { id: 'json', storage: 'text', kind: 'null' },
    { id: 'sql', storage: 'null', kind: null },
  ];
  expect(await read(source.prisma)).toEqual({ workspaces: states, prs: states, sessions: states });
  const backup = await dataBackupService.exportData('physical-null');
  expect(backup.meta).toHaveProperty('recovery.profile', 'base-json-periodic-config-1');
  for (const kind of ['missing', 'undefined']) {
    const invalid = structuredClone(backup);
    const pr = invalid.data.workspaces[0]!.prs[0]!;
    if (kind === 'missing') {
      Reflect.deleteProperty(pr, 'observation');
    } else {
      Object.assign(pr, { observation: undefined });
    }
    if ('recovery' in invalid.data) {
      invalid.data.recovery.baseJson!.jsonStorage = [];
    }
    await expectBackupWriterUnopened(async () => {
      await expect(dataBackupService.importData(invalid)).rejects.toThrow();
    });
  }
  state.prisma = target.prisma;
  await dataBackupService.importData(backup);
  expect(await read(target.prisma)).toEqual({ workspaces: states, prs: states, sessions: states });
});

it('reports a missing second task project at its exact path before opening the private writer', async () => {
  const file = structuredClone(fixed);
  file.data.recovery.periodicConfig.tasks.push({
    ...file.data.recovery.periodicConfig.tasks[0]!,
    id: 'second-task',
    projectId: 'absent-project',
  });
  await expectBackupWriterUnopened(async () => {
    await expect(
      Reflect.apply(dataBackupService.importData, dataBackupService, [file])
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        {
          code: 'custom',
          message: 'Periodic task project is absent from backup',
          path: ['data', 'recovery', 'periodicConfig', 'tasks', 1, 'projectId'],
        },
      ]),
    });
  });
});
