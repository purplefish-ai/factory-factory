import { PRState, RatchetState, WorkspaceStatus } from '@prisma-gen/client';
import { TRPCError } from '@trpc/server';
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
const mockClearWorkspaceActivity = vi.hoisted(() => vi.fn());
const mockArchiveWorkspace = vi.hoisted(() => vi.fn());
const mockCleanupWorkspaceRuntimeResources = vi.hoisted(() => vi.fn());
const mockInitializeWorkspaceWorktree = vi.hoisted(() => vi.fn());
const mockBuildSessionSummaries = vi.hoisted(() => vi.fn());
const mockHasWorkingSessionSummary = vi.hoisted(() => vi.fn());
const mockDeriveWorkspaceSidebarStatus = vi.hoisted(() => vi.fn());
const mockComputeKanbanColumn = vi.hoisted(() => vi.fn());
const mockComputePendingRequestType = vi.hoisted(() => vi.fn());
const mockSetWorkspaceRatcheting = vi.hoisted(() => vi.fn());
const mockCheckWorkspaceById = vi.hoisted(() => vi.fn());
const mockSessionRuntimeSnapshot = vi.hoisted(() => vi.fn());
const mockCreateAgentSession = vi.hoisted(() => vi.fn());
const mockResolveProviderForWorkspaceCreation = vi.hoisted(() =>
  vi.fn(async (_explicitProvider?: unknown) => 'CLAUDE')
);
const mockFindByIdWithProject = vi.hoisted(() => vi.fn());
const mockFindSessionsByWorkspaceId = vi.hoisted(() => vi.fn());
const mockAppendClaudeEvent = vi.hoisted(() => vi.fn());
const mockEmitDelta = vi.hoisted(() => vi.fn());
const mockEnqueue = vi.hoisted(() => vi.fn());
const mockHasQueuedMessage = vi.hoisted(() => vi.fn());
const mockTryDispatchNextMessage = vi.hoisted(() => vi.fn());
const mockPersistChildNotification = vi.hoisted(() => vi.fn());
const mockPersistParentNotification = vi.hoisted(() => vi.fn());

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: mockWorkspaceDataService,
  workspaceQueryService: mockWorkspaceQueryService,
  workspaceAccessor: {
    findByIdWithProject: (...args: unknown[]) => mockFindByIdWithProject(...args),
  },
  workspaceActivityService: {
    clearWorkspace: (...args: unknown[]) => mockClearWorkspaceActivity(...args),
  },
  deriveWorkspaceFlowStateFromWorkspace: (...args: unknown[]) => mockDeriveFlowState(...args),
  computeKanbanColumn: (...args: unknown[]) => mockComputeKanbanColumn(...args),
  computePendingRequestType: (...args: unknown[]) => mockComputePendingRequestType(...args),
  WorkspaceCreationService: class {
    create = (...args: unknown[]) => mockWorkspaceCreationCreate(...args);
  },
}));

vi.mock('@/backend/services/session', () => ({
  sessionService: {
    getRuntimeSnapshot: (...args: unknown[]) => mockSessionRuntimeSnapshot(...args),
  },
  sessionDomainService: {
    getAllPendingRequests: () => new Map(),
    appendClaudeEvent: (...args: unknown[]) => mockAppendClaudeEvent(...args),
    emitDelta: (...args: unknown[]) => mockEmitDelta(...args),
    enqueue: (...args: unknown[]) => mockEnqueue(...args),
    hasQueuedMessage: (...args: unknown[]) => mockHasQueuedMessage(...args),
  },
  sessionDataService: {
    createAgentSession: (...args: unknown[]) => mockCreateAgentSession(...args),
  },
  sessionProviderResolverService: {
    resolveProviderForWorkspaceCreation: (explicitProvider?: unknown) =>
      mockResolveProviderForWorkspaceCreation(explicitProvider),
  },
  agentSessionAccessor: {
    findByWorkspaceId: (...args: unknown[]) => mockFindSessionsByWorkspaceId(...args),
  },
  chatMessageHandlerService: {
    tryDispatchNextMessage: (...args: unknown[]) => mockTryDispatchNextMessage(...args),
  },
}));

vi.mock('@/backend/services/ratchet', () => ({
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
  cleanupWorkspaceRuntimeResources: (...args: unknown[]) =>
    mockCleanupWorkspaceRuntimeResources(...args),
}));

vi.mock('@/backend/orchestration/workspace-init.orchestrator', () => ({
  initializeWorkspaceWorktree: (...args: unknown[]) => mockInitializeWorkspaceWorktree(...args),
}));

vi.mock('@/backend/orchestration/workspace-children.orchestrator', () => ({
  createChildWorkspace: vi.fn(),
  fireLifecycleNotification: vi.fn(),
  persistChildNotification: (...args: unknown[]) => mockPersistChildNotification(...args),
  persistParentNotification: (...args: unknown[]) => mockPersistParentNotification(...args),
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

function createCaller(requestTrust?: {
  remoteAddress?: string;
  origin?: string;
  isLocal: boolean;
}) {
  const sessionService = {
    stopWorkspaceSessions: vi.fn(async () => undefined),
  };
  const runScriptService = {
    stopRunScript: vi.fn(
      async (): Promise<{ success: boolean; error?: string }> => ({ success: true })
    ),
    evictWorkspaceBuffers: vi.fn(),
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
    requestTrust,
    appContext: {
      services: {
        configService: {
          getWorktreeBaseDir: () => '/tmp/worktrees',
          getMaxSessionsPerWorkspace: () => 2,
          getCorsConfig: () => ({
            allowedOrigins: ['http://localhost:3000', 'http://localhost:3001'],
          }),
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
    mockComputeKanbanColumn.mockReturnValue('WAITING');
    mockComputePendingRequestType.mockReturnValue(null);
    mockCreateAgentSession.mockResolvedValue({ id: 'session-1' });
    mockCleanupWorkspaceRuntimeResources.mockImplementation(
      async (
        workspaceId: string,
        services: {
          sessionService: { stopWorkspaceSessions(workspaceId: string): Promise<void> };
          runScriptService: {
            stopRunScript(workspaceId: string): Promise<{ success: boolean; error?: string }>;
          };
          terminalService: { destroyWorkspaceTerminals(workspaceId: string): void };
        },
        operation: string
      ) => {
        const cleanupResults = await Promise.allSettled([
          services.sessionService.stopWorkspaceSessions(workspaceId),
          (async () => {
            const result = await services.runScriptService.stopRunScript(workspaceId);
            if (!result.success) {
              throw new Error(result.error ?? 'Unknown run script stop failure');
            }
          })(),
          Promise.resolve().then(() => {
            services.terminalService.destroyWorkspaceTerminals(workspaceId);
          }),
        ]);

        if (cleanupResults.some((result) => result.status === 'rejected')) {
          throw new Error(`Failed to cleanup workspace resources before ${operation}`);
        }
      }
    );
  });

  it('lists workspaces and returns enriched workspace details', async () => {
    const workspace = {
      id: 'w1',
      projectId: 'p1',
      status: WorkspaceStatus.READY,
      prUrl: null,
      prState: PRState.NONE,
      prCiStatus: 'UNKNOWN',
      ratchetEnabled: false,
      ratchetState: RatchetState.IDLE,
      hasHadSessions: true,
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
    mockWorkspaceCreationCreate.mockResolvedValue({ id: 'w-created' });
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
    expect(mockCreateAgentSession).toHaveBeenCalledWith({
      workspaceId: 'w-created',
      workflow: 'followup',
      name: 'Chat 1',
      provider: 'CLAUDE',
      providerProjectPath: null,
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

  it('includes error codes for individual bulk archive failures', async () => {
    mockWorkspaceQueryService.listWithKanbanState.mockResolvedValue([
      { id: 'w-success' },
      { id: 'w-blocked' },
    ]);
    mockArchiveWorkspace
      .mockResolvedValueOnce({ archived: true })
      .mockRejectedValueOnce(
        new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Uncommitted changes' })
      );
    const { caller } = createCaller();

    await expect(
      caller.bulkArchive({
        projectId: 'p1',
        kanbanColumn: 'WAITING',
        commitUncommitted: false,
      })
    ).resolves.toEqual({
      results: [
        { id: 'w-success', success: true },
        {
          id: 'w-blocked',
          success: false,
          error: 'Uncommitted changes',
          code: 'PRECONDITION_FAILED',
        },
      ],
      total: 2,
    });
  });

  it('rejects privileged workspace mutations from untrusted requests', async () => {
    const { caller } = createCaller({
      remoteAddress: '203.0.113.10',
      origin: 'https://attacker.example',
      isLocal: false,
    });

    await expect(
      caller.create({
        type: 'MANUAL',
        projectId: 'p1',
        name: 'New Workspace',
      })
    ).rejects.toThrow('trusted local Factory Factory client');

    await expect(
      caller.createChild({
        parentWorkspaceId: 'parent-1',
        projectId: 'p1',
        name: 'Child Workspace',
      })
    ).rejects.toThrow('trusted local Factory Factory client');

    expect(mockResolveProviderForWorkspaceCreation).not.toHaveBeenCalled();
    expect(mockWorkspaceCreationCreate).not.toHaveBeenCalled();
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
    expect(mockInitializeWorkspaceWorktree).not.toHaveBeenCalled();
  });

  it('passes initial attachments through manual workspace creation', async () => {
    const { caller } = createCaller();
    mockWorkspaceCreationCreate.mockResolvedValue({ id: 'w-created' });

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

  it('passes startup mode preset through manual workspace creation', async () => {
    const { caller } = createCaller();
    mockWorkspaceCreationCreate.mockResolvedValue({ id: 'w-created' });

    await caller.create({
      type: 'MANUAL',
      projectId: 'p1',
      name: 'Planning Workspace',
      startupModePreset: 'plan',
    });

    expect(mockWorkspaceCreationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'MANUAL',
        startupModePreset: 'plan',
      })
    );
  });

  it('defaults auto-iteration config before workspace creation', async () => {
    const { caller } = createCaller();
    mockWorkspaceCreationCreate.mockResolvedValue({ id: 'w-created' });

    await caller.create({
      type: 'MANUAL',
      projectId: 'p1',
      name: 'Auto Iteration Workspace',
      mode: 'AUTO_ITERATION',
      autoIterationConfig: {
        testCommand: 'pnpm test',
        targetDescription: 'Improve coverage',
      },
    });

    expect(mockWorkspaceCreationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'MANUAL',
        mode: 'AUTO_ITERATION',
        autoIterationConfig: {
          testCommand: 'pnpm test',
          targetDescription: 'Improve coverage',
          maxIterations: 25,
          testTimeoutSeconds: 600,
          sessionRecycleInterval: 10,
        },
      })
    );
  });

  it('passes startup mode preset through GitHub issue workspace creation', async () => {
    const { caller } = createCaller();
    mockWorkspaceCreationCreate.mockResolvedValue({ id: 'w-created' });

    await caller.create({
      type: 'GITHUB_ISSUE',
      projectId: 'p1',
      issueNumber: 42,
      issueUrl: 'https://github.com/org/repo/issues/42',
      startupModePreset: 'plan',
    });

    expect(mockWorkspaceCreationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'GITHUB_ISSUE',
        startupModePreset: 'plan',
      })
    );
  });

  it('passes initial prompt through GitHub issue workspace creation', async () => {
    const { caller } = createCaller();
    mockWorkspaceCreationCreate.mockResolvedValue({ id: 'w-created' });

    await caller.create({
      type: 'GITHUB_ISSUE',
      projectId: 'p1',
      issueNumber: 42,
      issueUrl: 'https://github.com/org/repo/issues/42',
      initialPrompt: 'Custom issue prompt',
    });

    expect(mockWorkspaceCreationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'GITHUB_ISSUE',
        initialPrompt: 'Custom issue prompt',
      })
    );
  });

  it('passes provider through GitHub issue workspace creation', async () => {
    const { caller } = createCaller();
    mockWorkspaceCreationCreate.mockResolvedValue({ id: 'w-created' });

    await caller.create({
      type: 'GITHUB_ISSUE',
      projectId: 'p1',
      issueNumber: 42,
      issueUrl: 'https://github.com/org/repo/issues/42',
      provider: 'CODEX',
    });

    expect(mockResolveProviderForWorkspaceCreation).toHaveBeenCalledWith('CODEX');
    expect(mockWorkspaceCreationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'GITHUB_ISSUE',
        provider: 'CODEX',
      })
    );
  });

  it('passes startup mode preset through Linear issue workspace creation', async () => {
    const { caller } = createCaller();
    mockWorkspaceCreationCreate.mockResolvedValue({ id: 'w-created' });

    await caller.create({
      type: 'LINEAR_ISSUE',
      projectId: 'p1',
      issueId: 'linear-42',
      issueIdentifier: 'ENG-42',
      issueUrl: 'https://linear.app/org/issue/ENG-42',
      startupModePreset: 'plan',
    });

    expect(mockWorkspaceCreationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'LINEAR_ISSUE',
        startupModePreset: 'plan',
      })
    );
  });

  it('passes initial prompt through Linear issue workspace creation', async () => {
    const { caller } = createCaller();
    mockWorkspaceCreationCreate.mockResolvedValue({ id: 'w-created' });

    await caller.create({
      type: 'LINEAR_ISSUE',
      projectId: 'p1',
      issueId: 'linear-42',
      issueIdentifier: 'ENG-42',
      issueUrl: 'https://linear.app/org/issue/ENG-42',
      initialPrompt: 'Custom Linear issue prompt',
    });

    expect(mockWorkspaceCreationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'LINEAR_ISSUE',
        initialPrompt: 'Custom Linear issue prompt',
      })
    );
  });

  it('passes provider through Linear issue workspace creation', async () => {
    const { caller } = createCaller();
    mockWorkspaceCreationCreate.mockResolvedValue({ id: 'w-created' });

    await caller.create({
      type: 'LINEAR_ISSUE',
      projectId: 'p1',
      issueId: 'linear-42',
      issueIdentifier: 'ENG-42',
      issueUrl: 'https://linear.app/org/issue/ENG-42',
      provider: 'CODEX',
    });

    expect(mockResolveProviderForWorkspaceCreation).toHaveBeenCalledWith('CODEX');
    expect(mockWorkspaceCreationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'LINEAR_ISSUE',
        provider: 'CODEX',
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
    expect(mockCleanupWorkspaceRuntimeResources).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({
        sessionService,
        runScriptService,
        terminalService,
      }),
      'delete'
    );
    expect(sessionService.stopWorkspaceSessions).toHaveBeenCalledWith('w1');
    expect(runScriptService.stopRunScript).toHaveBeenCalledWith('w1');
    expect(runScriptService.evictWorkspaceBuffers).toHaveBeenCalledWith('w1');
    const evictionCallOrder = runScriptService.evictWorkspaceBuffers.mock.invocationCallOrder[0];
    const deleteCallOrder = mockWorkspaceDataService.delete.mock.invocationCallOrder[0];
    if (evictionCallOrder === undefined || deleteCallOrder === undefined) {
      throw new Error('Expected buffer eviction and workspace deletion to be called');
    }
    expect(evictionCallOrder).toBeLessThan(deleteCallOrder);
    expect(terminalService.destroyWorkspaceTerminals).toHaveBeenCalledWith('w1');
    expect(mockClearWorkspaceActivity).toHaveBeenCalledWith('w1');

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

  it('does not delete when run script cleanup reports failure', async () => {
    const { caller, sessionService, runScriptService, terminalService } = createCaller();
    runScriptService.stopRunScript.mockResolvedValue({ success: false, error: 'stop failed' });

    await expect(caller.delete({ id: 'w1' })).rejects.toThrow(
      'Failed to cleanup workspace resources before delete'
    );
    expect(sessionService.stopWorkspaceSessions).toHaveBeenCalledWith('w1');
    expect(runScriptService.stopRunScript).toHaveBeenCalledWith('w1');
    expect(runScriptService.evictWorkspaceBuffers).not.toHaveBeenCalled();
    expect(terminalService.destroyWorkspaceTerminals).toHaveBeenCalledWith('w1');
    expect(mockWorkspaceDataService.delete).not.toHaveBeenCalled();
  });

  it('does not delete when workspace session cleanup throws', async () => {
    const { caller, sessionService, runScriptService, terminalService } = createCaller();
    sessionService.stopWorkspaceSessions.mockRejectedValue(new Error('session cleanup failed'));

    await expect(caller.delete({ id: 'w1' })).rejects.toThrow(
      'Failed to cleanup workspace resources before delete'
    );
    expect(sessionService.stopWorkspaceSessions).toHaveBeenCalledWith('w1');
    expect(runScriptService.stopRunScript).toHaveBeenCalledWith('w1');
    expect(runScriptService.evictWorkspaceBuffers).not.toHaveBeenCalled();
    expect(terminalService.destroyWorkspaceTerminals).toHaveBeenCalledWith('w1');
    expect(mockWorkspaceDataService.delete).not.toHaveBeenCalled();
  });

  it('does not delete when terminal cleanup throws', async () => {
    const { caller, sessionService, runScriptService, terminalService } = createCaller();
    terminalService.destroyWorkspaceTerminals.mockImplementation(() => {
      throw new Error('terminal cleanup failed');
    });

    await expect(caller.delete({ id: 'w1' })).rejects.toThrow(
      'Failed to cleanup workspace resources before delete'
    );
    expect(sessionService.stopWorkspaceSessions).toHaveBeenCalledWith('w1');
    expect(runScriptService.stopRunScript).toHaveBeenCalledWith('w1');
    expect(runScriptService.evictWorkspaceBuffers).not.toHaveBeenCalled();
    expect(terminalService.destroyWorkspaceTerminals).toHaveBeenCalledWith('w1');
    expect(mockWorkspaceDataService.delete).not.toHaveBeenCalled();
  });

  describe('sendMessageToParent', () => {
    const child = {
      id: 'child-1',
      name: 'Child WS',
      parentWorkspaceId: 'parent-1',
      project: { name: 'Child Project' },
    };

    beforeEach(() => {
      mockFindByIdWithProject.mockResolvedValue(child);
      mockPersistChildNotification.mockResolvedValue({
        id: 'notif-1',
        direction: 'CHILD_TO_PARENT',
        sourceWorkspaceName: 'Child WS',
        message: 'hello',
      });
      mockAppendClaudeEvent.mockReturnValue(1);
      mockEnqueue.mockReturnValue({ position: 0 });
      mockHasQueuedMessage.mockReturnValue(false);
      mockTryDispatchNextMessage.mockResolvedValue(undefined);
    });

    it('persists the notification before live delivery to an active session', async () => {
      mockFindSessionsByWorkspaceId.mockResolvedValue([{ id: 'sess-1', status: 'RUNNING' }]);

      const { caller } = createCaller();
      await expect(
        caller.sendMessageToParent({ childWorkspaceId: 'child-1', message: 'hello' })
      ).resolves.toEqual({ delivered: true });

      expect(mockPersistChildNotification).toHaveBeenCalledWith({
        parentWorkspaceId: 'parent-1',
        sourceWorkspaceId: 'child-1',
        message: 'hello',
      });
      expect(mockEnqueue).toHaveBeenCalledWith(
        'sess-1',
        expect.objectContaining({
          id: 'workspace-notification-notif-1',
          text: `[Message from child workspace "Child WS"]: hello\n\n<!-- factory-factory-workspace-notification:notif-1 -->`,
        })
      );
      expect(mockTryDispatchNextMessage).toHaveBeenCalledWith('sess-1');
      const persistOrder = mockPersistChildNotification.mock.invocationCallOrder[0];
      const enqueueOrder = mockEnqueue.mock.invocationCallOrder[0];
      if (persistOrder === undefined || enqueueOrder === undefined) {
        throw new Error('Expected both persist and enqueue to be called');
      }
      expect(persistOrder).toBeLessThan(enqueueOrder);
    });

    it('persists the notification and skips live delivery when no active session', async () => {
      mockFindSessionsByWorkspaceId.mockResolvedValue([{ id: 'sess-1', status: 'STOPPED' }]);

      const { caller } = createCaller();
      await expect(
        caller.sendMessageToParent({ childWorkspaceId: 'child-1', message: 'hello' })
      ).resolves.toEqual({ delivered: false });

      expect(mockPersistChildNotification).toHaveBeenCalledWith({
        parentWorkspaceId: 'parent-1',
        sourceWorkspaceId: 'child-1',
        message: 'hello',
      });
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockTryDispatchNextMessage).not.toHaveBeenCalled();
    });

    it('leaves the notification pending when live enqueue fails', async () => {
      mockFindSessionsByWorkspaceId.mockResolvedValue([{ id: 'sess-1', status: 'RUNNING' }]);
      mockEnqueue.mockReturnValue({ error: 'queue full' });

      const { caller } = createCaller();
      await expect(
        caller.sendMessageToParent({ childWorkspaceId: 'child-1', message: 'hello' })
      ).resolves.toEqual({ delivered: false });

      expect(mockPersistChildNotification).toHaveBeenCalled();
      expect(mockTryDispatchNextMessage).not.toHaveBeenCalled();
    });

    it('skips enqueue when session startup already queued the notification', async () => {
      mockFindSessionsByWorkspaceId.mockResolvedValue([{ id: 'sess-1', status: 'RUNNING' }]);
      mockHasQueuedMessage.mockReturnValue(true);

      const { caller } = createCaller();
      await expect(
        caller.sendMessageToParent({ childWorkspaceId: 'child-1', message: 'hello' })
      ).resolves.toEqual({ delivered: true });

      expect(mockHasQueuedMessage).toHaveBeenCalledWith('sess-1', 'workspace-notification-notif-1');
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockAppendClaudeEvent).not.toHaveBeenCalled();
      expect(mockEmitDelta).not.toHaveBeenCalled();
    });
  });

  describe('sendMessageToChild', () => {
    const child = {
      id: 'child-1',
      name: 'Child WS',
      parentWorkspaceId: 'parent-1',
      project: { name: 'Child Project' },
    };
    const parent = {
      id: 'parent-1',
      name: 'Parent WS',
      parentWorkspaceId: null,
      project: { name: 'Parent Project' },
    };

    beforeEach(() => {
      mockFindByIdWithProject.mockImplementation(async (id: unknown) =>
        id === 'child-1' ? child : parent
      );
      mockPersistParentNotification.mockResolvedValue({
        id: 'notif-2',
        direction: 'PARENT_TO_CHILD',
        sourceWorkspaceName: 'Parent WS',
        message: 'do this',
      });
      mockAppendClaudeEvent.mockReturnValue(1);
      mockEnqueue.mockReturnValue({ position: 0 });
      mockHasQueuedMessage.mockReturnValue(false);
      mockTryDispatchNextMessage.mockResolvedValue(undefined);
    });

    it('persists the notification before live delivery to an active session', async () => {
      mockFindSessionsByWorkspaceId.mockResolvedValue([{ id: 'sess-2', status: 'IDLE' }]);

      const { caller } = createCaller();
      await expect(
        caller.sendMessageToChild({
          parentWorkspaceId: 'parent-1',
          childWorkspaceId: 'child-1',
          message: 'do this',
        })
      ).resolves.toEqual({ delivered: true });

      expect(mockPersistParentNotification).toHaveBeenCalledWith({
        parentWorkspaceId: 'parent-1',
        targetChildWorkspaceId: 'child-1',
        message: 'do this',
      });
      expect(mockEnqueue).toHaveBeenCalledWith(
        'sess-2',
        expect.objectContaining({
          id: 'workspace-notification-notif-2',
          text: `[Message from parent workspace "Parent WS"]: do this\n\n<!-- factory-factory-workspace-notification:notif-2 -->`,
        })
      );
      expect(mockTryDispatchNextMessage).toHaveBeenCalledWith('sess-2');
      const persistOrder = mockPersistParentNotification.mock.invocationCallOrder[0];
      const enqueueOrder = mockEnqueue.mock.invocationCallOrder[0];
      if (persistOrder === undefined || enqueueOrder === undefined) {
        throw new Error('Expected both persist and enqueue to be called');
      }
      expect(persistOrder).toBeLessThan(enqueueOrder);
    });

    it('persists the notification and skips live delivery when no active session', async () => {
      mockFindSessionsByWorkspaceId.mockResolvedValue([]);

      const { caller } = createCaller();
      await expect(
        caller.sendMessageToChild({
          parentWorkspaceId: 'parent-1',
          childWorkspaceId: 'child-1',
          message: 'do this',
        })
      ).resolves.toEqual({ delivered: false });

      expect(mockPersistParentNotification).toHaveBeenCalledWith({
        parentWorkspaceId: 'parent-1',
        targetChildWorkspaceId: 'child-1',
        message: 'do this',
      });
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockTryDispatchNextMessage).not.toHaveBeenCalled();
    });

    it('skips enqueue when session startup already queued the notification', async () => {
      mockFindSessionsByWorkspaceId.mockResolvedValue([{ id: 'sess-2', status: 'IDLE' }]);
      mockHasQueuedMessage.mockReturnValue(true);

      const { caller } = createCaller();
      await expect(
        caller.sendMessageToChild({
          parentWorkspaceId: 'parent-1',
          childWorkspaceId: 'child-1',
          message: 'do this',
        })
      ).resolves.toEqual({ delivered: true });

      expect(mockHasQueuedMessage).toHaveBeenCalledWith('sess-2', 'workspace-notification-notif-2');
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockAppendClaudeEvent).not.toHaveBeenCalled();
      expect(mockEmitDelta).not.toHaveBeenCalled();
    });
  });
});
