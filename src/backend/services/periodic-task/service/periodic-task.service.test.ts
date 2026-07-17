import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createLogger } from '@/backend/services/logger.service';
import { WorkspaceStatus } from '@/shared/core';

const mockUpdateExecution = vi.hoisted(() => vi.fn());
const mockCreateExecution = vi.hoisted(() => vi.fn());
const mockCreateExecutionAndMarkDispatched = vi.hoisted(() => vi.fn());
const mockMarkDispatched = vi.hoisted(() => vi.fn());
const mockListByProject = vi.hoisted(() => vi.fn());
const mockFindById = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());
const mockToggleEnabled = vi.hoisted(() => vi.fn());
const mockListExecutions = vi.hoisted(() => vi.fn());
const mockListExecutionsByWorkspacePeriodicTask = vi.hoisted(() => vi.fn());

vi.mock('@/backend/services/periodic-task/resources/periodic-task.accessor', () => ({
  periodicTaskAccessor: {
    listByProject: (...args: unknown[]) => mockListByProject(...args),
    findById: (...args: unknown[]) => mockFindById(...args),
    create: (...args: unknown[]) => mockCreate(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    toggleEnabled: (...args: unknown[]) => mockToggleEnabled(...args),
    listExecutions: (...args: unknown[]) => mockListExecutions(...args),
    listExecutionsByWorkspacePeriodicTask: (...args: unknown[]) =>
      mockListExecutionsByWorkspacePeriodicTask(...args),
    createExecution: (...args: unknown[]) => mockCreateExecution(...args),
    createExecutionAndMarkDispatched: (...args: unknown[]) =>
      mockCreateExecutionAndMarkDispatched(...args),
    markDispatched: (...args: unknown[]) => mockMarkDispatched(...args),
    updateExecution: (...args: unknown[]) => mockUpdateExecution(...args),
  },
}));

import {
  PERIODIC_TASK_READY_WITHOUT_PR_GRACE_MS,
  PERIODIC_TASK_WORKSPACE_RESERVATION_TIMEOUT_MS,
  PeriodicTaskService,
} from './periodic-task.service';

type Logger = ReturnType<typeof createLogger>;
const now = new Date('2026-05-20T12:00:00Z');
const logger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

async function checkSingleExecution(
  service: PeriodicTaskService,
  execution: {
    id: string;
    workspaceId: string | null;
    startedAt: Date;
  }
): Promise<void> {
  const method = Reflect.get(service, 'checkSingleExecution') as (execution: {
    id: string;
    workspaceId: string | null;
    startedAt: Date;
  }) => Promise<void>;
  await method.call(service, execution);
}

async function dispatchTask(
  service: PeriodicTaskService,
  params: {
    taskId?: string;
    projectId?: string;
    name?: string;
    prompt?: string;
  } = {}
): Promise<void> {
  const method = Reflect.get(service, 'dispatchTask') as (
    taskId: string,
    projectId: string,
    name: string,
    prompt: string,
    cadence: 'DAILY',
    scheduledTime: string | null,
    timezone: string | null,
    scheduledDayOfMonth: number | null
  ) => Promise<void>;
  await method.call(
    service,
    params.taskId ?? 'task-1',
    params.projectId ?? 'project-1',
    params.name ?? 'Daily cleanup',
    params.prompt ?? 'Clean up stale data',
    'DAILY',
    '09:00',
    'UTC',
    null
  );
}

function createServiceWithWorkspaceBridge(
  createWorkspaceForTask = vi.fn().mockResolvedValue({ workspaceId: 'workspace-1' })
): PeriodicTaskService {
  const service = new PeriodicTaskService(logger);
  service.configure({
    workspace: {
      createWorkspaceForTask,
    },
    status: {
      getWorkspaceStatus: vi.fn(),
    },
  });
  return service;
}

function createServiceWithWorkspaceStatus(status: {
  status: WorkspaceStatus;
  prUrl: string | null;
  prNumber: number | null;
  isAgentWorking: boolean;
  initCompletedAt?: Date | null;
}): PeriodicTaskService {
  const service = new PeriodicTaskService(logger);
  service.configure({
    workspace: {
      createWorkspaceForTask: vi.fn(),
    },
    status: {
      getWorkspaceStatus: vi.fn().mockResolvedValue({
        initCompletedAt: now,
        ...status,
      }),
    },
  });
  return service;
}

describe('PeriodicTaskService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockCreateExecution.mockResolvedValue({
      id: 'exec-1',
      periodicTaskId: 'task-1',
      workspaceId: 'workspace-1',
      status: 'RUNNING',
    });
    mockCreateExecutionAndMarkDispatched.mockResolvedValue({
      id: 'exec-1',
      periodicTaskId: 'task-1',
      workspaceId: null,
      status: 'RUNNING',
    });
    mockUpdateExecution.mockResolvedValue({
      id: 'exec-1',
      periodicTaskId: 'task-1',
      workspaceId: 'workspace-1',
      status: 'RUNNING',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists periodic tasks for a project', async () => {
    const service = new PeriodicTaskService(logger);

    await service.list('project-1');

    expect(mockListByProject).toHaveBeenCalledWith('project-1');
  });

  it('gets a periodic task by id', async () => {
    const service = new PeriodicTaskService(logger);

    await service.get('task-1');

    expect(mockFindById).toHaveBeenCalledWith('task-1');
  });

  it('creates a periodic task', async () => {
    const service = new PeriodicTaskService(logger);
    const input = {
      projectId: 'project-1',
      name: 'Daily cleanup',
      prompt: 'Clean up stale data',
      cadence: 'DAILY' as const,
      scheduledTime: '09:00',
      timezone: 'UTC',
    };

    await service.create(input);

    expect(mockCreate).toHaveBeenCalledWith(input);
  });

  it('updates a periodic task', async () => {
    const service = new PeriodicTaskService(logger);
    const input = {
      name: 'Weekly cleanup',
      prompt: 'Clean up stale data weekly',
      cadence: 'WEEKLY' as const,
      scheduledTime: '10:00',
      timezone: 'America/New_York',
    };

    await service.update('task-1', input);

    expect(mockUpdate).toHaveBeenCalledWith('task-1', input);
  });

  it('deletes a periodic task', async () => {
    const service = new PeriodicTaskService(logger);

    await service.delete('task-1');

    expect(mockDelete).toHaveBeenCalledWith('task-1');
  });

  it('toggles whether a periodic task is enabled', async () => {
    const service = new PeriodicTaskService(logger);

    await service.toggleEnabled('task-1', true);

    expect(mockToggleEnabled).toHaveBeenCalledWith('task-1', true);
  });

  it('lists periodic task executions with an explicit limit', async () => {
    const service = new PeriodicTaskService(logger);

    await service.listExecutions('task-1', 7);

    expect(mockListExecutions).toHaveBeenCalledWith('task-1', 7);
  });

  it('defaults the periodic task execution limit to 20', async () => {
    const service = new PeriodicTaskService(logger);

    await service.listExecutions('task-1');

    expect(mockListExecutions).toHaveBeenCalledWith('task-1', 20);
  });

  it('lists executions by periodic task id', async () => {
    const service = new PeriodicTaskService(logger);

    await service.listExecutionsByPeriodicTaskId('task-1');

    expect(mockListExecutionsByWorkspacePeriodicTask).toHaveBeenCalledWith('task-1');
  });

  it('reserves the execution and advances the next run before creating the workspace', async () => {
    const createWorkspaceForTask = vi.fn().mockResolvedValue({ workspaceId: 'workspace-1' });
    const service = createServiceWithWorkspaceBridge(createWorkspaceForTask);

    await dispatchTask(service);

    expect(mockCreateExecutionAndMarkDispatched).toHaveBeenCalledWith(
      {
        periodicTaskId: 'task-1',
        workspaceId: null,
        status: 'RUNNING',
      },
      {
        cadence: 'DAILY',
        scheduledTime: '09:00',
        timezone: 'UTC',
        scheduledDayOfMonth: null,
      }
    );
    expect(createWorkspaceForTask).toHaveBeenCalledWith({
      projectId: 'project-1',
      name: expect.stringContaining('Daily cleanup'),
      prompt: 'Clean up stale data',
      periodicTaskId: 'task-1',
    });
    expect(mockUpdateExecution).toHaveBeenCalledWith('exec-1', {
      workspaceId: 'workspace-1',
    });
    expect(mockCreateExecution).not.toHaveBeenCalled();
    expect(mockMarkDispatched).not.toHaveBeenCalled();
    const [persistDispatchOrder] = mockCreateExecutionAndMarkDispatched.mock.invocationCallOrder;
    const [createWorkspaceOrder] = createWorkspaceForTask.mock.invocationCallOrder;
    expect(persistDispatchOrder).toBeDefined();
    expect(createWorkspaceOrder).toBeDefined();
    if (persistDispatchOrder === undefined || createWorkspaceOrder === undefined) {
      throw new Error('Expected dispatch calls to have invocation order');
    }
    expect(persistDispatchOrder).toBeLessThan(createWorkspaceOrder);
  });

  it('marks the reserved execution failed when workspace creation fails', async () => {
    const createWorkspaceForTask = vi
      .fn()
      .mockRejectedValue(new Error('default session create failed'));
    const service = createServiceWithWorkspaceBridge(createWorkspaceForTask);

    await expect(dispatchTask(service)).rejects.toThrow('default session create failed');

    expect(mockCreateExecutionAndMarkDispatched).toHaveBeenCalled();
    expect(mockUpdateExecution).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({
        status: 'FAILED',
        errorMessage: 'default session create failed',
        completedAt: expect.any(Date),
      })
    );
    expect(mockMarkDispatched).not.toHaveBeenCalled();
  });

  it('does not create a workspace when dispatch reservation fails', async () => {
    const createWorkspaceForTask = vi.fn().mockResolvedValue({ workspaceId: 'workspace-1' });
    const service = createServiceWithWorkspaceBridge(createWorkspaceForTask);
    mockCreateExecutionAndMarkDispatched.mockRejectedValue(
      new Error('dispatch persistence failed')
    );

    await expect(dispatchTask(service)).rejects.toThrow('dispatch persistence failed');

    expect(mockCreateExecutionAndMarkDispatched).toHaveBeenCalled();
    expect(createWorkspaceForTask).not.toHaveBeenCalled();
    expect(mockCreateExecution).not.toHaveBeenCalled();
    expect(mockMarkDispatched).not.toHaveBeenCalled();
  });

  it('marks stale workspace reservations as failed', async () => {
    const service = createServiceWithWorkspaceStatus({
      status: WorkspaceStatus.READY,
      prUrl: null,
      prNumber: null,
      isAgentWorking: false,
    });

    await checkSingleExecution(service, {
      id: 'exec-1',
      workspaceId: null,
      startedAt: new Date(Date.now() - PERIODIC_TASK_WORKSPACE_RESERVATION_TIMEOUT_MS - 1),
    });

    expect(mockUpdateExecution).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({
        status: 'FAILED',
        errorMessage: 'Workspace reservation did not link a workspace before timeout',
        completedAt: expect.any(Date),
      })
    );
  });

  it('keeps recent workspace reservations running while workspace creation may still be in flight', async () => {
    const service = createServiceWithWorkspaceStatus({
      status: WorkspaceStatus.READY,
      prUrl: null,
      prNumber: null,
      isAgentWorking: false,
    });

    await checkSingleExecution(service, {
      id: 'exec-1',
      workspaceId: null,
      startedAt: new Date(Date.now() - PERIODIC_TASK_WORKSPACE_RESERVATION_TIMEOUT_MS + 1),
    });

    expect(mockUpdateExecution).not.toHaveBeenCalled();
  });

  it('marks stale READY executions without PR or active agent work as failed', async () => {
    const service = createServiceWithWorkspaceStatus({
      status: WorkspaceStatus.READY,
      prUrl: null,
      prNumber: null,
      isAgentWorking: false,
      initCompletedAt: new Date(Date.now() - PERIODIC_TASK_READY_WITHOUT_PR_GRACE_MS - 1),
    });

    await checkSingleExecution(service, {
      id: 'exec-1',
      workspaceId: 'ws-1',
      startedAt: new Date(Date.now() - PERIODIC_TASK_READY_WITHOUT_PR_GRACE_MS - 1),
    });

    expect(mockUpdateExecution).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({
        status: 'FAILED',
        errorMessage: 'Workspace is READY without a PR and no agent work is active',
        completedAt: expect.any(Date),
      })
    );
  });

  it('keeps recent READY executions without PR running during the grace period', async () => {
    const service = createServiceWithWorkspaceStatus({
      status: WorkspaceStatus.READY,
      prUrl: null,
      prNumber: null,
      isAgentWorking: false,
      initCompletedAt: new Date(Date.now() - PERIODIC_TASK_READY_WITHOUT_PR_GRACE_MS + 1),
    });

    await checkSingleExecution(service, {
      id: 'exec-1',
      workspaceId: 'ws-1',
      startedAt: new Date(Date.now() - PERIODIC_TASK_READY_WITHOUT_PR_GRACE_MS - 1),
    });

    expect(mockUpdateExecution).not.toHaveBeenCalled();
  });

  it('does not count provisioning time against the READY without PR grace period', async () => {
    const service = createServiceWithWorkspaceStatus({
      status: WorkspaceStatus.READY,
      prUrl: null,
      prNumber: null,
      isAgentWorking: false,
      initCompletedAt: new Date(Date.now() - 1),
    });

    await checkSingleExecution(service, {
      id: 'exec-1',
      workspaceId: 'ws-1',
      startedAt: new Date(Date.now() - PERIODIC_TASK_READY_WITHOUT_PR_GRACE_MS - 1),
    });

    expect(mockUpdateExecution).not.toHaveBeenCalled();
  });

  it('keeps READY executions running when workspace readiness time is unavailable', async () => {
    const service = createServiceWithWorkspaceStatus({
      status: WorkspaceStatus.READY,
      prUrl: null,
      prNumber: null,
      isAgentWorking: false,
      initCompletedAt: null,
    });

    await checkSingleExecution(service, {
      id: 'exec-1',
      workspaceId: 'ws-1',
      startedAt: new Date(Date.now() - PERIODIC_TASK_READY_WITHOUT_PR_GRACE_MS - 1),
    });

    expect(mockUpdateExecution).not.toHaveBeenCalled();
  });

  it('keeps READY executions running while agent work is active', async () => {
    const service = createServiceWithWorkspaceStatus({
      status: WorkspaceStatus.READY,
      prUrl: null,
      prNumber: null,
      isAgentWorking: true,
      initCompletedAt: new Date(Date.now() - PERIODIC_TASK_READY_WITHOUT_PR_GRACE_MS - 1),
    });

    await checkSingleExecution(service, {
      id: 'exec-1',
      workspaceId: 'ws-1',
      startedAt: new Date(Date.now() - PERIODIC_TASK_READY_WITHOUT_PR_GRACE_MS - 1),
    });

    expect(mockUpdateExecution).not.toHaveBeenCalled();
  });

  it('marks executions with PRs as PR_CREATED', async () => {
    const service = createServiceWithWorkspaceStatus({
      status: WorkspaceStatus.READY,
      prUrl: 'https://github.com/purplefish-ai/factory-factory/pull/1',
      prNumber: 1,
      isAgentWorking: false,
    });

    await checkSingleExecution(service, {
      id: 'exec-1',
      workspaceId: 'ws-1',
      startedAt: new Date(Date.now() - PERIODIC_TASK_READY_WITHOUT_PR_GRACE_MS - 1),
    });

    expect(mockUpdateExecution).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({
        status: 'PR_CREATED',
        prUrl: 'https://github.com/purplefish-ai/factory-factory/pull/1',
        prNumber: 1,
        completedAt: expect.any(Date),
      })
    );
  });
});
