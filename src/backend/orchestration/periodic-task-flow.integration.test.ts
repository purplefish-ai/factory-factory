import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobRunner } from '@/backend/services/job-runner.service';
import { createLogger } from '@/backend/services/logger.service';
import { PeriodicTaskService, type PeriodicTaskTimerEvent } from '@/backend/services/periodic-task';
import { sessionDataService } from '@/backend/services/session';
import { WorkspaceCreationService } from '@/backend/services/workspace';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { PrismaClient } from '@prisma-gen/client';
import { dispatchBackgroundAction } from './background-action-dispatch.orchestrator';
import { launchWorkspace, type PeriodicTaskLaunchSource } from './workspace-launch.orchestrator';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!state.prisma) {
      throw new Error('Missing test database');
    }
    return state.prisma;
  },
}));

const logger = createLogger('periodic-task-flow-test');
let db: IntegrationDatabase;
let service: PeriodicTaskService;
const events: PeriodicTaskTimerEvent[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function configure(
  launch: (source: PeriodicTaskLaunchSource) => Promise<{ workspace: { id: string } }>
): void {
  service.configure({
    timerDispatch: {
      dispatchTimerEvent(event) {
        events.push(event);
        return dispatchBackgroundAction(
          { target: 'new_workspace', event },
          { launchWorkspace: launch }
        );
      },
    },
    status: { getWorkspaceStatus: () => Promise.resolve(null) },
  });
}

function createTask(name = 'Daily cleanup') {
  return service.create({
    projectId: 'project',
    name,
    prompt: 'Clean up stale data',
    cadence: 'DAILY',
  });
}

async function runCycle() {
  service.start();
  await jobRunner.waitForCurrentRun('periodic-task-poll');
  await service.stop();
}

beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: '/repo',
      worktreeBasePath: '/worktrees',
    },
  });
}, 30_000);

beforeEach(() => {
  events.length = 0;
  service = new PeriodicTaskService(logger);
});

afterEach(async () => {
  await service.stop();
  await db.prisma.workspace.deleteMany();
  await db.prisma.periodicTask.deleteMany();
});

afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

describe('due periodic tasks through shared dispatch', () => {
  it('creates one fresh ordinary workspace, conversation and history row for each admitted run', async () => {
    const creation = new WorkspaceCreationService({ logger });
    const initializeWorktree = vi.fn(() => Promise.resolve());
    configure((source) =>
      launchWorkspace(source, {
        createWorkspace: (input) => creation.create(input),
        createDefaultSession: (input) => sessionDataService.createAgentSession(input),
        initializeWorktree,
        getMaxSessionsPerWorkspace: () => {
          throw new Error('Unexpected capacity gate');
        },
        resolveProvider: () => {
          throw new Error('Unexpected provider preflight');
        },
        getLaunchOptions: () => {
          throw new Error('Unexpected launch discovery');
        },
        checkCliHealth: () => {
          throw new Error('Unexpected CLI preflight');
        },
        logger,
      })
    );
    const task = await createTask();

    await runCycle();
    expect(events).toHaveLength(1);
    const history = await service.listExecutions(task.id);
    expect(history).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'timer_due',
      executionId: history[0]?.id,
      periodicTaskId: task.id,
      projectId: 'project',
      name: expect.stringContaining('Daily cleanup'),
      prompt: 'Clean up stale data',
    });
    const first = await db.prisma.workspace.findUniqueOrThrow({
      where: { id: history[0]?.workspaceId ?? '' },
      include: { agentSessions: true },
    });
    expect(first).toMatchObject({
      projectId: 'project',
      periodicTaskId: task.id,
      creationSource: 'PERIODIC_TASK',
      parentWorkspaceId: null,
      creationMetadata: { initialPrompt: 'Clean up stale data' },
      agentSessions: [
        expect.objectContaining({
          workflow: 'periodic-task',
          name: 'Agent',
          providerSessionId: null,
        }),
      ],
    });
    expect((await service.get(task.id))?.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(await db.prisma.workspacePREvent.count()).toBe(0);

    // A later cadence admission must create another workspace and conversation.
    await db.prisma.periodicTaskExecution.update({
      where: { id: history[0]?.id },
      data: { status: 'PR_CREATED' },
    });
    await db.prisma.periodicTask.update({
      where: { id: task.id },
      data: { nextRunAt: new Date(0) },
    });
    await runCycle();
    const nextHistory = await service.listExecutions(task.id);
    expect(nextHistory).toHaveLength(2);
    expect(new Set(nextHistory.map((run) => run.workspaceId)).size).toBe(2);
    expect(await db.prisma.workspace.count()).toBe(2);
    const sessions = await db.prisma.agentSession.findMany();
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((session) => session.workspaceId)).size).toBe(2);
    expect(initializeWorktree).toHaveBeenCalledTimes(2);
  });

  it('retains failed admission and its advanced schedule when a project archives before workspace insertion', async () => {
    const task = await createTask();
    const creation = new WorkspaceCreationService({ logger });
    configure(async (source) => {
      await db.prisma.project.update({ where: { id: 'project' }, data: { isArchived: true } });
      return { workspace: await creation.create(source) };
    });
    try {
      await runCycle();
      expect(events).toHaveLength(1);
      expect(await db.prisma.workspace.count()).toBe(0);
      expect(await service.listExecutions(task.id)).toEqual([
        expect.objectContaining({
          status: 'FAILED',
          workspaceId: null,
          errorMessage: 'Cannot create a workspace in an archived project',
        }),
      ]);
      const admitted = await db.prisma.periodicTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(admitted.lastRunAt).toBeInstanceOf(Date);
      expect(admitted.nextRunAt.getTime()).toBeGreaterThan(task.nextRunAt.getTime());
      await db.prisma.project.update({ where: { id: 'project' }, data: { isArchived: false } });
      await runCycle();
      expect(events).toHaveLength(1);
      expect(await db.prisma.periodicTaskExecution.count()).toBe(1);
      expect(
        (await db.prisma.periodicTask.findUniqueOrThrow({ where: { id: task.id } })).nextRunAt
      ).toEqual(admitted.nextRunAt);
    } finally {
      await db.prisma.project.update({ where: { id: 'project' }, data: { isArchived: false } });
    }
  });

  it.each(['disabled', 'not due', 'running predecessor', 'lost claim'] as const)(
    'dispatches nothing for a stale due snapshot with %s',
    async (condition) => {
      const launch = vi.fn();
      configure(launch);
      const stale = await createTask();
      if (condition === 'disabled') {
        await service.toggleEnabled(stale.id, false);
      } else if (condition === 'not due' || condition === 'lost claim') {
        await db.prisma.periodicTask.update({
          where: { id: stale.id },
          data: { nextRunAt: new Date(Date.now() + 86_400_000) },
        });
      }
      if (condition === 'running predecessor' || condition === 'lost claim') {
        await db.prisma.periodicTaskExecution.create({
          data: { periodicTaskId: stale.id, status: 'RUNNING' },
        });
      }
      if (condition === 'lost claim') {
        // The overlap precheck raced with a competing successful reservation.
        vi.spyOn(db.prisma.periodicTaskExecution, 'count').mockResolvedValueOnce(0);
      }
      // Model a task changing after the poll read but before its claim.
      vi.spyOn(db.prisma.periodicTask, 'findMany').mockResolvedValueOnce([stale]);

      await runCycle();

      expect(events).toEqual([]);
      expect(launch).not.toHaveBeenCalled();
      expect(await service.listExecutions(stale.id)).toHaveLength(
        condition === 'running predecessor' || condition === 'lost claim' ? 1 : 0
      );
    }
  );

  it('never replays an unlinked reservation on restart and fails it only after 15 minutes', async () => {
    const task = await createTask();
    const startedAt = new Date();
    const reserved = await db.prisma.periodicTaskExecution.create({
      data: { periodicTaskId: task.id, status: 'RUNNING', startedAt },
    });
    const launch = vi.fn();
    configure(launch);
    await runCycle();
    service = new PeriodicTaskService(logger);
    configure(launch);
    await runCycle();
    expect(await service.listExecutions(task.id)).toEqual([
      expect.objectContaining({ id: reserved.id, status: 'RUNNING', workspaceId: null }),
    ]);

    await db.prisma.periodicTaskExecution.update({
      where: { id: reserved.id },
      data: { startedAt: new Date(Date.now() - 15 * 60_000) },
    });
    await runCycle();

    expect(events).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
    expect(await service.listExecutions(task.id)).toEqual([
      expect.objectContaining({
        id: reserved.id,
        status: 'FAILED',
        workspaceId: null,
        errorMessage: 'Workspace reservation did not link a workspace before timeout',
        completedAt: expect.any(Date),
      }),
    ]);
  });

  it('stops before reservation when the overlap lookup is still pending', async () => {
    const task = await createTask();
    const creation = new WorkspaceCreationService({ logger });
    const launch = vi.fn((source: PeriodicTaskLaunchSource) =>
      creation.create(source).then((workspace) => ({ workspace }))
    );
    configure(launch);
    const lookupStarted = deferred<void>();
    const overlap = deferred<number>();
    vi.spyOn(db.prisma.periodicTaskExecution, 'count').mockImplementationOnce(() => {
      lookupStarted.resolve();
      return unsafeCoerce<ReturnType<typeof db.prisma.periodicTaskExecution.count>>(
        overlap.promise
      );
    });
    const reserve = vi.spyOn(db.prisma, '$transaction');
    service.start();
    await lookupStarted.promise;

    const stop = service.stop();
    overlap.resolve(0);
    await stop;

    expect(reserve).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
    expect(await db.prisma.periodicTaskExecution.count()).toBe(0);
    expect(await db.prisma.workspace.count()).toBe(0);
    expect(await service.get(task.id)).toMatchObject({
      nextRunAt: task.nextRunAt,
      lastRunAt: null,
    });
  });

  it('drains an admitted launch and its link on stop, without admitting the next due task', async () => {
    await createTask('First');
    await createTask('Second');
    const admitted = deferred<void>();
    const finish = deferred<{ workspace: { id: string } }>();
    configure(() => {
      admitted.resolve();
      return finish.promise;
    });
    service.start();
    await admitted.promise;
    const taskId = events[0]?.periodicTaskId;
    if (!taskId) {
      throw new Error('Expected an admitted timer event');
    }
    const reserved = await service.listExecutions(taskId);
    expect(reserved).toEqual([expect.objectContaining({ workspaceId: null, status: 'RUNNING' })]);
    let stopped = false;
    const stop = service.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    const workspace = await db.prisma.workspace.create({
      data: { projectId: 'project', name: 'Admitted workspace', periodicTaskId: taskId },
    });
    finish.resolve({ workspace });
    await stop;

    expect(stopped).toBe(true);
    expect(events).toHaveLength(1);
    expect(await service.listExecutions(taskId)).toEqual([
      expect.objectContaining({ workspaceId: workspace.id, status: 'RUNNING' }),
    ]);
    expect(await db.prisma.periodicTaskExecution.count()).toBe(1);
  });
});
