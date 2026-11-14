import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { dataBackupService } from '@/backend/orchestration/data-backup/data-backup.service';
import { jobRunner } from '@/backend/services/job-runner.service';
import { createLogger } from '@/backend/services/logger.service';
import { periodicTaskService } from '@/backend/services/periodic-task';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { exportDataSchema, exportedProjectSchema } from '@/shared/schemas/export-data.schema';
import history from '@/shared/testing/recovery-periodic-history-v8.fixture.json';
import fixed from '@/shared/testing/recovery-periodic-links-v8.fixture.json';
import type { Prisma, PrismaClient } from '@prisma-gen/client';
import { WorkspaceCreationService } from './creation.service';

const state = vi.hoisted(() => ({
  prisma: undefined as PrismaClient | undefined,
  historyPlanned: false,
  removeActualHistoryWorkspace: false,
  occupiedIds: undefined as ReadonlySet<string> | undefined,
  firstWrite: undefined as
    | ((ids: ReadonlySet<string>, occupied: ReadonlySet<string> | undefined) => void)
    | undefined,
  afterRestore: undefined as
    | ((tx: Prisma.TransactionClient, ids: Set<string>) => Promise<void>)
    | undefined,
}));
vi.mock(
  '@/backend/orchestration/data-backup/data-backup-legacy-collisions',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('@/backend/orchestration/data-backup/data-backup-legacy-collisions')
      >();
    return {
      ...original,
      planLegacyImport: async (...args: Parameters<typeof original.planLegacyImport>) => {
        const admission = await original.planLegacyImport(...args);
        const create = args[0].project.create.bind(args[0].project);
        vi.spyOn(args[0].project, 'create').mockImplementation((input) => {
          state.firstWrite?.(admission.eligibleWorkspaceIds, state.occupiedIds);
          return create(input);
        });
        return admission;
      },
    };
  }
);
vi.mock('@/backend/services/periodic-task', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/backend/services/periodic-task')>();
  return {
    ...original,
    planPeriodicHistoryRecovery: async (
      ...args: Parameters<typeof original.planPeriodicHistoryRecovery>
    ) => {
      const plan = await original.planPeriodicHistoryRecovery(...args);
      state.historyPlanned = true;
      return plan;
    },
    restorePeriodicHistoryRecovery: async (
      ...args: Parameters<typeof original.restorePeriodicHistoryRecovery>
    ) => {
      if (state.removeActualHistoryWorkspace) {
        args[3] = new Set();
      }
      return await original.restorePeriodicHistoryRecovery(...args);
    },
    readPeriodicConfigRecoveryIds: async (
      ...args: Parameters<typeof original.readPeriodicConfigRecoveryIds>
    ) => {
      const ids = await original.readPeriodicConfigRecoveryIds(...args);
      state.occupiedIds = ids;
      return ids;
    },
    restorePeriodicConfigRecovery: async (
      ...args: Parameters<typeof original.restorePeriodicConfigRecovery>
    ) => {
      const result = await original.restorePeriodicConfigRecovery(...args);
      await state.afterRestore?.(args[0], result.createdTaskIds);
      return result;
    },
  };
});
vi.mock('@/backend/db', () => ({
  get prisma() {
    return state.prisma;
  },
}));
async function expectBackupWriterUnopened(action: () => Promise<void>) {
  const discovery = vi.spyOn(source.prisma, '$queryRaw');
  try {
    await action();
    expect(discovery).not.toHaveBeenCalled();
  } finally {
    discovery.mockRestore();
  }
}
let source: IntegrationDatabase;
let target: IntegrationDatabase;
const service = new WorkspaceCreationService({ logger: createLogger('periodic-recovery-test') });
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
  state.historyPlanned = false;
  state.removeActualHistoryWorkspace = false;
  state.occupiedIds = undefined;
  state.firstWrite = undefined;
  state.afterRestore = undefined;
});
afterEach(async () => {
  await periodicTaskService.stop();
  vi.useRealTimers();
});
afterAll(async () => {
  await destroyIntegrationDatabase(source);
  await destroyIntegrationDatabase(target);
});

it('roundtrips real public owner-created same/cross-project links and null after deletion with exact updatedAt', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
  for (const id of ['a', 'b']) {
    await source.prisma.project.create({
      data: { id, name: id, slug: id, repoPath: `/${id}`, worktreeBasePath: `/w/${id}` },
    });
  }
  const task = await periodicTaskService.create({
    projectId: 'a',
    name: 'Task',
    prompt: 'Prompt',
    cadence: 'DAILY',
  });
  for (const projectId of ['a', 'b']) {
    await service.create({
      type: 'PERIODIC_TASK',
      projectId,
      periodicTaskId: task.id,
      name: projectId,
      initialPrompt: 'Prompt',
      ratchetEnabled: false,
    });
  }
  const deleted = await periodicTaskService.create({
    projectId: 'a',
    name: 'Deleted',
    prompt: 'Old',
    cadence: 'DAILY',
  });
  await service.create({
    type: 'PERIODIC_TASK',
    projectId: 'a',
    periodicTaskId: deleted.id,
    name: 'Deleted task workspace',
    initialPrompt: 'Old',
    ratchetEnabled: false,
  });
  await periodicTaskService.delete(deleted.id);
  await service.create({ type: 'MANUAL', projectId: 'a', name: 'Manual', ratchetEnabled: false });
  const rows = await source.prisma.workspace.findMany({ orderBy: { id: 'asc' } });
  expect(rows.filter((w) => w.periodicTaskId === task.id)).toHaveLength(2);
  expect(rows.find((w) => w.name === 'Deleted task workspace')).toMatchObject({
    creationSource: 'PERIODIC_TASK',
    periodicTaskId: null,
  });
  expect(await source.prisma.periodicTaskExecution.count()).toBe(0);
  const backup = await dataBackupService.exportData('links');
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
  expect(backup.data.workspaces).toEqual(
    expect.arrayContaining(
      rows.map((w) =>
        expect.objectContaining({
          id: w.id,
          periodicTaskId: w.periodicTaskId,
          updatedAt: w.updatedAt.toISOString(),
        })
      )
    )
  );
  state.prisma = target.prisma;
  const result = await dataBackupService.importData(backup);
  expect(
    await target.prisma.workspace.findMany({
      select: { id: true, projectId: true, periodicTaskId: true, updatedAt: true },
      orderBy: { id: 'asc' },
    })
  ).toEqual(
    rows.map(({ id, projectId, periodicTaskId, updatedAt }) => ({
      id,
      projectId,
      periodicTaskId,
      updatedAt,
    }))
  );
  expect(await periodicTaskService.get(task.id)).toMatchObject({ ...task, isEnabled: false });
  expect(result.recovery).toHaveProperty('periodicWorkspaceLinks', {
    model: 'Workspace',
    imported: 2,
    skipped: 0,
    reasons: { INCOMPLETE_DEPENDENCY: 0 },
  });
  expect(await target.prisma.periodicTaskExecution.count()).toBe(0);
}, 30_000);

it('accepts a new workspace under an exactly compatible existing project linked to a task under a new project', async () => {
  const file = structuredClone(fixed);
  const project = file.data.projects[1]!;
  const { issueTrackerConfig: _config, ...data } = exportedProjectSchema.parse(project);
  await target.prisma.project.create({ data });
  state.prisma = target.prisma;
  const result = await dataBackupService.importData(exportDataSchema.parse(file));
  expect(result.projects).toEqual({ imported: 1, skipped: 1 });
  expect(result.workspaces).toEqual({ imported: 3, skipped: 0 });
  expect(result.recovery.periodicWorkspaceLinks).toEqual({
    model: 'Workspace',
    imported: 1,
    skipped: 0,
    reasons: { INCOMPLETE_DEPENDENCY: 0 },
  });
  expect(await target.prisma.workspace.findUniqueOrThrow({ where: { id: 'root' } })).toMatchObject({
    projectId: project.id,
    periodicTaskId: 'scheduled-maintenance',
    updatedAt: new Date(file.data.workspaces[0]!.updatedAt),
  });
  expect(
    await target.prisma.periodicTask.findUniqueOrThrow({ where: { id: 'scheduled-maintenance' } })
  ).toHaveProperty('isEnabled', false);
});

it('uses actual created workspace and task sets exclusively on the supplied private owner transaction', async () => {
  await target.prisma.project.create({
    data: { id: 'p', name: 'p', slug: 'p', repoPath: '/p', worktreeBasePath: '/w' },
  });
  await target.prisma.periodicTask.create({
    data: {
      id: 't',
      projectId: 'p',
      name: 'Task',
      prompt: '',
      cadence: 'DAILY',
      nextRunAt: new Date(),
    },
  });
  for (const id of ['created', 'existing', 'missing-task']) {
    await target.prisma.workspace.create({ data: { id, name: id, projectId: 'p' } });
  }
  const timestamp = '2025-01-01T00:00:00.000Z';
  const rows = ['created', 'existing', 'missing-task'].map((id) => ({
    id,
    periodicTaskId: id === 'missing-task' ? 'uncreated' : 't',
    updatedAt: timestamp,
  }));
  const before = await target.prisma.workspace.findMany({ orderBy: { id: 'asc' } });
  const update = vi.spyOn(target.prisma.workspace, 'update');
  try {
    await expect(
      target.prisma.$transaction(async (tx) => {
        const report = await workspaceAccessor.restorePeriodicTaskLinks(
          tx,
          rows,
          new Set(['created', 'missing-task']),
          new Set(['t'])
        );
        expect(report).toEqual({
          model: 'Workspace',
          imported: 1,
          skipped: 2,
          reasons: { INCOMPLETE_DEPENDENCY: 2 },
        });
        expect(await tx.workspace.findUniqueOrThrow({ where: { id: 'created' } })).toMatchObject({
          periodicTaskId: 't',
          updatedAt: new Date(timestamp),
        });
        expect(await tx.workspace.findUniqueOrThrow({ where: { id: 'existing' } })).toHaveProperty(
          'periodicTaskId',
          null
        );
        throw new Error('owner transaction rollback');
      })
    ).rejects.toThrow('owner transaction rollback');
    expect(update).not.toHaveBeenCalled();
    expect(await target.prisma.workspace.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  } finally {
    update.mockRestore();
  }
});

it.each(['missing', 'undefined', 'absent-task'] as const)(
  'rejects raw %s links before writer discovery at the exact second-row path',
  async (kind) => {
    const file = structuredClone(fixed);
    if (kind === 'missing') {
      Reflect.deleteProperty(file.data.workspaces[1]!, 'periodicTaskId');
    } else {
      Object.assign(file.data.workspaces[1]!, {
        periodicTaskId: kind === 'undefined' ? undefined : 'absent',
      });
    }
    await expectBackupWriterUnopened(async () => {
      await expect(
        Reflect.apply(dataBackupService.importData, dataBackupService, [file])
      ).rejects.toSatisfy((error: unknown) => {
        if (!(error instanceof z.ZodError)) {
          return false;
        }
        const issues = error.issues.flatMap((issue) =>
          issue.code === 'invalid_union' ? issue.errors.flat() : [issue]
        );
        expect(issues).toContainEqual(
          expect.objectContaining({
            path: ['data', 'workspaces', 1, 'periodicTaskId'],
            ...(kind === 'absent-task'
              ? { code: 'custom', message: 'Workspace periodic task is absent from backup' }
              : { code: 'invalid_type', expected: 'string' }),
          })
        );
        return true;
      });
    });
  }
);

it('rolls back parents, tasks and workspaces after successful actual link writes', async () => {
  state.prisma = target.prisma;
  await target.prisma.$executeRawUnsafe(
    "CREATE TRIGGER reject_linked_session BEFORE INSERT ON AgentSession WHEN EXISTS (SELECT 1 FROM Workspace WHERE periodicTaskId = 'scheduled-maintenance') BEGIN SELECT RAISE(ABORT, 'after actual link write'); END"
  );
  try {
    await expect(dataBackupService.importData(exportDataSchema.parse(fixed))).rejects.toThrow(
      /agentSession.create/
    );
    expect(await target.prisma.project.count()).toBe(0);
    expect(await target.prisma.workspace.count()).toBe(0);
    expect(await target.prisma.periodicTask.count()).toBe(0);
    expect(await target.prisma.agentSession.count()).toBe(0);
    expect(await target.prisma.terminalSession.count()).toBe(0);
  } finally {
    await target.prisma.$executeRawUnsafe('DROP TRIGGER reject_linked_session');
  }
});

it('finishes all task occupancy and linked root/child admission before the first insert, independent of source order', async () => {
  const file = structuredClone(fixed);
  const [root, child, healthy] = file.data.workspaces;
  if (!(root && child && healthy)) {
    throw new Error('Expected literal workspace graph');
  }
  file.data.workspaces = [child, root, healthy];
  const session = file.data.agentSessions[0];
  const terminal = file.data.terminalSessions[0];
  if (!(session && terminal)) {
    throw new Error('Expected literal group rows');
  }
  for (const workspace of [child, healthy]) {
    file.data.agentSessions.push({
      ...session,
      id: `${workspace.id}-session`,
      workspaceId: workspace.id,
      workspacePrId: `pr-${workspace.id}`,
      workflow: 'default',
    });
    file.data.terminalSessions.push({
      ...terminal,
      id: `${workspace.id}-terminal`,
      workspaceId: workspace.id,
    });
  }

  const task = file.data.recovery.periodicConfig.tasks[0]!;
  file.data.recovery.periodicConfig.tasks.push({ ...task, id: 'healthy-task' });
  healthy.periodicTaskId = 'healthy-task';
  await target.prisma.project.create({
    data: {
      id: 'local',
      name: 'Local',
      slug: 'local',
      repoPath: '/local',
      worktreeBasePath: '/local/w',
    },
  });
  await target.prisma.periodicTask.createMany({
    data: Array.from({ length: 1002 }, (_, i) => ({
      id: i === 1001 ? task.id : `local-${i}`,
      projectId: 'local',
      name: 'Local',
      prompt: 'Keep',
      cadence: 'DAILY' as const,
      nextRunAt: new Date('2027-01-01T00:00:00.000Z'),
    })),
  });
  const localBefore = await target.prisma.periodicTask.findMany({ orderBy: { id: 'asc' } });
  let firstWrites = 0;
  state.firstWrite = (eligible, occupied) => {
    firstWrites++;
    expect(occupied?.size).toBe(1002);
    expect(occupied?.has(task.id)).toBe(true);
    expect(eligible).toEqual(new Set([healthy.id]));
  };
  state.prisma = target.prisma;
  const result = await dataBackupService.importData(exportDataSchema.parse(file));
  expect(firstWrites).toBe(2);
  expect(result.workspaces).toEqual({ imported: 1, skipped: 2 });
  expect(result.recovery.periodicConfig).toMatchObject({
    imported: 1,
    skipped: 1,
    reasons: { EXISTING_IDENTITY: 1, INCOMPLETE_DEPENDENCY: 0 },
  });
  expect(result.recovery.periodicWorkspaceLinks).toEqual({
    model: 'Workspace',
    imported: 1,
    skipped: 1,
    reasons: { INCOMPLETE_DEPENDENCY: 1 },
  });
  expect(await target.prisma.workspace.findMany()).toEqual([
    expect.objectContaining({ id: healthy.id, periodicTaskId: 'healthy-task' }),
  ]);
  expect(result.agentSessions).toEqual({ imported: 1, skipped: 2 });
  expect(result.terminalSessions).toEqual({ imported: 1, skipped: 2 });
  expect(await target.prisma.agentSession.findMany()).toEqual([
    expect.objectContaining({ workspaceId: healthy.id }),
  ]);
  expect(await target.prisma.terminalSession.findMany()).toEqual([
    expect.objectContaining({ workspaceId: healthy.id }),
  ]);
  expect(await target.prisma.workspacePR.findMany()).toEqual([
    expect.objectContaining({ workspaceId: healthy.id }),
  ]);
  expect(
    await target.prisma.periodicTask.findMany({
      where: { projectId: 'local' },
      orderBy: { id: 'asc' },
    })
  ).toEqual(localBefore);
  const targetBefore = await target.prisma.workspace.findMany({ orderBy: { id: 'asc' } });
  state.firstWrite = undefined;
  const repeat = await dataBackupService.importData(exportDataSchema.parse(file));
  expect(repeat.recovery.periodicWorkspaceLinks).toEqual({
    model: 'Workspace',
    imported: 0,
    skipped: 2,
    reasons: { INCOMPLETE_DEPENDENCY: 2 },
  });
  expect(await target.prisma.workspace.findMany({ orderBy: { id: 'asc' } })).toEqual(targetBefore);
  expect(
    await target.prisma.periodicTask.findMany({
      where: { projectId: 'local' },
      orderBy: { id: 'asc' },
    })
  ).toEqual(localBefore);
}, 30_000);

it.each(['workspace', 'session', 'pr', 'task-project'] as const)(
  'keeps local %s collision bytes and independently imports healthy links',
  async (collision) => {
    const file = structuredClone(fixed);
    const [root, , healthy] = file.data.workspaces;
    if (!(root && healthy)) {
      throw new Error('Expected literal workspace graph');
    }
    const task = file.data.recovery.periodicConfig.tasks[0]!;
    file.data.recovery.periodicConfig.tasks.push({
      ...task,
      id: 'healthy-task',
      projectId: healthy.projectId,
    });
    healthy.periodicTaskId = 'healthy-task';
    await target.prisma.project.create({
      data: {
        id: 'local',
        name: 'Local',
        slug: 'local',
        repoPath: '/local',
        worktreeBasePath: '/local/w',
      },
    });
    const local = await target.prisma.workspace.create({
      data: {
        id: collision === 'workspace' ? root.id : 'local',
        projectId: 'local',
        name: 'Keep local',
      },
    });
    if (collision === 'session') {
      await target.prisma.agentSession.create({
        data: {
          id: file.data.agentSessions[0]!.id,
          workspaceId: local.id,
          provider: 'CLAUDE',
          workflow: 'default',
        },
      });
    }
    if (collision === 'pr') {
      await target.prisma.workspacePR.create({
        data: {
          id: root.prs[0]!.id,
          workspaceId: local.id,
          url: 'https://github.com/local/local/pull/99',
        },
      });
    }
    if (collision === 'task-project') {
      await target.prisma.project.create({
        data: {
          id: task.projectId,
          name: 'Incompatible',
          slug: task.projectId,
          repoPath: '/wrong',
          worktreeBasePath: '/wrong',
        },
      });
    }
    const before = {
      workspace: await target.prisma.workspace.findUniqueOrThrow({ where: { id: local.id } }),
      sessions: await target.prisma.agentSession.findMany(),
      prs: await target.prisma.workspacePR.findMany(),
    };
    state.prisma = target.prisma;
    const result = await dataBackupService.importData(exportDataSchema.parse(file));
    expect(result.workspaces).toEqual({ imported: 1, skipped: 2 });
    expect(result.recovery.periodicWorkspaceLinks).toEqual({
      model: 'Workspace',
      imported: 1,
      skipped: 1,
      reasons: { INCOMPLETE_DEPENDENCY: 1 },
    });
    expect(await target.prisma.workspace.findUniqueOrThrow({ where: { id: local.id } })).toEqual(
      before.workspace
    );
    expect(await target.prisma.agentSession.findMany({ where: { workspaceId: local.id } })).toEqual(
      before.sessions
    );
    expect(await target.prisma.workspacePR.findMany({ where: { workspaceId: local.id } })).toEqual(
      before.prs
    );
    expect(
      await target.prisma.workspace.findUniqueOrThrow({ where: { id: healthy.id } })
    ).toHaveProperty('periodicTaskId', 'healthy-task');
  }
);

it('aborts and rolls back after actual task inserts if returned created IDs disagree with planned admission', async () => {
  let sawActualTask = false;
  state.afterRestore = async (tx, ids) => {
    expect(await tx.project.count()).toBe(2);
    expect(
      await tx.periodicTask.findUniqueOrThrow({ where: { id: 'scheduled-maintenance' } })
    ).toHaveProperty('isEnabled', false);
    sawActualTask = true;
    ids.clear();
  };
  state.prisma = target.prisma;
  await expect(dataBackupService.importData(exportDataSchema.parse(fixed))).rejects.toThrow(
    'Periodic recovery created task IDs disagree with admission'
  );
  expect(sawActualTask).toBe(true);
  expect(await target.prisma.project.count()).toBe(0);
  expect(await target.prisma.periodicTask.count()).toBe(0);
  expect(await target.prisma.workspace.count()).toBe(0);
});

it('reports an empty linked profile without adding source-null links to either count', async () => {
  const file = structuredClone(fixed);
  for (const row of file.data.workspaces) {
    row.periodicTaskId = null;
  }
  file.data.recovery.periodicConfig.tasks = [];
  state.prisma = target.prisma;
  const result = await dataBackupService.importData(exportDataSchema.parse(file));
  expect(result.workspaces).toEqual({ imported: 3, skipped: 0 });
  expect(result.recovery.periodicWorkspaceLinks).toEqual({
    model: 'Workspace',
    imported: 0,
    skipped: 0,
    reasons: { INCOMPLETE_DEPENDENCY: 0 },
  });
  expect(await target.prisma.periodicTask.count()).toBe(0);
});

it('aborts the entire import when the private link update fails rather than counting a failed write as skipped', async () => {
  state.prisma = target.prisma;
  await target.prisma.$executeRawUnsafe(
    "CREATE TRIGGER reject_link_update BEFORE UPDATE OF periodicTaskId ON Workspace WHEN NEW.periodicTaskId IS NOT NULL BEGIN SELECT RAISE(ABORT, 'link update failed'); END"
  );
  try {
    await expect(dataBackupService.importData(exportDataSchema.parse(fixed))).rejects.toThrow(
      /workspace.update/
    );
    expect(await target.prisma.project.count()).toBe(0);
    expect(await target.prisma.workspace.count()).toBe(0);
    expect(await target.prisma.periodicTask.count()).toBe(0);
  } finally {
    await target.prisma.$executeRawUnsafe('DROP TRIGGER reject_link_update');
  }
});

it.each(['section', 'capability'] as const)(
  'rejects raw unknown own-undefined %s fields before writer discovery',
  async (kind) => {
    const file = structuredClone(fixed);
    Object.assign(kind === 'section' ? file.data.recovery : file.meta.recovery.capabilities, {
      unexpected: undefined,
    });
    await expectBackupWriterUnopened(async () => {
      await expect(
        Reflect.apply(dataBackupService.importData, dataBackupService, [file])
      ).rejects.toSatisfy((error: unknown) => {
        if (!(error instanceof z.ZodError)) {
          return false;
        }
        const issues = error.issues.flatMap((issue) =>
          issue.code === 'invalid_union' ? issue.errors.flat() : [issue]
        );
        expect(issues).toContainEqual(
          expect.objectContaining({
            code: 'unrecognized_keys',
            keys: ['unexpected'],
            path: kind === 'section' ? ['data', 'recovery'] : ['meta', 'recovery', 'capabilities'],
          })
        );
        return true;
      });
    });
  }
);

it('roundtrips a configured canonical dispatch to an independently owner-created workspace project and current task', async () => {
  for (const id of ['a', 'b']) {
    await source.prisma.project.create({
      data: { id, name: id, slug: id, repoPath: `/${id}`, worktreeBasePath: `/w/${id}` },
    });
  }
  const a = await periodicTaskService.create({
    projectId: 'a',
    name: 'A',
    prompt: 'A',
    cadence: 'DAILY',
  });
  const c = await periodicTaskService.create({
    projectId: 'a',
    name: 'C',
    prompt: 'C',
    cadence: 'DAILY',
  });
  await periodicTaskService.toggleEnabled(c.id, false);
  periodicTaskService.configure({
    timerDispatch: {
      dispatchTimerEvent: async () => {
        const workspace = await service.create({
          type: 'PERIODIC_TASK',
          projectId: 'b',
          periodicTaskId: c.id,
          name: 'Independent',
          initialPrompt: 'Historical A, current C',
          ratchetEnabled: false,
        });
        return { workspaceId: workspace.id };
      },
    },
    status: { getWorkspaceStatus: async () => null },
  });
  periodicTaskService.start();
  await jobRunner.waitForCurrentRun('periodic-task-poll');
  await periodicTaskService.stop();
  const execution = await source.prisma.periodicTaskExecution.findFirstOrThrow({
    where: { periodicTaskId: a.id },
  });
  expect(execution.workspaceId).not.toBeNull();
  const workspace = await source.prisma.workspace.findUniqueOrThrow({
    where: { id: execution.workspaceId! },
  });
  expect(workspace).toMatchObject({ projectId: 'b', periodicTaskId: c.id });
  const backup = await dataBackupService.exportData('independent-history');
  state.prisma = target.prisma;
  const result = await dataBackupService.importData(backup);
  expect(result.recovery.periodicHistory).toMatchObject({ imported: 1, skipped: 0 });
  expect(
    await target.prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  ).toMatchObject({ projectId: 'b', periodicTaskId: c.id });
  expect(
    await target.prisma.periodicTaskExecution.findUniqueOrThrow({ where: { id: execution.id } })
  ).toMatchObject({
    periodicTaskId: a.id,
    workspaceId: workspace.id,
    launchSnapshot: execution.launchSnapshot,
    status: 'FAILED',
  });
});

it.each([
  'periodicTaskId',
  'workspaceId',
  'launchSnapshot',
  'canonical-project',
  'undefined',
  'unknown',
  'duplicate',
  'marker',
] as const)('rejects raw history %s before private writer discovery', async (kind) => {
  const file = structuredClone(history);
  const row = file.data.recovery.periodicHistory.executions[0]!;
  if (kind === 'periodicTaskId' || kind === 'workspaceId') {
    Object.assign(row, { [kind]: 'absent' });
  }
  if (kind === 'launchSnapshot') {
    Object.assign(row, { launchSnapshot: {} });
  }
  if (kind === 'canonical-project') {
    Object.assign(row, {
      launchSnapshot: {
        version: 1,
        projectId: 'wrong-project',
        name: 'Historical name',
        prompt: 'Historical prompt',
        cadence: 'DAILY',
        scheduledTime: null,
        timezone: null,
        scheduledDayOfMonth: null,
        dueAt: row.startedAt,
      },
    });
  }
  if (kind === 'undefined') {
    Object.assign(row, { startedAt: undefined });
  }
  if (kind === 'unknown') {
    Object.assign(row, { future: undefined });
  }
  if (kind === 'duplicate') {
    file.data.recovery.periodicHistory.executions.push({ ...row });
  }
  if (kind === 'marker') {
    Object.assign(file.data.recovery.periodicHistory, {
      jsonStorage: [
        { model: 'PeriodicTaskExecution', identity: ['absent'], field: 'launchSnapshot' },
      ],
    });
  }
  await expectBackupWriterUnopened(async () => {
    await expect(
      Reflect.apply(dataBackupService.importData, dataBackupService, [file])
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof z.ZodError)) {
        return false;
      }
      const issues = error.issues.flatMap((issue) =>
        issue.code === 'invalid_union' ? issue.errors.flat() : [issue]
      );
      if (kind === 'canonical-project') {
        expect(issues).toContainEqual({
          code: 'custom',
          message: 'Execution source dependency does not match backup',
          path: ['data', 'recovery', 'periodicHistory', 'executions', 0, 'launchSnapshot'],
        });
      }
      expect(
        issues.some((issue) => issue.path.slice(0, 3).join('.') === 'data.recovery.periodicHistory')
      ).toBe(true);
      return true;
    });
  });
});

it('imports mixed history against more than 1000 occupied identities with exclusive reasons and preserves local bytes', async () => {
  const file = structuredClone(history);
  const row = file.data.recovery.periodicHistory.executions[0]!;
  const workspace = file.data.workspaces[0]!;
  const localProject = await target.prisma.project.create({
    data: {
      id: 'local',
      name: 'Local',
      slug: 'local',
      repoPath: '/local',
      worktreeBasePath: '/local/w',
    },
  });
  await target.prisma.periodicTask.create({
    data: {
      id: 'local-task',
      projectId: localProject.id,
      name: 'Local',
      prompt: 'Local',
      cadence: 'DAILY',
      nextRunAt: new Date(),
    },
  });
  await target.prisma.workspace.create({
    data: { id: workspace.id, name: 'Local slot', projectId: 'local' },
  });
  await target.prisma.periodicTaskExecution.createMany({
    data: Array.from({ length: 1002 }, (_, i) => ({
      id: `occupied-${i}`,
      periodicTaskId: 'local-task',
      status: 'COMPLETED',
      workspaceId: i === 0 ? workspace.id : null,
    })),
  });
  const before = await target.prisma.periodicTaskExecution.findMany({ orderBy: { id: 'asc' } });
  Object.assign(file.data.recovery.periodicHistory, {
    executions: [
      { ...row, id: 'occupied-1001', workspaceId: workspace.id },
      { ...row, id: 'conflict', workspaceId: workspace.id },
      ...Array.from({ length: 1002 }, (_, i) => ({ ...row, id: `new-${i}` })),
    ],
  });
  // Duplicate source slots are forbidden independently; the existing-ID row has no slot.
  file.data.recovery.periodicHistory.executions[0]!.workspaceId = null;
  file.data.projects.push({ ...file.data.projects[0]!, id: 'local', slug: 'local' });
  file.data.recovery.periodicConfig.tasks.push({
    ...file.data.recovery.periodicConfig.tasks[0]!,
    id: 'unavailable-task',
    projectId: 'local',
  });
  file.data.recovery.periodicHistory.executions.push({
    ...row,
    id: 'missing-dependency',
    periodicTaskId: 'unavailable-task',
  });
  state.firstWrite = () => expect(state.historyPlanned).toBe(true);
  state.prisma = target.prisma;
  const result = await dataBackupService.importData(exportDataSchema.parse(file));
  expect(result.recovery.periodicHistory).toMatchObject({
    imported: 1002,
    skipped: 3,
    sourceRunning: 1005,
    restoredHistoricalFailed: 1002,
    restoredSettled: 0,
    reasons: {
      EXISTING_IDENTITY: 1,
      CONFLICTING_IDENTITY_OR_PARENT: 1,
      INCOMPLETE_DEPENDENCY: 1,
    },
  });
  expect(
    await target.prisma.periodicTaskExecution.findMany({
      where: { periodicTaskId: 'local-task' },
      orderBy: { id: 'asc' },
    })
  ).toEqual(before);
  const repeat = await dataBackupService.importData(exportDataSchema.parse(file));
  expect(repeat.recovery.periodicHistory).toMatchObject({
    imported: 0,
    skipped: 1005,
    restoredHistoricalFailed: 0,
    reasons: {
      EXISTING_IDENTITY: 1003,
      CONFLICTING_IDENTITY_OR_PARENT: 1,
      INCOMPLETE_DEPENDENCY: 1,
    },
  });
}, 30_000);

it('aborts the entire public import when actual created history owners disagree with the prewrite plan', async () => {
  const file = structuredClone(history);
  Object.assign(file.data.recovery.periodicHistory.executions[0]!, {
    workspaceId: file.data.workspaces[0]!.id,
  });
  state.prisma = target.prisma;
  state.removeActualHistoryWorkspace = true;
  await expect(dataBackupService.importData(exportDataSchema.parse(file))).rejects.toThrow(
    'Periodic history dependencies disagree with admission'
  );
  expect(await target.prisma.project.count()).toBe(0);
  expect(await target.prisma.periodicTask.count()).toBe(0);
  expect(await target.prisma.workspace.count()).toBe(0);
  expect(await target.prisma.periodicTaskExecution.count()).toBe(0);
});
