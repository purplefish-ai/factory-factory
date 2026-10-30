import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindUnique = vi.hoisted(() => vi.fn());
const mockUpdateMany = vi.hoisted(() => vi.fn());

vi.mock('@/backend/db', () => ({
  prisma: {
    workspace: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      findUniqueOrThrow: (...args: unknown[]) => mockFindUnique(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    },
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { getWorkspaceInitPolicy, workspaceStateMachine } from '@/backend/services/workspace';
import { workspaceInitRouter } from './init.trpc';

const readyWithWarningButNoWorktree = {
  id: 'w1',
  status: 'READY' as const,
  worktreePath: null,
  initErrorMessage: 'Setup script failed',
  initRetryCount: 0,
  branchName: 'feature/x',
  project: { id: 'p1', worktreeBasePath: '/tmp/worktrees' },
};

const initializeWorkspaceWorktree = vi.fn(async () => undefined);

function createCaller() {
  return workspaceInitRouter.createCaller({
    appContext: {
      services: {
        createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
        workspaceDataService: {
          findByIdWithProject: vi.fn(async () => readyWithWarningButNoWorktree),
          findById: vi.fn(async () => readyWithWarningButNoWorktree),
        },
        // Real state machine: its transition rules are the contract the router relies on.
        workspaceStateMachine,
        worktreeLifecycleService: {
          getInitMode: vi.fn(async () => undefined),
          setInitMode: vi.fn(async () => undefined),
        },
        initializeWorkspaceWorktree,
        retryQueuedDispatchAfterWorkspaceReady: vi.fn(async () => undefined),
        executeStartupScriptPipeline: vi.fn(async () => ({ handled: true })),
        factoryConfigService: { readConfig: vi.fn(async () => null) },
      },
    },
  } as never);
}

describe('workspaceInitRouter.retryInit with the workspace state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUnique.mockResolvedValue(readyWithWarningButNoWorktree);
    mockUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('recreates the missing worktree of a READY workspace whose banner offers retry', async () => {
    const policy = getWorkspaceInitPolicy(readyWithWarningButNoWorktree);
    expect(policy.phase).toBe('BLOCKED_FAILED');
    expect(policy.banner?.showRetry).toBe(true);

    await expect(createCaller().retryInit({ id: 'w1' })).resolves.toMatchObject({ id: 'w1' });

    // READY -> PROVISIONING is a valid transition; READY -> NEW is not.
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'w1', status: 'READY' }),
        data: expect.objectContaining({ status: 'PROVISIONING' }),
      })
    );
    expect(initializeWorkspaceWorktree).toHaveBeenCalledWith('w1', {
      branchName: 'feature/x',
      useExistingBranch: undefined,
      provisioningAlreadyStarted: true,
    });
  });
});
