import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunStartupScript = vi.hoisted(() => vi.fn());
const mockFindByIdWithProject = vi.hoisted(() => vi.fn());
const mockFindById = vi.hoisted(() => vi.fn());
const mockResetToNew = vi.hoisted(() => vi.fn());
const mockStartProvisioning = vi.hoisted(() => vi.fn());
const mockGetInitMode = vi.hoisted(() => vi.fn());
const mockSetInitMode = vi.hoisted(() => vi.fn());
const mockGetWorkspaceInitPolicy = vi.hoisted(() => vi.fn());
const mockInitializeWorkspaceWorktree = vi.hoisted(() => vi.fn());

vi.mock('@/backend/domains/run-script', () => ({
  startupScriptService: {
    runStartupScript: (...args: unknown[]) => mockRunStartupScript(...args),
  },
}));

vi.mock('@/backend/domains/workspace', () => ({
  workspaceDataService: {
    findByIdWithProject: (...args: unknown[]) => mockFindByIdWithProject(...args),
    findById: (...args: unknown[]) => mockFindById(...args),
  },
  workspaceStateMachine: {
    resetToNew: (...args: unknown[]) => mockResetToNew(...args),
    startProvisioning: (...args: unknown[]) => mockStartProvisioning(...args),
  },
  worktreeLifecycleService: {
    getInitMode: (...args: unknown[]) => mockGetInitMode(...args),
    setInitMode: (...args: unknown[]) => mockSetInitMode(...args),
  },
  getWorkspaceInitPolicy: (...args: unknown[]) => mockGetWorkspaceInitPolicy(...args),
}));

vi.mock('@/backend/orchestration/workspace-init.orchestrator', () => ({
  initializeWorkspaceWorktree: (...args: unknown[]) => mockInitializeWorkspaceWorktree(...args),
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { workspaceInitRouter } from './init.trpc';

function createCaller() {
  return workspaceInitRouter.createCaller({ appContext: {} } as never);
}

describe('workspaceInitRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInitializeWorkspaceWorktree.mockResolvedValue(undefined);
    mockRunStartupScript.mockResolvedValue({ success: true });
  });

  it('returns initialization status with policy fields', async () => {
    mockFindByIdWithProject.mockResolvedValue({
      id: 'w1',
      status: 'FAILED',
      initErrorMessage: 'boom',
      initOutput: 'out',
      initStartedAt: new Date('2026-01-01T00:00:00.000Z'),
      initCompletedAt: null,
      worktreePath: null,
      project: { startupScriptCommand: 'pnpm dev', startupScriptPath: null },
    });
    mockGetWorkspaceInitPolicy.mockReturnValue({ phase: 'FAILED', banner: 'retry' });

    const caller = createCaller();
    await expect(caller.getInitStatus({ id: 'w1' })).resolves.toEqual({
      status: 'FAILED',
      initErrorMessage: 'boom',
      initOutput: 'out',
      initStartedAt: new Date('2026-01-01T00:00:00.000Z'),
      initCompletedAt: null,
      phase: 'FAILED',
      chatBanner: 'retry',
      hasStartupScript: true,
      hasWorktreePath: false,
    });
  });

  it('retries full initialization when worktree is missing', async () => {
    mockFindByIdWithProject.mockResolvedValue({
      id: 'w1',
      status: 'FAILED',
      worktreePath: null,
      branchName: 'feature/x',
      project: { worktreeBasePath: '/tmp/worktrees' },
    });
    mockResetToNew.mockResolvedValue({ id: 'w1', status: 'NEW' });
    mockGetInitMode.mockResolvedValue(true);
    mockFindById.mockResolvedValue({ id: 'w1', status: 'NEW' });

    const caller = createCaller();
    await expect(caller.retryInit({ id: 'w1' })).resolves.toEqual({ id: 'w1', status: 'NEW' });

    expect(mockResetToNew).toHaveBeenCalledWith('w1', 3);
    expect(mockSetInitMode).toHaveBeenCalledWith('w1', true);

    await Promise.resolve();
    expect(mockInitializeWorkspaceWorktree).toHaveBeenCalledWith('w1', {
      branchName: 'feature/x',
      useExistingBranch: true,
    });
  });

  it('retries startup script when worktree exists', async () => {
    const workspace = {
      id: 'w2',
      status: 'FAILED',
      worktreePath: '/tmp/w2',
      project: { id: 'p1' },
    };
    mockFindByIdWithProject.mockResolvedValue(workspace);
    mockStartProvisioning.mockResolvedValue({ status: 'PROVISIONING' });
    mockFindById.mockResolvedValue({ id: 'w2', status: 'READY' });

    const caller = createCaller();
    await expect(caller.retryInit({ id: 'w2' })).resolves.toEqual({ id: 'w2', status: 'READY' });

    expect(mockStartProvisioning).toHaveBeenCalledWith('w2', { maxRetries: 3 });
    expect(mockRunStartupScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'w2', status: 'PROVISIONING' }),
      workspace.project
    );
  });

  it('validates retry preconditions', async () => {
    const caller = createCaller();

    mockFindByIdWithProject.mockResolvedValue(null);
    await expect(caller.retryInit({ id: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    mockFindByIdWithProject.mockResolvedValue({
      id: 'w1',
      status: 'READY',
      project: { worktreeBasePath: '/tmp' },
      worktreePath: null,
    });
    await expect(caller.retryInit({ id: 'w1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    mockFindByIdWithProject.mockResolvedValue({
      id: 'w1',
      status: 'FAILED',
      project: { worktreeBasePath: '/tmp' },
      worktreePath: null,
    });
    mockResetToNew.mockResolvedValue(null);
    await expect(caller.retryInit({ id: 'w1' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });
});
