import { SessionProvider } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIHealthStatus } from '@/backend/orchestration/cli-health.service';
import { SessionStatus } from '@/shared/core';

const mockSessionDataService = vi.hoisted(() => ({
  findAgentSessionsByWorkspaceId: vi.fn(),
  countActiveAgentSessionsByWorkspaceId: vi.fn(),
  findAgentSessionById: vi.fn(),
  createAgentSession: vi.fn(),
  createAgentSessionWithinWorkspaceLimit: vi.fn(),
  updateAgentSession: vi.fn(),
  deleteAgentSession: vi.fn(),
}));

const mockTerminalSessionService = vi.hoisted(() => ({
  findByWorkspaceId: vi.fn(),
  findById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));

const mockSessionDomainService = vi.hoisted(() => ({
  storeInitialMessage: vi.fn(),
}));

const mockSessionProviderResolverService = vi.hoisted(() => ({
  resolveSessionProvider: vi.fn(),
}));

const mockListQuickActions = vi.hoisted(() => vi.fn());
const mockGetQuickAction = vi.hoisted(() => vi.fn());

vi.mock('@/backend/services/session', () => ({
  sessionDataService: mockSessionDataService,
  sessionDomainService: mockSessionDomainService,
  sessionProviderResolverService: mockSessionProviderResolverService,
}));

vi.mock('@/backend/services/terminal', () => ({
  terminalSessionService: mockTerminalSessionService,
}));

vi.mock('@/backend/prompts/quick-actions', () => ({
  listQuickActions: () => mockListQuickActions(),
  getQuickAction: (id: string) => mockGetQuickAction(id),
}));

import { sessionRouter } from './session.trpc';

function createCaller() {
  const sessionService = {
    isSessionWorking: vi.fn((id: string) => id === 's-working'),
    startSession: vi.fn(async () => undefined),
    stopSession: vi.fn(async () => undefined),
  };
  const sessionDomainService = {
    clearSession: vi.fn(),
    storeInitialMessage: mockSessionDomainService.storeInitialMessage,
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

  return {
    caller: sessionRouter.createCaller({
      appContext: {
        services: {
          configService: {
            getMaxSessionsPerWorkspace: () => 2,
          },
          sessionService,
          sessionDomainService,
          cliHealthService,
        },
      },
    } as never),
    sessionService,
    sessionDomainService,
    cliHealthService,
  };
}

describe('sessionRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionDataService.createAgentSessionWithinWorkspaceLimit.mockResolvedValue({
      outcome: 'created',
      session: { id: 's-new', workspaceId: 'w1' },
    });
  });

  it('returns quick actions and augments sessions with runtime working state', async () => {
    mockListQuickActions.mockReturnValue([{ id: 'quick-1', title: 'Fix CI' }]);
    mockGetQuickAction.mockReturnValue({ id: 'quick-1', title: 'Fix CI' });
    mockSessionDataService.findAgentSessionsByWorkspaceId.mockResolvedValue([
      { id: 's-working', name: 'A' },
      { id: 's-idle', name: 'B' },
    ]);

    const { caller } = createCaller();

    await expect(caller.listQuickActions()).resolves.toEqual([{ id: 'quick-1', title: 'Fix CI' }]);
    await expect(caller.getQuickAction({ id: 'quick-1' })).resolves.toEqual({
      id: 'quick-1',
      title: 'Fix CI',
    });
    await expect(caller.listSessions({ workspaceId: 'w1' })).resolves.toEqual([
      { id: 's-working', name: 'A', isWorking: true },
      { id: 's-idle', name: 'B', isWorking: false },
    ]);
  });

  it('enforces workspace session limits and creates a session with provider resolution', async () => {
    const { caller, cliHealthService } = createCaller();

    mockSessionProviderResolverService.resolveSessionProvider.mockResolvedValue(
      SessionProvider.CODEX
    );
    mockSessionDataService.createAgentSessionWithinWorkspaceLimit.mockResolvedValueOnce({
      outcome: 'limit_reached',
    });
    await expect(
      caller.createSession({
        workspaceId: 'w1',
        workflow: 'user',
      })
    ).rejects.toThrow('Maximum sessions per workspace (2) reached');

    mockSessionDataService.createAgentSessionWithinWorkspaceLimit.mockResolvedValueOnce({
      outcome: 'created',
      session: { id: 's3', workspaceId: 'w1' },
    });

    await expect(
      caller.createSession({
        workspaceId: 'w1',
        workflow: 'user',
        initialMessage: 'Start here',
      })
    ).resolves.toEqual({ id: 's3', workspaceId: 'w1' });

    expect(mockSessionDataService.createAgentSessionWithinWorkspaceLimit).toHaveBeenLastCalledWith({
      workspaceId: 'w1',
      name: undefined,
      workflow: 'user',
      model: undefined,
      provider: SessionProvider.CODEX,
      maxSessions: 2,
    });
    expect(mockSessionProviderResolverService.resolveSessionProvider).toHaveBeenCalledWith({
      workspaceId: 'w1',
      explicitProvider: undefined,
    });
    expect(cliHealthService.checkHealth).toHaveBeenCalledWith();
    expect(mockSessionDomainService.storeInitialMessage).toHaveBeenCalledWith('s3', 'Start here');
  });

  it('blocks creating a session when the selected provider is unavailable', async () => {
    const { caller, cliHealthService } = createCaller();
    mockSessionProviderResolverService.resolveSessionProvider.mockResolvedValue(
      SessionProvider.CODEX
    );
    cliHealthService.checkHealth.mockResolvedValue({
      claude: { isInstalled: true },
      codex: { isInstalled: false, isAuthenticated: false, error: 'Codex CLI is not installed.' },
      github: { isInstalled: true, isAuthenticated: true },
      allHealthy: true,
    });

    await expect(
      caller.createSession({
        workspaceId: 'w1',
        workflow: 'user',
      })
    ).rejects.toThrow('Codex provider is unavailable');
    expect(mockSessionDataService.createAgentSessionWithinWorkspaceLimit).not.toHaveBeenCalled();
  });

  it('creates and starts a session in one mutation', async () => {
    const { caller, sessionService } = createCaller();
    mockSessionProviderResolverService.resolveSessionProvider.mockResolvedValue(
      SessionProvider.CLAUDE
    );
    mockSessionDataService.createAgentSessionWithinWorkspaceLimit.mockResolvedValue({
      outcome: 'created',
      session: {
        id: 's-started',
        workspaceId: 'w1',
      },
    });
    mockSessionDataService.findAgentSessionById.mockResolvedValue({
      id: 's-started',
      workspaceId: 'w1',
      status: 'RUNNING',
    });

    await expect(
      caller.createAndStartSession({
        workspaceId: 'w1',
        workflow: 'followup',
        name: 'Chat 1',
        initialMessage: 'Stored before start',
        initialPrompt: '',
      })
    ).resolves.toEqual({ id: 's-started', workspaceId: 'w1', status: 'RUNNING' });

    expect(mockSessionDomainService.storeInitialMessage).toHaveBeenCalledWith(
      's-started',
      'Stored before start'
    );
    expect(sessionService.startSession).toHaveBeenCalledWith('s-started', {
      initialPrompt: '',
    });
    expect(mockSessionDataService.deleteAgentSession).not.toHaveBeenCalled();
  });

  it('deletes a newly created session when startup fails', async () => {
    const startupError = new Error('Runtime failed to start');
    const { caller, sessionService, sessionDomainService } = createCaller();
    mockSessionProviderResolverService.resolveSessionProvider.mockResolvedValue(
      SessionProvider.CLAUDE
    );
    mockSessionDataService.createAgentSessionWithinWorkspaceLimit.mockResolvedValue({
      outcome: 'created',
      session: {
        id: 's-orphan',
        workspaceId: 'w1',
      },
    });
    sessionService.startSession.mockRejectedValue(startupError);

    await expect(
      caller.createAndStartSession({
        workspaceId: 'w1',
        workflow: 'followup',
        name: 'Chat 1',
        initialPrompt: '',
      })
    ).rejects.toThrow('Runtime failed to start');

    expect(sessionService.stopSession).toHaveBeenCalledWith('s-orphan', {
      cleanupTransientRatchetSession: false,
    });
    expect(sessionDomainService.clearSession).toHaveBeenCalledWith('s-orphan');
    expect(mockSessionDataService.deleteAgentSession).toHaveBeenCalledWith('s-orphan');
  });

  it('marks the created session failed when startup rollback deletion fails', async () => {
    const startupError = new Error('Runtime failed to start');
    const { caller, sessionService, sessionDomainService } = createCaller();
    mockSessionProviderResolverService.resolveSessionProvider.mockResolvedValue(
      SessionProvider.CLAUDE
    );
    mockSessionDataService.createAgentSessionWithinWorkspaceLimit.mockResolvedValue({
      outcome: 'created',
      session: {
        id: 's-cleanup-fails',
        workspaceId: 'w1',
      },
    });
    sessionService.startSession.mockRejectedValue(startupError);
    sessionService.stopSession.mockRejectedValue(new Error('Stop failed'));
    mockSessionDataService.deleteAgentSession.mockRejectedValue(new Error('Delete failed'));

    await expect(
      caller.createAndStartSession({
        workspaceId: 'w1',
        workflow: 'followup',
        name: 'Chat 1',
      })
    ).rejects.toThrow('Runtime failed to start');

    expect(sessionDomainService.clearSession).toHaveBeenCalledWith('s-cleanup-fails');
    expect(mockSessionDataService.deleteAgentSession).toHaveBeenCalledWith('s-cleanup-fails');
    expect(mockSessionDataService.updateAgentSession).toHaveBeenCalledWith('s-cleanup-fails', {
      status: SessionStatus.FAILED,
      providerProcessPid: null,
      providerMetadata: {
        rollbackReason: 'startup_failed_after_create',
      },
    });
  });

  it('preserves startup errors even when rollback repair also fails', async () => {
    const startupError = new Error('Runtime failed to start');
    const { caller, sessionService, sessionDomainService } = createCaller();
    mockSessionProviderResolverService.resolveSessionProvider.mockResolvedValue(
      SessionProvider.CLAUDE
    );
    mockSessionDataService.createAgentSessionWithinWorkspaceLimit.mockResolvedValue({
      outcome: 'created',
      session: {
        id: 's-repair-fails',
        workspaceId: 'w1',
      },
    });
    sessionService.startSession.mockRejectedValue(startupError);
    mockSessionDataService.deleteAgentSession.mockRejectedValue(new Error('Delete failed'));
    mockSessionDataService.updateAgentSession.mockRejectedValue(new Error('Update failed'));

    await expect(
      caller.createAndStartSession({
        workspaceId: 'w1',
        workflow: 'followup',
        name: 'Chat 1',
      })
    ).rejects.toThrow('Runtime failed to start');

    expect(sessionDomainService.clearSession).toHaveBeenCalledWith('s-repair-fails');
    expect(mockSessionDataService.deleteAgentSession).toHaveBeenCalledWith('s-repair-fails');
    expect(mockSessionDataService.updateAgentSession).toHaveBeenCalledWith('s-repair-fails', {
      status: SessionStatus.FAILED,
      providerProcessPid: null,
      providerMetadata: {
        rollbackReason: 'startup_failed_after_create',
      },
    });
  });

  it('handles start/stop/delete flows and terminal session procedures', async () => {
    const { caller, sessionService, sessionDomainService } = createCaller();
    mockSessionDataService.findAgentSessionById.mockResolvedValue({ id: 's1' });
    mockSessionDataService.deleteAgentSession.mockResolvedValue({ deleted: true });
    mockTerminalSessionService.findByWorkspaceId.mockResolvedValue([{ id: 't1' }]);
    mockTerminalSessionService.findById.mockResolvedValue({ id: 't1' });
    mockTerminalSessionService.create.mockResolvedValue({ id: 't2' });
    mockTerminalSessionService.update.mockResolvedValue({ id: 't2', name: 'renamed' });
    mockTerminalSessionService.delete.mockResolvedValue({ deleted: true });

    await caller.startSession({ id: 's1', initialPrompt: 'hello' });
    await caller.stopSession({ id: 's1' });
    await caller.deleteSession({ id: 's1' });

    expect(sessionService.startSession).toHaveBeenCalledWith('s1', { initialPrompt: 'hello' });
    expect(sessionService.stopSession).toHaveBeenCalledWith('s1', {
      cleanupTransientRatchetSession: false,
    });
    expect(sessionDomainService.clearSession).toHaveBeenCalledWith('s1');

    await expect(caller.listTerminalSessions({ workspaceId: 'w1' })).resolves.toEqual([
      { id: 't1' },
    ]);
    await expect(caller.getTerminalSession({ id: 't1' })).resolves.toEqual({ id: 't1' });
    await expect(caller.createTerminalSession({ workspaceId: 'w1' })).resolves.toEqual({
      id: 't2',
    });
    await expect(caller.updateTerminalSession({ id: 't2', name: 'renamed' })).resolves.toEqual({
      id: 't2',
      name: 'renamed',
    });
    await expect(caller.deleteTerminalSession({ id: 't2' })).resolves.toEqual({ deleted: true });
  });
});
