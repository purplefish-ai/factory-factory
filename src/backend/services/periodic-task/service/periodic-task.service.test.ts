import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createLogger } from '@/backend/services/logger.service';
import { WorkspaceStatus } from '@/shared/core';

const mockUpdateExecution = vi.hoisted(() => vi.fn());

vi.mock('@/backend/services/periodic-task/resources/periodic-task.accessor', () => ({
  periodicTaskAccessor: {
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
  });

  afterEach(() => {
    vi.useRealTimers();
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
