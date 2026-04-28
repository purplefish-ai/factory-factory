import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunStartupScript = vi.hoisted(() => vi.fn());
const mockFindByIdWithProject = vi.hoisted(() => vi.fn());
const mockFindById = vi.hoisted(() => vi.fn());
const mockResetToNew = vi.hoisted(() => vi.fn());
const mockStartProvisioning = vi.hoisted(() => vi.fn());
const mockStartProvisioningFromReady = vi.hoisted(() => vi.fn());
const mockGetInitMode = vi.hoisted(() => vi.fn());
const mockSetInitMode = vi.hoisted(() => vi.fn());
const mockGetWorkspaceInitPolicy = vi.hoisted(() => vi.fn());
const mockInitializeWorkspaceWorktree = vi.hoisted(() => vi.fn());
const mockExecuteStartupScriptPipeline = vi.hoisted(() => vi.fn());
const mockReadConfig = vi.hoisted(() => vi.fn());

vi.mock('@/backend/services/run-script', () => ({
  startupScriptService: {
    runStartupScript: (...args: unknown[]) => mockRunStartupScript(...args),
  },
}));

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: {
    findByIdWithProject: (...args: unknown[]) => mockFindByIdWithProject(...args),
    findById: (...args: unknown[]) => mockFindById(...args),
  },
  workspaceStateMachine: {
    resetToNew: (...args: unknown[]) => mockResetToNew(...args),
    startProvisioning: (...args: unknown[]) => mockStartProvisioning(...args),
    startProvisioningFromReady: (...args: unknown[]) => mockStartProvisioningFromReady(...args),
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

vi.mock('@/backend/orchestration/workspace-init-script-pipeline', () => ({
  executeStartupScriptPipeline: (...args: unknown[]) => mockExecuteStartupScriptPipeline(...args),
}));

vi.mock('@/backend/services/factory-config.service', () => ({
  FactoryConfigService: {
    readConfig: (...args: unknown[]) => mockReadConfig(...args),
  },
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

  it('retries failed initialization with existing worktree in the background', async () => {
    const deferredInit = createDeferredPromise<void>();
    const workspace = {
      id: 'w2',
      status: 'FAILED',
      worktreePath: '/tmp/w2',
      branchName: 'feature/w2',
      project: { id: 'p1' },
    };
    let initFinished = false;
    mockFindByIdWithProject.mockResolvedValue(workspace);
    mockStartProvisioning.mockResolvedValue({ status: 'PROVISIONING' });
    mockInitializeWorkspaceWorktree.mockImplementation(async () => {
      await deferredInit.promise;
      initFinished = true;
    });
    mockFindById.mockResolvedValue({ id: 'w2', status: 'PROVISIONING' });

    const caller = createCaller();
    await expect(caller.retryInit({ id: 'w2' })).resolves.toEqual({
      id: 'w2',
      status: 'PROVISIONING',
    });

    expect(initFinished).toBe(false);
    expect(mockStartProvisioning).toHaveBeenCalledWith('w2', { maxRetries: 3 });
    expect(mockInitializeWorkspaceWorktree).toHaveBeenCalledWith('w2', {
      branchName: 'feature/w2',
      provisioningAlreadyStarted: true,
    });
    expect(mockRunStartupScript).not.toHaveBeenCalled();

    deferredInit.resolve();
    await deferredInit.promise;
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

  it('throws TOO_MANY_REQUESTS when failed existing-worktree retry exceeds max retries', async () => {
    mockFindByIdWithProject.mockResolvedValue({
      id: 'w2',
      status: 'FAILED',
      project: { worktreeBasePath: '/tmp' },
      worktreePath: '/tmp/w2',
    });
    mockStartProvisioning.mockResolvedValue(null);

    const caller = createCaller();
    await expect(caller.retryInit({ id: 'w2' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockInitializeWorkspaceWorktree).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND when getInitStatus workspace is missing', async () => {
    mockFindByIdWithProject.mockResolvedValue(null);
    const caller = createCaller();
    await expect(caller.getInitStatus({ id: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('retries startup script pipeline for READY+warning workspace', async () => {
    const workspace = {
      id: 'w3',
      status: 'READY',
      initErrorMessage: 'setup script failed',
      worktreePath: '/tmp/w3',
      project: { id: 'p1' },
    };
    mockFindByIdWithProject.mockResolvedValue(workspace);
    mockStartProvisioningFromReady.mockResolvedValue({ status: 'PROVISIONING' });
    mockReadConfig.mockResolvedValue({ setupCommands: [] });
    mockExecuteStartupScriptPipeline.mockResolvedValue(undefined);
    mockFindById.mockResolvedValue({ id: 'w3', status: 'READY' });

    const caller = createCaller();
    await expect(caller.retryInit({ id: 'w3' })).resolves.toEqual({ id: 'w3', status: 'READY' });

    expect(mockStartProvisioningFromReady).toHaveBeenCalledWith('w3', 3);
    expect(mockReadConfig).toHaveBeenCalledWith('/tmp/w3');
    expect(mockExecuteStartupScriptPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'w3',
        worktreePath: '/tmp/w3',
      })
    );
  });

  it('throws TOO_MANY_REQUESTS when READY+warning retry exceeds max retries', async () => {
    mockFindByIdWithProject.mockResolvedValue({
      id: 'w4',
      status: 'READY',
      initErrorMessage: 'setup script failed',
      worktreePath: '/tmp/w4',
      project: { id: 'p1' },
    });
    mockStartProvisioningFromReady.mockResolvedValue(null);

    const caller = createCaller();
    await expect(caller.retryInit({ id: 'w4' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });
});

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
