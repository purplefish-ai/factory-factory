import { SessionProvider } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIHealthStatus } from '@/backend/orchestration/cli-health.service';

const mockSessionDataService = vi.hoisted(() => ({
  findAgentSessionsByWorkspaceId: vi.fn(),
  findAgentSessionById: vi.fn(),
  createAgentSession: vi.fn(),
  updateAgentSession: vi.fn(),
  deleteAgentSession: vi.fn(),
  findTerminalSessionsByWorkspaceId: vi.fn(),
  findTerminalSessionById: vi.fn(),
  createTerminalSession: vi.fn(),
  updateTerminalSession: vi.fn(),
  deleteTerminalSession: vi.fn(),
}));

const mockSessionDomainService = vi.hoisted(() => ({
  storeInitialMessage: vi.fn(),
}));

const mockSessionProviderResolverService = vi.hoisted(() => ({
  resolveSessionProvider: vi.fn(),
}));

const mockListQuickActions = vi.hoisted(() => vi.fn());
const mockGetQuickAction = vi.hoisted(() => vi.fn());

vi.mock('@/backend/domains/session', () => ({
  sessionDataService: mockSessionDataService,
  sessionDomainService: mockSessionDomainService,
  sessionProviderResolverService: mockSessionProviderResolverService,
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

    mockSessionDataService.findAgentSessionsByWorkspaceId.mockResolvedValue([
      { id: 's1' },
      { id: 's2' },
    ]);
    await expect(
      caller.createSession({
        workspaceId: 'w1',
        workflow: 'user',
      })
    ).rejects.toThrow('Maximum sessions per workspace (2) reached');

    mockSessionDataService.findAgentSessionsByWorkspaceId.mockResolvedValue([{ id: 's1' }]);
    mockSessionProviderResolverService.resolveSessionProvider.mockResolvedValue(
      SessionProvider.CODEX
    );
    mockSessionDataService.createAgentSession.mockResolvedValue({ id: 's3', workspaceId: 'w1' });

    await expect(
      caller.createSession({
        workspaceId: 'w1',
        workflow: 'user',
        initialMessage: 'Start here',
      })
    ).resolves.toEqual({ id: 's3', workspaceId: 'w1' });

    expect(mockSessionProviderResolverService.resolveSessionProvider).toHaveBeenCalledWith({
      workspaceId: 'w1',
      explicitProvider: undefined,
    });
    expect(cliHealthService.checkHealth).toHaveBeenCalledWith();
    expect(mockSessionDomainService.storeInitialMessage).toHaveBeenCalledWith('s3', 'Start here');
  });

  it('blocks creating a session when the selected provider is unavailable', async () => {
    const { caller, cliHealthService } = createCaller();
    mockSessionDataService.findAgentSessionsByWorkspaceId.mockResolvedValue([{ id: 's1' }]);
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
    expect(mockSessionDataService.createAgentSession).not.toHaveBeenCalled();
  });

  it('handles start/stop/delete flows and terminal session procedures', async () => {
    const { caller, sessionService, sessionDomainService } = createCaller();
    mockSessionDataService.findAgentSessionById.mockResolvedValue({ id: 's1' });
    mockSessionDataService.deleteAgentSession.mockResolvedValue({ deleted: true });
    mockSessionDataService.findTerminalSessionsByWorkspaceId.mockResolvedValue([{ id: 't1' }]);
    mockSessionDataService.findTerminalSessionById.mockResolvedValue({ id: 't1' });
    mockSessionDataService.createTerminalSession.mockResolvedValue({ id: 't2' });
    mockSessionDataService.updateTerminalSession.mockResolvedValue({ id: 't2', name: 'renamed' });
    mockSessionDataService.deleteTerminalSession.mockResolvedValue({ deleted: true });

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
