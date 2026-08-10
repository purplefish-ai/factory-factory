import { SessionProvider } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIHealthStatus } from '@/backend/orchestration/cli-health.service';
import { AcpRuntimeManager } from '@/backend/services/session';
import { SessionStatus } from '@/shared/core';

const mockSessionDataService = vi.hoisted(() => ({
  findAgentSessionsByWorkspaceId: vi.fn(),
  countActiveAgentSessionsByWorkspaceId: vi.fn(),
  findAgentSessionById: vi.fn(),
  createAgentSession: vi.fn(),
  createAgentSessionWithinWorkspaceLimit: vi.fn(),
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

import { sessionRouter } from './session.trpc';

function createCaller(options?: { acpRuntimeManager?: AcpRuntimeManager }) {
  const acpRuntimeManager = {
    isSessionWorking: vi.fn((id: string) => id === 's-working'),
    getSubagentBrowseCapability: vi.fn(),
    listSubagents: vi.fn(),
    readSubagentTranscript: vi.fn(),
  };
  const sessionLifecycleService = {
    startSession: vi.fn(async () => undefined),
    stopSession: vi.fn(async () => undefined),
    persistClosedSession: vi.fn(async () => undefined),
    ensureSubagentBrowseSession: vi.fn(async () => false),
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
          acpRuntimeManager: options?.acpRuntimeManager ?? acpRuntimeManager,
          sessionLifecycleService,
          sessionDomainService,
          sessionDataService: mockSessionDataService,
          terminalSessionService: {
            findWorkspaceSessions: mockSessionDataService.findTerminalSessionsByWorkspaceId,
            findSession: mockSessionDataService.findTerminalSessionById,
            registerSession: mockSessionDataService.createTerminalSession,
            renameSession: mockSessionDataService.updateTerminalSession,
            removeSession: mockSessionDataService.deleteTerminalSession,
          },
          sessionProviderResolverService: mockSessionProviderResolverService,
          cliHealthService,
          listQuickActions: () => mockListQuickActions(),
          getQuickAction: (id: string) => mockGetQuickAction(id),
        },
      },
    } as never),
    acpRuntimeManager,
    sessionLifecycleService,
    sessionDomainService,
    cliHealthService,
  };
}

function createSubagentRuntimeManager(
  extMethod: (method: string, params: Record<string, unknown>) => Promise<unknown>
): AcpRuntimeManager {
  const manager = new AcpRuntimeManager();
  const handle = {
    providerSessionId: 'provider-session-1',
    connection: { extMethod: vi.fn(extMethod) },
    isRunning: () => true,
    getSubagentBrowseCapability: () => ({
      version: 1 as const,
      list: true as const,
      read: true as const,
      notifications: true as const,
    }),
  };
  (
    manager as unknown as {
      sessions: Map<string, typeof handle>;
    }
  ).sessions.set('session-1', handle);
  return manager;
}

describe('sessionRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionDataService.createAgentSessionWithinWorkspaceLimit.mockResolvedValue({
      outcome: 'created',
      session: { id: 's-new', workspaceId: 'w1' },
    });
  });

  describe('sub-agent browsing', () => {
    it('waits for parent restoration before checking negotiated browse capability', async () => {
      const { caller, acpRuntimeManager, sessionLifecycleService } = createCaller();
      let resolveRestoration!: (restored: boolean) => void;
      sessionLifecycleService.ensureSubagentBrowseSession.mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          resolveRestoration = resolve;
        })
      );
      acpRuntimeManager.getSubagentBrowseCapability.mockReturnValue({
        version: 1,
        list: true,
        read: true,
        notifications: true,
      });
      acpRuntimeManager.listSubagents.mockResolvedValue({ subagents: [], nextCursor: null });

      const result = caller.listSubagents({ sessionId: 'session-1', limit: 50 });
      await vi.waitFor(() => {
        expect(sessionLifecycleService.ensureSubagentBrowseSession).toHaveBeenCalledWith(
          'session-1'
        );
      });
      expect(acpRuntimeManager.getSubagentBrowseCapability).not.toHaveBeenCalled();

      resolveRestoration(true);
      await expect(result).resolves.toEqual({
        supported: true,
        subagents: [],
        nextCursor: null,
      });
    });

    it('returns unsupported without calling the adapter when no live capability exists', async () => {
      const { caller, acpRuntimeManager } = createCaller();
      acpRuntimeManager.getSubagentBrowseCapability.mockReturnValue(null);

      await expect(caller.listSubagents({ sessionId: 'session-1', limit: 50 })).resolves.toEqual({
        supported: false,
      });
      expect(acpRuntimeManager.listSubagents).not.toHaveBeenCalled();
    });

    it('returns a supported empty list', async () => {
      const { caller, acpRuntimeManager } = createCaller();
      acpRuntimeManager.getSubagentBrowseCapability.mockReturnValue({
        version: 1,
        list: true,
        read: true,
        notifications: true,
      });
      acpRuntimeManager.listSubagents.mockResolvedValue({ subagents: [], nextCursor: null });

      await expect(caller.listSubagents({ sessionId: 'session-1', limit: 50 })).resolves.toEqual({
        supported: true,
        subagents: [],
        nextCursor: null,
      });
    });

    it('forwards list cursors without exposing provider details', async () => {
      const { caller, acpRuntimeManager } = createCaller();
      acpRuntimeManager.getSubagentBrowseCapability.mockReturnValue({
        version: 1,
        list: true,
        read: true,
        notifications: true,
      });
      acpRuntimeManager.listSubagents.mockResolvedValue({
        subagents: [],
        nextCursor: 'list-cursor-8',
      });

      await caller.listSubagents({
        sessionId: 'session-1',
        cursor: 'list-cursor-7',
        limit: 25,
      });

      expect(acpRuntimeManager.listSubagents).toHaveBeenCalledWith('session-1', {
        cursor: 'list-cursor-7',
        limit: 25,
      });
    });

    it('forwards transcript reads', async () => {
      const { caller, acpRuntimeManager } = createCaller();
      acpRuntimeManager.getSubagentBrowseCapability.mockReturnValue({
        version: 1,
        list: true,
        read: true,
        notifications: true,
      });
      acpRuntimeManager.readSubagentTranscript.mockResolvedValue({
        projectionBoundary: 'turn',
        updates: [],
        nextCursor: null,
      });

      await expect(
        caller.readSubagentTranscript({
          sessionId: 'session-1',
          subagentId: 'child-1',
          cursor: null,
          limit: 10,
        })
      ).resolves.toEqual({ projectionBoundary: 'turn', updates: [], nextCursor: null });
      expect(acpRuntimeManager.readSubagentTranscript).toHaveBeenCalledWith('session-1', {
        subagentId: 'child-1',
        cursor: null,
        limit: 10,
      });
    });

    it('returns a typed precondition error when transcript browsing is unsupported', async () => {
      const { caller, acpRuntimeManager } = createCaller();
      acpRuntimeManager.getSubagentBrowseCapability.mockReturnValue(null);

      await expect(
        caller.readSubagentTranscript({
          sessionId: 'session-1',
          subagentId: 'child-1',
          cursor: null,
          limit: 10,
        })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(acpRuntimeManager.readSubagentTranscript).not.toHaveBeenCalled();
    });

    it('maps an invalid transcript cursor to a safe BAD_REQUEST', async () => {
      const runtime = createSubagentRuntimeManager(() =>
        Promise.reject({
          code: -32_602,
          message: 'Invalid params: provider cursor parser secret',
          data: { cursor: 'invalid' },
        })
      );
      const { caller } = createCaller({ acpRuntimeManager: runtime });

      await expect(
        caller.readSubagentTranscript({
          sessionId: 'session-1',
          subagentId: 'child-1',
          cursor: 'invalid',
          limit: 10,
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Invalid sub-agent transcript request.',
      });
    });

    it('maps a foreign child to a safe NOT_FOUND', async () => {
      const runtime = createSubagentRuntimeManager(() =>
        Promise.reject({
          code: -32_002,
          message: 'Resource not found: provider thread secret',
        })
      );
      const { caller } = createCaller({ acpRuntimeManager: runtime });

      await expect(
        caller.readSubagentTranscript({
          sessionId: 'session-1',
          subagentId: 'foreign-child',
          cursor: null,
          limit: 10,
        })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Sub-agent transcript not found for this session.',
      });
    });

    it.each([
      {
        label: 'malformed provider response',
        extMethod: () =>
          Promise.resolve({
            projectionBoundary: 'turn',
            updates: [{ sessionUpdate: 'unknown' }],
            nextCursor: null,
          }),
      },
      {
        label: 'provider protocol error',
        extMethod: () =>
          Promise.reject({
            code: -32_603,
            message: 'Internal error: provider response IDs did not match',
          }),
      },
    ])('maps a $label to a safe PRECONDITION_FAILED', async ({ extMethod }) => {
      const runtime = createSubagentRuntimeManager(extMethod);
      const { caller } = createCaller({ acpRuntimeManager: runtime });

      await expect(
        caller.readSubagentTranscript({
          sessionId: 'session-1',
          subagentId: 'child-1',
          cursor: null,
          limit: 10,
        })
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message:
          'Sub-agent transcript is unavailable because the provider returned an invalid response.',
      });
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
    const { caller, sessionLifecycleService } = createCaller();
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
    expect(sessionLifecycleService.startSession).toHaveBeenCalledWith('s-started', {
      initialPrompt: '',
    });
    expect(mockSessionDataService.deleteAgentSession).not.toHaveBeenCalled();
  });

  it('deletes a newly created session when startup fails', async () => {
    const startupError = new Error('Runtime failed to start');
    const { caller, sessionLifecycleService, sessionDomainService } = createCaller();
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
    sessionLifecycleService.startSession.mockRejectedValue(startupError);

    await expect(
      caller.createAndStartSession({
        workspaceId: 'w1',
        workflow: 'followup',
        name: 'Chat 1',
        initialPrompt: '',
      })
    ).rejects.toThrow('Runtime failed to start');

    expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('s-orphan', {
      cleanupTransientRatchetSession: false,
      recordLifecycleEvent: false,
    });
    expect(sessionDomainService.clearSession).toHaveBeenCalledWith('s-orphan');
    expect(mockSessionDataService.deleteAgentSession).toHaveBeenCalledWith('s-orphan');
  });

  it('marks the created session failed when startup rollback deletion fails', async () => {
    const startupError = new Error('Runtime failed to start');
    const { caller, sessionLifecycleService, sessionDomainService } = createCaller();
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
    sessionLifecycleService.startSession.mockRejectedValue(startupError);
    sessionLifecycleService.stopSession.mockRejectedValue(new Error('Stop failed'));
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
    const { caller, sessionLifecycleService, sessionDomainService } = createCaller();
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
    sessionLifecycleService.startSession.mockRejectedValue(startupError);
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
    const { caller, sessionLifecycleService, sessionDomainService } = createCaller();
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

    expect(sessionLifecycleService.startSession).toHaveBeenCalledWith('s1', {
      initialPrompt: 'hello',
    });
    expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('s1', {
      cleanupTransientRatchetSession: false,
      reason: 'USER_STOP',
    });
    expect(sessionLifecycleService.persistClosedSession).toHaveBeenCalledWith('s1');
    expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('s1', {
      cleanupTransientRatchetSession: false,
      reason: 'SESSION_CLOSED',
    });
    expect(sessionDomainService.clearSession).toHaveBeenCalledWith('s1');
    expect(sessionLifecycleService.stopSession.mock.invocationCallOrder[1]).toBeLessThan(
      sessionLifecycleService.persistClosedSession.mock.invocationCallOrder[0]!
    );
    expect(sessionLifecycleService.persistClosedSession.mock.invocationCallOrder[0]).toBeLessThan(
      sessionDomainService.clearSession.mock.invocationCallOrder[0]!
    );
    expect(sessionDomainService.clearSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockSessionDataService.deleteAgentSession.mock.invocationCallOrder[0]!
    );

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
