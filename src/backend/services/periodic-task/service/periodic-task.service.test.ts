import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createLogger } from '@/backend/services/logger.service';
import { WorkspaceStatus } from '@/shared/core';

const mockUpdateExecution = vi.hoisted(() => vi.fn());
const mockCreateExecution = vi.hoisted(() => vi.fn());
const mockCreateExecutionAndMarkDispatched = vi.hoisted(() => vi.fn());
const mockMarkDispatched = vi.hoisted(() => vi.fn());

vi.mock('@/backend/services/periodic-task/resources/periodic-task.accessor', () => ({
  periodicTaskAccessor: {
    createExecution: (...args: unknown[]) => mockCreateExecution(...args),
    createExecutionAndMarkDispatched: (...args: unknown[]) =>
      mockCreateExecutionAndMarkDispatched(...args),
    markDispatched: (...args: unknown[]) => mockMarkDispatched(...args),
    updateExecution: (...args: unknown[]) => mockUpdateExecution(...args),
  },
}));

import {
  PERIODIC_TASK_READY_WITHOUT_PR_GRACE_MS,
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
      workspaceId: 'workspace-1',
      status: 'RUNNING',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates the workspace before atomically creating the execution and advancing the next run', async () => {
    const createWorkspaceForTask = vi.fn().mockResolvedValue({ workspaceId: 'workspace-1' });
    const service = createServiceWithWorkspaceBridge(createWorkspaceForTask);

    await dispatchTask(service);

    expect(createWorkspaceForTask).toHaveBeenCalledWith({
      projectId: 'project-1',
      name: expect.stringContaining('Daily cleanup'),
      prompt: 'Clean up stale data',
      periodicTaskId: 'task-1',
    });
    expect(mockCreateExecutionAndMarkDispatched).toHaveBeenCalledWith(
      {
        periodicTaskId: 'task-1',
        workspaceId: 'workspace-1',
        status: 'RUNNING',
      },
      {
        cadence: 'DAILY',
        scheduledTime: '09:00',
        timezone: 'UTC',
        scheduledDayOfMonth: null,
      }
    );
    expect(mockCreateExecution).not.toHaveBeenCalled();
    expect(mockMarkDispatched).not.toHaveBeenCalled();
    const [createWorkspaceOrder] = createWorkspaceForTask.mock.invocationCallOrder;
    const [persistDispatchOrder] = mockCreateExecutionAndMarkDispatched.mock.invocationCallOrder;
    expect(createWorkspaceOrder).toBeDefined();
    expect(persistDispatchOrder).toBeDefined();
    if (createWorkspaceOrder === undefined || persistDispatchOrder === undefined) {
      throw new Error('Expected dispatch calls to have invocation order');
    }
    expect(createWorkspaceOrder).toBeLessThan(persistDispatchOrder);
  });

  it('leaves the task due when workspace creation fails', async () => {
    const createWorkspaceForTask = vi
      .fn()
      .mockRejectedValue(new Error('default session create failed'));
    const service = createServiceWithWorkspaceBridge(createWorkspaceForTask);

    await expect(dispatchTask(service)).rejects.toThrow('default session create failed');

    expect(mockCreateExecutionAndMarkDispatched).not.toHaveBeenCalled();
    expect(mockMarkDispatched).not.toHaveBeenCalled();
  });

  it('leaves the task due when dispatch persistence fails', async () => {
    const service = createServiceWithWorkspaceBridge();
    mockCreateExecutionAndMarkDispatched.mockRejectedValue(
      new Error('dispatch persistence failed')
    );

    await expect(dispatchTask(service)).rejects.toThrow('dispatch persistence failed');

    expect(mockCreateExecutionAndMarkDispatched).toHaveBeenCalled();
    expect(mockCreateExecution).not.toHaveBeenCalled();
    expect(mockMarkDispatched).not.toHaveBeenCalled();
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
