import { PRState, RatchetState, WorkspaceStatus } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIHealthStatus } from '@/backend/orchestration/cli-health.service';

const mockWorkspaceDataService = vi.hoisted(() => ({
  findByProjectId: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));

const mockWorkspaceQueryService = vi.hoisted(() => ({
  getProjectSummaryState: vi.fn(),
  listWithKanbanState: vi.fn(),
  listWithRuntimeState: vi.fn(),
  refreshFactoryConfigs: vi.fn(),
  getFactoryConfig: vi.fn(),
  syncPRStatus: vi.fn(),
  syncAllPRStatuses: vi.fn(),
  hasChanges: vi.fn(),
}));

const mockDeriveFlowState = vi.hoisted(() => vi.fn());
const mockWorkspaceCreationCreate = vi.hoisted(() => vi.fn());
const mockArchiveWorkspace = vi.hoisted(() => vi.fn());
const mockInitializeWorkspaceWorktree = vi.hoisted(() => vi.fn());
const mockBuildSessionSummaries = vi.hoisted(() => vi.fn());
const mockHasWorkingSessionSummary = vi.hoisted(() => vi.fn());
const mockDeriveWorkspaceSidebarStatus = vi.hoisted(() => vi.fn());
const mockSetWorkspaceRatcheting = vi.hoisted(() => vi.fn());
const mockCheckWorkspaceById = vi.hoisted(() => vi.fn());
const mockSessionRuntimeSnapshot = vi.hoisted(() => vi.fn());
const mockResolveProviderForWorkspaceCreation = vi.hoisted(() =>
  vi.fn(async (_explicitProvider?: unknown) => 'CLAUDE')
);

vi.mock('@/backend/domains/workspace', () => ({
  workspaceDataService: mockWorkspaceDataService,
  workspaceQueryService: mockWorkspaceQueryService,
  deriveWorkspaceFlowStateFromWorkspace: (...args: unknown[]) => mockDeriveFlowState(...args),
  WorkspaceCreationService: class {
    create = (...args: unknown[]) => mockWorkspaceCreationCreate(...args);
  },
}));

vi.mock('@/backend/domains/session', () => ({
  sessionService: {
    getRuntimeSnapshot: (...args: unknown[]) => mockSessionRuntimeSnapshot(...args),
  },
  sessionProviderResolverService: {
    resolveProviderForWorkspaceCreation: (explicitProvider?: unknown) =>
      mockResolveProviderForWorkspaceCreation(explicitProvider),
  },
}));

vi.mock('@/backend/domains/ratchet', () => ({
  ratchetService: {
    setWorkspaceRatcheting: (...args: unknown[]) => mockSetWorkspaceRatcheting(...args),
    checkWorkspaceById: (...args: unknown[]) => mockCheckWorkspaceById(...args),
  },
}));

vi.mock('@/backend/lib/session-summaries', () => ({
  buildWorkspaceSessionSummaries: (...args: unknown[]) => mockBuildSessionSummaries(...args),
  hasWorkingSessionSummary: (...args: unknown[]) => mockHasWorkingSessionSummary(...args),
}));

vi.mock('@/shared/workspace-sidebar-status', () => ({
  deriveWorkspaceSidebarStatus: (...args: unknown[]) => mockDeriveWorkspaceSidebarStatus(...args),
}));

vi.mock('@/backend/orchestration/workspace-archive.orchestrator', () => ({
  archiveWorkspace: (...args: unknown[]) => mockArchiveWorkspace(...args),
}));

vi.mock('@/backend/orchestration/workspace-init.orchestrator', () => ({
  initializeWorkspaceWorktree: (...args: unknown[]) => mockInitializeWorkspaceWorktree(...args),
}));

vi.mock('./workspace/workspace-helpers', () => ({
  getWorkspaceWithProjectOrThrow: vi.fn(async (id: string) => ({
    id,
    project: { slug: 'demo' },
  })),
}));

vi.mock('./workspace/files.trpc', () => ({
  workspaceFilesRouter: { _def: { procedures: {} } },
}));
vi.mock('./workspace/git.trpc', () => ({
  workspaceGitRouter: { _def: { procedures: {} } },
}));
vi.mock('./workspace/ide.trpc', () => ({
  workspaceIdeRouter: { _def: { procedures: {} } },
}));
vi.mock('./workspace/init.trpc', () => ({
  workspaceInitRouter: { _def: { procedures: {} } },
}));
vi.mock('./workspace/run-script.trpc', () => ({
  workspaceRunScriptRouter: { _def: { procedures: {} } },
}));

import { workspaceRouter } from './workspace.trpc';

function createCaller() {
  const sessionService = {
    stopWorkspaceSessions: vi.fn(async () => undefined),
  };
  const runScriptService = {
    stopRunScript: vi.fn(async () => undefined),
  };
  const terminalService = {
    destroyWorkspaceTerminals: vi.fn(),
  };
  const cliHealthService = {
    checkHealth: vi.fn(
      async (): Promise<CLIHealthStatus> => ({
        claude: { isInstalled: true },
        codex: { isInstalled: true, isAuthenticated: true },
        github: { isInstalled: true, isAuthenticated: true },
        allHealthy: true,
      })
    ),
  };

  const caller = workspaceRouter.createCaller({
    appContext: {
      services: {
        configService: {
          getWorktreeBaseDir: () => '/tmp/worktrees',
          getMaxSessionsPerWorkspace: () => 2,
        },
        cliHealthService,
        createLogger: () => ({
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        }),
        sessionService,
        runScriptService,
        terminalService,
      },
    },
  } as never);

  return { caller, sessionService, runScriptService, terminalService, cliHealthService };
}

describe('workspaceRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProviderForWorkspaceCreation.mockResolvedValue('CLAUDE');
    mockInitializeWorkspaceWorktree.mockResolvedValue(undefined);
    mockCheckWorkspaceById.mockResolvedValue(undefined);
    mockDeriveFlowState.mockReturnValue({
      phase: 'NO_PR',
      ciObservation: 'CHECKS_UNKNOWN',
      isWorking: false,
      shouldAnimateRatchetButton: false,
    });
    mockBuildSessionSummaries.mockReturnValue([{ id: 's1', status: 'IDLE' }]);
    mockHasWorkingSessionSummary.mockReturnValue(false);
    mockDeriveWorkspaceSidebarStatus.mockReturnValue({ activityState: 'IDLE', ciState: 'NONE' });
  });

  it('lists workspaces and returns enriched workspace details', async () => {
    const workspace = {
      id: 'w1',
      projectId: 'p1',
      status: WorkspaceStatus.READY,
      prUrl: null,
      prState: PRState.NONE,
      prCiStatus: null,
      ratchetState: RatchetState.IDLE,
      agentSessions: [],
    };
    mockWorkspaceDataService.findByProjectId.mockResolvedValue([workspace]);
    mockWorkspaceDataService.findById.mockResolvedValue(workspace);

    const { caller } = createCaller();
    await expect(caller.list({ projectId: 'p1' })).resolves.toEqual([workspace]);
    await expect(caller.get({ id: 'w1' })).resolves.toEqual(
      expect.objectContaining({
        id: 'w1',
        sessionSummaries: [{ id: 's1', status: 'IDLE' }],
        sidebarStatus: { activityState: 'IDLE', ciState: 'NONE' },
        ratchetButtonAnimated: false,
        flowPhase: 'NO_PR',
        ciObservation: 'CHECKS_UNKNOWN',
      })
    );
  });

  it('creates, toggles, and archives workspaces', async () => {
    const { caller } = createCaller();
    mockWorkspaceCreationCreate.mockResolvedValue({ workspace: { id: 'w-created' } });
    mockWorkspaceDataService.findById.mockResolvedValue({ id: 'w-created' });
    mockArchiveWorkspace.mockResolvedValue({ archived: true });

    await expect(
      caller.create({
        type: 'MANUAL',
        projectId: 'p1',
        name: 'New Workspace',
        branchName: 'feature/x',
      })
    ).resolves.toEqual({ id: 'w-created' });

    await Promise.resolve();
    expect(mockInitializeWorkspaceWorktree).toHaveBeenCalledWith('w-created', {
      branchName: 'feature/x',
      useExistingBranch: false,
    });

    await expect(
      caller.toggleRatcheting({ workspaceId: 'w-created', enabled: true })
    ).resolves.toEqual({
      id: 'w-created',
    });
    expect(mockSetWorkspaceRatcheting).toHaveBeenCalledWith('w-created', true);
    expect(mockCheckWorkspaceById).toHaveBeenCalledWith('w-created');

    await expect(caller.archive({ id: 'w-created' })).resolves.toEqual({ archived: true });
  });

  it('passes initial attachments through manual workspace creation', async () => {
    const { caller } = createCaller();
    mockWorkspaceCreationCreate.mockResolvedValue({ workspace: { id: 'w-created' } });

    const initialAttachments = [
      {
        id: 'att-1',
        name: 'context.txt',
        type: 'text/plain',
        size: 12,
        data: 'hello world',
        contentType: 'text' as const,
      },
    ];

    await caller.create({
      type: 'MANUAL',
      projectId: 'p1',
      name: 'With Attachments',
      initialPrompt: 'Please use the attachment',
      initialAttachments,
    });

    expect(mockWorkspaceCreationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'MANUAL',
        initialAttachments,
      })
    );
  });

  it('blocks workspace creation when default provider is unavailable', async () => {
    const { caller, cliHealthService } = createCaller();
    cliHealthService.checkHealth.mockResolvedValue({
      claude: { isInstalled: false, error: 'Claude CLI is not installed.' },
      codex: { isInstalled: true, isAuthenticated: true },
      github: { isInstalled: true, isAuthenticated: true },
      allHealthy: false,
    });

    await expect(
      caller.create({
        type: 'MANUAL',
        projectId: 'p1',
        name: 'New Workspace',
      })
    ).rejects.toThrow('Cannot create workspace: Claude provider is unavailable');
    expect(mockWorkspaceCreationCreate).not.toHaveBeenCalled();
  });

  it('cleans up on delete and delegates summary procedures', async () => {
    mockWorkspaceDataService.delete.mockResolvedValue({ deleted: true });
    mockWorkspaceQueryService.refreshFactoryConfigs.mockResolvedValue({ refreshed: 3 });
    mockWorkspaceQueryService.getFactoryConfig.mockResolvedValue({ scripts: { run: 'pnpm dev' } });
    mockWorkspaceQueryService.syncPRStatus.mockResolvedValue({ synced: true });
    mockWorkspaceQueryService.syncAllPRStatuses.mockResolvedValue({ synced: 10 });
    mockWorkspaceQueryService.hasChanges.mockResolvedValue({ hasChanges: true });

    const { caller, sessionService, runScriptService, terminalService } = createCaller();

    await expect(caller.delete({ id: 'w1' })).resolves.toEqual({ deleted: true });
    expect(sessionService.stopWorkspaceSessions).toHaveBeenCalledWith('w1');
    expect(runScriptService.stopRunScript).toHaveBeenCalledWith('w1');
    expect(terminalService.destroyWorkspaceTerminals).toHaveBeenCalledWith('w1');

    await expect(caller.refreshFactoryConfigs({ projectId: 'p1' })).resolves.toEqual({
      refreshed: 3,
    });
    await expect(caller.getFactoryConfig({ projectId: 'p1' })).resolves.toEqual({
      scripts: { run: 'pnpm dev' },
    });
    await expect(caller.syncPRStatus({ workspaceId: 'w1' })).resolves.toEqual({ synced: true });
    await expect(caller.syncAllPRStatuses({ projectId: 'p1' })).resolves.toEqual({ synced: 10 });
    await expect(caller.hasChanges({ workspaceId: 'w1' })).resolves.toEqual({ hasChanges: true });
  });
});
