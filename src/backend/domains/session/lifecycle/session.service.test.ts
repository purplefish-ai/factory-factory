import { SessionStatus } from '@factory-factory/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeClient } from '@/backend/domains/session/claude/client';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

type CodexManagerHandlersMock = {
  onNotification?: (event: { sessionId: string; method: string; params: unknown }) => void;
  onServerRequest?: (event: {
    sessionId: string;
    method: string;
    params: unknown;
    canonicalRequestId: string;
  }) => void;
};

const codexTestState = vi.hoisted(() => ({
  codexRegistry: {
    setActiveTurnId: vi.fn(),
    markTurnTerminal: vi.fn(),
  },
  codexManagerHandlers: null as CodexManagerHandlersMock | null,
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('./session.repository', () => ({
  SessionRepository: class {},
  sessionRepository: {
    getSessionById: vi.fn(),
    getSessionsByWorkspaceId: vi.fn(),
    getWorkspaceById: vi.fn(),
    getProjectById: vi.fn(),
    markWorkspaceHasHadSessions: vi.fn(),
    updateSession: vi.fn(),
    clearRatchetActiveSession: vi.fn(),
    deleteSession: vi.fn(),
  },
}));

vi.mock('./session.prompt-builder', () => ({
  SessionPromptBuilder: class {},
  sessionPromptBuilder: {
    shouldInjectBranchRename: vi.fn(),
    buildSystemPrompt: vi.fn(),
  },
}));

vi.mock('@/backend/domains/session/providers', () => ({
  ClaudeSessionProviderAdapter: vi.fn(),
  claudeSessionProviderAdapter: {
    setOnClientCreated: vi.fn(),
    isStopInProgress: vi.fn(),
    getOrCreateClient: vi.fn(),
    getClient: vi.fn(),
    getPendingClient: vi.fn(),
    stopClient: vi.fn(),
    sendMessage: vi.fn(),
    setModel: vi.fn(),
    setThinkingBudget: vi.fn(),
    rewindFiles: vi.fn(),
    respondToPermission: vi.fn(),
    respondToQuestion: vi.fn(),
    toCanonicalAgentMessage: vi.fn((message, order) => ({
      type: 'agent_message',
      provider: 'CLAUDE',
      kind: 'provider_event',
      ...(order === undefined ? {} : { order }),
      data: message,
    })),
    toPublicDeltaEvent: vi.fn((event) =>
      event.order === undefined
        ? ({ type: 'agent_message', data: event.data } as const)
        : ({ type: 'agent_message', data: event.data, order: event.order } as const)
    ),
    getSessionProcess: vi.fn(),
    isSessionRunning: vi.fn(),
    isSessionWorking: vi.fn(),
    isAnySessionWorking: vi.fn(),
    getAllActiveProcesses: vi.fn(),
    getAllClients: vi.fn(),
    stopAllClients: vi.fn(),
  },
  codexSessionProviderAdapter: {
    getManager: vi.fn(() => ({
      setHandlers: vi.fn((handlers) => {
        codexTestState.codexManagerHandlers = handlers;
      }),
      getRegistry: vi.fn(() => codexTestState.codexRegistry),
      getStatus: vi.fn(() => ({
        state: 'stopped',
        unavailableReason: null,
        pid: null,
        startedAt: null,
        restartCount: 0,
        activeSessionCount: 0,
      })),
    })),
    rejectInteractiveRequest: vi.fn(),
    getClient: vi.fn(),
    getPendingClient: vi.fn(),
    isStopInProgress: vi.fn(),
    stopClient: vi.fn(),
    sendMessage: vi.fn(),
    setModel: vi.fn(),
    setThinkingBudget: vi.fn(),
    rewindFiles: vi.fn(),
    respondToPermission: vi.fn(),
    respondToQuestion: vi.fn(),
    isSessionRunning: vi.fn(),
    isSessionWorking: vi.fn(),
    getSessionProcess: vi.fn(),
    isAnySessionWorking: vi.fn(),
    getAllClients: vi.fn(() => new Map().entries()),
    getAllActiveProcesses: vi.fn(() => []),
    stopAllClients: vi.fn(),
  },
}));

import {
  claudeSessionProviderAdapter,
  codexSessionProviderAdapter,
} from '@/backend/domains/session/providers';
import { sessionPromptBuilder } from './session.prompt-builder';
import { sessionRepository } from './session.repository';
import { sessionService } from './session.service';

describe('SessionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claudeSessionProviderAdapter.getClient).mockReturnValue(undefined);
    vi.mocked(claudeSessionProviderAdapter.getPendingClient).mockReturnValue(undefined);
    vi.mocked(claudeSessionProviderAdapter.isStopInProgress).mockReturnValue(false);
    vi.mocked(claudeSessionProviderAdapter.isSessionWorking).mockReturnValue(false);
    vi.mocked(codexSessionProviderAdapter.getClient).mockReturnValue(undefined);
    vi.mocked(codexSessionProviderAdapter.getPendingClient).mockReturnValue(undefined);
    vi.mocked(codexSessionProviderAdapter.isStopInProgress).mockReturnValue(false);
    vi.mocked(codexSessionProviderAdapter.isSessionWorking).mockReturnValue(false);
  });

  it('starts a session via process manager and updates DB state', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      claudeSessionId: null,
    });

    const workspace = unsafeCoerce<Awaited<ReturnType<typeof sessionRepository.getWorkspaceById>>>({
      id: 'workspace-1',
      worktreePath: '/tmp/work',
      branchName: 'auto-branch',
      isAutoGeneratedBranch: true,
      hasHadSessions: false,
      name: 'Workspace A',
      description: null,
      projectId: 'project-1',
    });

    const project = unsafeCoerce<Awaited<ReturnType<typeof sessionRepository.getProjectById>>>({
      id: 'project-1',
      githubOwner: 'owner',
    });

    const client = unsafeCoerce<
      Awaited<ReturnType<typeof claudeSessionProviderAdapter.getOrCreateClient>>
    >({
      getPid: vi.fn().mockReturnValue(123),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });

    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(session);
    vi.mocked(sessionRepository.getWorkspaceById).mockResolvedValue(workspace);
    vi.mocked(sessionRepository.getProjectById).mockResolvedValue(project);
    vi.mocked(sessionRepository.markWorkspaceHasHadSessions).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue(session);

    vi.mocked(sessionPromptBuilder.shouldInjectBranchRename).mockReturnValue(true);
    vi.mocked(sessionPromptBuilder.buildSystemPrompt).mockReturnValue({
      workflowPrompt: 'workflow',
      systemPrompt: 'system',
      injectedBranchRename: true,
    });

    vi.mocked(claudeSessionProviderAdapter.isStopInProgress).mockReturnValue(false);
    vi.mocked(claudeSessionProviderAdapter.getOrCreateClient).mockResolvedValue(client);

    await sessionService.startClaudeSession('session-1', { initialPrompt: 'Hello' });

    expect(sessionPromptBuilder.shouldInjectBranchRename).toHaveBeenCalledWith({
      branchName: 'auto-branch',
      isAutoGeneratedBranch: true,
      hasHadSessions: false,
    });
    expect(sessionRepository.markWorkspaceHasHadSessions).toHaveBeenCalledWith('workspace-1');
    expect(claudeSessionProviderAdapter.getOrCreateClient).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        workingDir: '/tmp/work',
        systemPrompt: 'system',
        model: 'sonnet',
        permissionMode: 'bypassPermissions',
        includePartialMessages: false,
        sessionId: 'session-1',
      }),
      expect.any(Object),
      { workspaceId: 'workspace-1', workingDir: '/tmp/work' }
    );
    expect(sessionRepository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.RUNNING,
      claudeProcessPid: 123,
    });
    expect(claudeSessionProviderAdapter.sendMessage).toHaveBeenCalledWith('session-1', 'Hello');
  });

  it('returns existing client without loading options', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      provider: 'CLAUDE',
      claudeSessionId: null,
    });
    const client = unsafeCoerce<Awaited<ReturnType<typeof claudeSessionProviderAdapter.getClient>>>(
      {
        isRunning: vi.fn().mockReturnValue(true),
      }
    );

    vi.mocked(claudeSessionProviderAdapter.getClient).mockReturnValue(client);
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(session);

    const result = await sessionService.getOrCreateClient('session-1');

    expect(result).toBe(client);
    expect(claudeSessionProviderAdapter.getOrCreateClient).not.toHaveBeenCalled();
    expect(sessionRepository.getSessionById).toHaveBeenCalledWith('session-1');
  });

  it('delegates to processManager.getOrCreateClient for race protection', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      claudeSessionId: null,
    });

    const workspace = unsafeCoerce<Awaited<ReturnType<typeof sessionRepository.getWorkspaceById>>>({
      id: 'workspace-1',
      worktreePath: '/tmp/work',
      branchName: 'feature-branch',
      isAutoGeneratedBranch: false,
      name: 'Workspace A',
      description: null,
      projectId: 'project-1',
    });

    const client = unsafeCoerce<
      Awaited<ReturnType<typeof claudeSessionProviderAdapter.getOrCreateClient>>
    >({
      getPid: vi.fn().mockReturnValue(456),
    });

    vi.mocked(claudeSessionProviderAdapter.getClient).mockReturnValue(undefined);
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(session);
    vi.mocked(sessionRepository.getWorkspaceById).mockResolvedValue(workspace);
    vi.mocked(sessionRepository.markWorkspaceHasHadSessions).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue(session);

    vi.mocked(sessionPromptBuilder.shouldInjectBranchRename).mockReturnValue(false);
    vi.mocked(sessionPromptBuilder.buildSystemPrompt).mockReturnValue({
      workflowPrompt: undefined,
      systemPrompt: undefined,
      injectedBranchRename: false,
    });

    vi.mocked(claudeSessionProviderAdapter.getOrCreateClient).mockResolvedValue(client);

    const result = await sessionService.getOrCreateClient('session-1');

    expect(result).toBe(client);
    expect(claudeSessionProviderAdapter.getOrCreateClient).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        workingDir: '/tmp/work',
        sessionId: 'session-1',
      }),
      expect.any(Object),
      expect.objectContaining({
        workspaceId: 'workspace-1',
        workingDir: '/tmp/work',
      })
    );
    expect(sessionRepository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.RUNNING,
      claudeProcessPid: 456,
    });
  });

  it('skips stop when already stopping', async () => {
    vi.mocked(claudeSessionProviderAdapter.isStopInProgress).mockReturnValue(true);

    await sessionService.stopClaudeSession('session-1');

    expect(claudeSessionProviderAdapter.stopClient).not.toHaveBeenCalled();
    expect(sessionRepository.updateSession).not.toHaveBeenCalled();
  });

  it('clears queued work during manual stop', async () => {
    vi.mocked(claudeSessionProviderAdapter.isStopInProgress).mockReturnValue(false);
    vi.mocked(claudeSessionProviderAdapter.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);
    const clearQueuedWorkSpy = vi.spyOn(sessionDomainService, 'clearQueuedWork');

    await sessionService.stopClaudeSession('session-1');

    expect(clearQueuedWorkSpy).toHaveBeenCalledWith('session-1', { emitSnapshot: false });
  });

  it('deletes ratchet session record during manual stop', async () => {
    vi.mocked(claudeSessionProviderAdapter.isStopInProgress).mockReturnValue(false);
    vi.mocked(claudeSessionProviderAdapter.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(
      unsafeCoerce({
        id: 'session-1',
        workspaceId: 'workspace-1',
        workflow: 'ratchet',
      })
    );
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);
    vi.mocked(sessionRepository.clearRatchetActiveSession).mockResolvedValue();
    vi.mocked(sessionRepository.deleteSession).mockResolvedValue({} as never);

    await sessionService.stopClaudeSession('session-1');

    expect(sessionRepository.clearRatchetActiveSession).toHaveBeenCalledWith(
      'workspace-1',
      'session-1'
    );
    expect(sessionRepository.deleteSession).toHaveBeenCalledWith('session-1');
  });

  it('does not delete non-ratchet session during manual stop', async () => {
    vi.mocked(claudeSessionProviderAdapter.isStopInProgress).mockReturnValue(false);
    vi.mocked(claudeSessionProviderAdapter.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(
      unsafeCoerce({
        id: 'session-2',
        workspaceId: 'workspace-1',
        workflow: 'default',
      })
    );
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);

    await sessionService.stopClaudeSession('session-2');

    expect(sessionRepository.deleteSession).not.toHaveBeenCalled();
  });

  it('clears ratchet pointer but does not delete session when transient cleanup is disabled', async () => {
    vi.mocked(claudeSessionProviderAdapter.isStopInProgress).mockReturnValue(false);
    vi.mocked(claudeSessionProviderAdapter.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(
      unsafeCoerce({
        id: 'session-3',
        workspaceId: 'workspace-1',
        workflow: 'ratchet',
      })
    );
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);

    await sessionService.stopClaudeSession('session-3', {
      cleanupTransientRatchetSession: false,
    });

    expect(sessionRepository.clearRatchetActiveSession).toHaveBeenCalledWith(
      'workspace-1',
      'session-3'
    );
    expect(sessionRepository.deleteSession).not.toHaveBeenCalled();
  });

  it('still stops process and clears queued work when session lookup fails', async () => {
    vi.mocked(claudeSessionProviderAdapter.isStopInProgress).mockReturnValue(false);
    vi.mocked(sessionRepository.getSessionById).mockRejectedValueOnce(new Error('db unavailable'));
    vi.mocked(claudeSessionProviderAdapter.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockRejectedValueOnce(new Error('missing row'));
    const clearQueuedWorkSpy = vi.spyOn(sessionDomainService, 'clearQueuedWork');

    await expect(sessionService.stopClaudeSession('session-err')).resolves.toBeUndefined();

    expect(claudeSessionProviderAdapter.stopClient).toHaveBeenCalledWith('session-err');
    expect(clearQueuedWorkSpy).toHaveBeenCalledWith('session-err', { emitSnapshot: false });
  });

  it('marks process as stopped when client creation fails', async () => {
    const session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      claudeSessionId: null,
    } as unknown as NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>;

    const workspace = {
      id: 'workspace-1',
      worktreePath: '/tmp/work',
      branchName: 'feature-branch',
      isAutoGeneratedBranch: false,
      name: 'Workspace A',
      description: null,
      projectId: 'project-1',
    } as unknown as Awaited<ReturnType<typeof sessionRepository.getWorkspaceById>>;

    vi.mocked(claudeSessionProviderAdapter.getClient).mockReturnValue(undefined);
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(session);
    vi.mocked(sessionRepository.getWorkspaceById).mockResolvedValue(workspace);
    vi.mocked(sessionRepository.markWorkspaceHasHadSessions).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue(session);
    vi.mocked(sessionPromptBuilder.shouldInjectBranchRename).mockReturnValue(false);
    vi.mocked(sessionPromptBuilder.buildSystemPrompt).mockReturnValue({
      workflowPrompt: undefined,
      systemPrompt: undefined,
      injectedBranchRename: false,
    });
    vi.mocked(claudeSessionProviderAdapter.getOrCreateClient).mockRejectedValue(
      new Error('spawn failed')
    );
    const setRuntimeSnapshotSpy = vi.spyOn(sessionDomainService, 'setRuntimeSnapshot');

    await expect(sessionService.getOrCreateClient('session-1')).rejects.toThrow('spawn failed');

    expect(setRuntimeSnapshotSpy).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        phase: 'error',
        processState: 'stopped',
        activity: 'IDLE',
      })
    );
  });

  it('marks process as stopped when building client options fails', async () => {
    vi.mocked(claudeSessionProviderAdapter.getClient).mockReturnValue(undefined);
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(null);
    const setRuntimeSnapshotSpy = vi.spyOn(sessionDomainService, 'setRuntimeSnapshot');

    await expect(sessionService.getOrCreateClient('session-1')).rejects.toThrow(
      'Session not found: session-1'
    );

    expect(setRuntimeSnapshotSpy).not.toHaveBeenCalled();
  });

  it('returns null session options when workspace is missing', async () => {
    const session = unsafeCoerce<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      claudeSessionId: null,
    });

    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(session);
    vi.mocked(sessionRepository.getWorkspaceById).mockResolvedValue(null);

    const options = await sessionService.getSessionOptions('session-1');

    expect(options).toBeNull();
  });

  it('clears ratchetActiveSessionId and deletes session on ratchet exit', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'ratchet',
      model: 'sonnet',
      claudeSessionId: null,
    });

    const workspace = unsafeCoerce<Awaited<ReturnType<typeof sessionRepository.getWorkspaceById>>>({
      id: 'workspace-1',
      worktreePath: '/tmp/work',
      branchName: 'fix-branch',
      isAutoGeneratedBranch: false,
      name: 'Workspace A',
      description: null,
      projectId: 'project-1',
    });

    const project = unsafeCoerce<Awaited<ReturnType<typeof sessionRepository.getProjectById>>>({
      id: 'project-1',
      githubOwner: 'owner',
    });

    const client = unsafeCoerce<
      Awaited<ReturnType<typeof claudeSessionProviderAdapter.getOrCreateClient>>
    >({
      getPid: vi.fn().mockReturnValue(456),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });

    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(session);
    vi.mocked(sessionRepository.getWorkspaceById).mockResolvedValue(workspace);
    vi.mocked(sessionRepository.getProjectById).mockResolvedValue(project);
    vi.mocked(sessionRepository.markWorkspaceHasHadSessions).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue(session);
    vi.mocked(sessionRepository.clearRatchetActiveSession).mockResolvedValue();
    vi.mocked(sessionRepository.deleteSession).mockResolvedValue(session);

    vi.mocked(sessionPromptBuilder.shouldInjectBranchRename).mockReturnValue(false);
    vi.mocked(sessionPromptBuilder.buildSystemPrompt).mockReturnValue({
      workflowPrompt: 'workflow',
      systemPrompt: 'system',
      injectedBranchRename: false,
    });

    vi.mocked(claudeSessionProviderAdapter.isStopInProgress).mockReturnValue(false);
    vi.mocked(claudeSessionProviderAdapter.getOrCreateClient).mockResolvedValue(client);

    await sessionService.startClaudeSession('session-1');

    // Extract the onExit handler passed to processManager.getOrCreateClient
    const handlers = vi.mocked(claudeSessionProviderAdapter.getOrCreateClient).mock
      .calls[0]![2] as {
      onExit: (id: string) => Promise<void>;
    };
    await handlers.onExit('session-1');

    expect(sessionRepository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.COMPLETED,
      claudeProcessPid: null,
    });
    expect(sessionRepository.clearRatchetActiveSession).toHaveBeenCalledWith(
      'workspace-1',
      'session-1'
    );
    expect(sessionRepository.deleteSession).toHaveBeenCalledWith('session-1');
  });

  it('does not delete session on exit for non-ratchet workflows', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-2',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      claudeSessionId: null,
    });

    const workspace = unsafeCoerce<Awaited<ReturnType<typeof sessionRepository.getWorkspaceById>>>({
      id: 'workspace-1',
      worktreePath: '/tmp/work',
      branchName: 'fix-branch',
      isAutoGeneratedBranch: false,
      name: 'Workspace A',
      description: null,
      projectId: 'project-1',
    });

    const client = unsafeCoerce<
      Awaited<ReturnType<typeof claudeSessionProviderAdapter.getOrCreateClient>>
    >({
      getPid: vi.fn().mockReturnValue(789),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });

    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(session);
    vi.mocked(sessionRepository.getWorkspaceById).mockResolvedValue(workspace);
    vi.mocked(sessionRepository.markWorkspaceHasHadSessions).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue(session);
    vi.mocked(sessionRepository.clearRatchetActiveSession).mockResolvedValue();

    vi.mocked(sessionPromptBuilder.shouldInjectBranchRename).mockReturnValue(false);
    vi.mocked(sessionPromptBuilder.buildSystemPrompt).mockReturnValue({
      workflowPrompt: undefined,
      systemPrompt: undefined,
      injectedBranchRename: false,
    });

    vi.mocked(claudeSessionProviderAdapter.isStopInProgress).mockReturnValue(false);
    vi.mocked(claudeSessionProviderAdapter.getOrCreateClient).mockResolvedValue(client);

    await sessionService.startClaudeSession('session-2');

    const handlers = vi.mocked(claudeSessionProviderAdapter.getOrCreateClient).mock
      .calls[0]![2] as {
      onExit: (id: string) => Promise<void>;
    };
    await handlers.onExit('session-2');

    expect(sessionRepository.updateSession).toHaveBeenCalledWith('session-2', {
      status: SessionStatus.COMPLETED,
      claudeProcessPid: null,
    });
    expect(sessionRepository.deleteSession).not.toHaveBeenCalled();
  });

  it('stops sessions that are still starting when stopping a workspace', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionsByWorkspaceId>>>[number]
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
    });

    const client = { isRunning: vi.fn().mockReturnValue(true) };
    const pendingClient = Promise.resolve(unsafeCoerce<ClaudeClient>(client));

    vi.mocked(sessionRepository.getSessionsByWorkspaceId).mockResolvedValue([session]);
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(
      unsafeCoerce({
        ...session,
        provider: 'CLAUDE',
      })
    );
    vi.mocked(claudeSessionProviderAdapter.getPendingClient).mockReturnValue(pendingClient);
    vi.mocked(claudeSessionProviderAdapter.getSessionProcess).mockReturnValue(undefined);
    vi.mocked(claudeSessionProviderAdapter.isStopInProgress).mockReturnValue(false);
    vi.mocked(claudeSessionProviderAdapter.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue(session);

    await sessionService.stopWorkspaceSessions('workspace-1');

    expect(claudeSessionProviderAdapter.getPendingClient).toHaveBeenCalledWith('session-1');
    expect(claudeSessionProviderAdapter.stopClient).toHaveBeenCalledWith('session-1');
    expect(sessionRepository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.IDLE,
      claudeProcessPid: null,
    });
  });

  it('updates DB status when getOrCreateClient creates new client', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      claudeSessionId: null,
    });

    const workspace = unsafeCoerce<Awaited<ReturnType<typeof sessionRepository.getWorkspaceById>>>({
      id: 'workspace-1',
      worktreePath: '/tmp/work',
      branchName: 'feature-branch',
      isAutoGeneratedBranch: false,
      name: 'Workspace A',
      description: null,
      projectId: 'project-1',
    });

    const client = unsafeCoerce<
      Awaited<ReturnType<typeof claudeSessionProviderAdapter.getOrCreateClient>>
    >({
      getPid: vi.fn().mockReturnValue(999),
    });

    vi.mocked(claudeSessionProviderAdapter.getClient).mockReturnValue(undefined);
    vi.mocked(claudeSessionProviderAdapter.getPendingClient).mockReturnValue(undefined);
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(session);
    vi.mocked(sessionRepository.getWorkspaceById).mockResolvedValue(workspace);
    vi.mocked(sessionRepository.markWorkspaceHasHadSessions).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue(session);

    vi.mocked(sessionPromptBuilder.shouldInjectBranchRename).mockReturnValue(false);
    vi.mocked(sessionPromptBuilder.buildSystemPrompt).mockReturnValue({
      workflowPrompt: undefined,
      systemPrompt: undefined,
      injectedBranchRename: false,
    });

    vi.mocked(claudeSessionProviderAdapter.getOrCreateClient).mockResolvedValue(client);

    await sessionService.getOrCreateClient('session-1');

    expect(claudeSessionProviderAdapter.getOrCreateClient).toHaveBeenCalled();
    expect(sessionRepository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.RUNNING,
      claudeProcessPid: 999,
    });
  });

  it('normalizes stale loading runtime to idle when no process is active', () => {
    vi.spyOn(sessionDomainService, 'getRuntimeSnapshot').mockReturnValue({
      phase: 'loading',
      processState: 'unknown',
      activity: 'IDLE',
      updatedAt: new Date('2026-02-10T01:45:35.844Z').toISOString(),
    });
    vi.mocked(claudeSessionProviderAdapter.getClient).mockReturnValue(undefined);
    vi.mocked(claudeSessionProviderAdapter.getPendingClient).mockReturnValue(undefined);
    vi.mocked(claudeSessionProviderAdapter.isStopInProgress).mockReturnValue(false);

    const runtime = sessionService.getRuntimeSnapshot('session-1');

    expect(runtime).toMatchObject({
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
    });
  });

  it('keeps recent loading runtime when no process is active', () => {
    vi.spyOn(sessionDomainService, 'getRuntimeSnapshot').mockReturnValue({
      phase: 'loading',
      processState: 'unknown',
      activity: 'IDLE',
      updatedAt: new Date().toISOString(),
    });
    vi.mocked(claudeSessionProviderAdapter.getClient).mockReturnValue(undefined);
    vi.mocked(claudeSessionProviderAdapter.getPendingClient).mockReturnValue(undefined);
    vi.mocked(claudeSessionProviderAdapter.isStopInProgress).mockReturnValue(false);

    const runtime = sessionService.getRuntimeSnapshot('session-1');

    expect(runtime).toMatchObject({
      phase: 'loading',
      processState: 'unknown',
      activity: 'IDLE',
    });
  });

  it('getOrCreateClient and startClaudeSession produce identical DB state', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      claudeSessionId: null,
    });

    const workspace = unsafeCoerce<Awaited<ReturnType<typeof sessionRepository.getWorkspaceById>>>({
      id: 'workspace-1',
      worktreePath: '/tmp/work',
      branchName: 'feature-branch',
      isAutoGeneratedBranch: false,
      name: 'Workspace A',
      description: null,
      projectId: 'project-1',
    });

    const client = unsafeCoerce<
      Awaited<ReturnType<typeof claudeSessionProviderAdapter.getOrCreateClient>>
    >({
      getPid: vi.fn().mockReturnValue(888),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });

    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(session);
    vi.mocked(sessionRepository.getWorkspaceById).mockResolvedValue(workspace);
    vi.mocked(sessionRepository.markWorkspaceHasHadSessions).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue(session);

    vi.mocked(sessionPromptBuilder.shouldInjectBranchRename).mockReturnValue(false);
    vi.mocked(sessionPromptBuilder.buildSystemPrompt).mockReturnValue({
      workflowPrompt: undefined,
      systemPrompt: undefined,
      injectedBranchRename: false,
    });

    vi.mocked(claudeSessionProviderAdapter.getOrCreateClient).mockResolvedValue(client);

    // Test getOrCreateClient path (WebSocket)
    vi.mocked(claudeSessionProviderAdapter.getClient).mockReturnValue(undefined);
    vi.mocked(claudeSessionProviderAdapter.getPendingClient).mockReturnValue(undefined);
    await sessionService.getOrCreateClient('session-1');

    const getOrCreateCalls = vi.mocked(sessionRepository.updateSession).mock.calls;

    // Reset mocks for second test
    vi.clearAllMocks();
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(session);
    vi.mocked(sessionRepository.getWorkspaceById).mockResolvedValue(workspace);
    vi.mocked(sessionRepository.markWorkspaceHasHadSessions).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue(session);
    vi.mocked(sessionPromptBuilder.shouldInjectBranchRename).mockReturnValue(false);
    vi.mocked(sessionPromptBuilder.buildSystemPrompt).mockReturnValue({
      workflowPrompt: undefined,
      systemPrompt: undefined,
      injectedBranchRename: false,
    });
    vi.mocked(claudeSessionProviderAdapter.isStopInProgress).mockReturnValue(false);
    vi.mocked(claudeSessionProviderAdapter.getOrCreateClient).mockResolvedValue(client);

    // Test startClaudeSession path (tRPC)
    await sessionService.startClaudeSession('session-1');

    const startSessionCalls = vi.mocked(sessionRepository.updateSession).mock.calls;

    // Both paths should update DB with identical state
    expect(getOrCreateCalls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          'session-1',
          {
            status: SessionStatus.RUNNING,
            claudeProcessPid: 888,
          },
        ]),
      ])
    );
    expect(startSessionCalls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          'session-1',
          {
            status: SessionStatus.RUNNING,
            claudeProcessPid: 888,
          },
        ]),
      ])
    );
  });

  it('delegates provider command helpers to adapter methods', async () => {
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(
      unsafeCoerce({
        id: 'session-1',
        workspaceId: 'workspace-1',
        status: SessionStatus.IDLE,
        workflow: 'default',
        model: 'sonnet',
        provider: 'CLAUDE',
        claudeSessionId: null,
      })
    );
    vi.mocked(claudeSessionProviderAdapter.setModel).mockResolvedValue(undefined);
    vi.mocked(claudeSessionProviderAdapter.setThinkingBudget).mockResolvedValue(undefined);
    vi.mocked(claudeSessionProviderAdapter.rewindFiles).mockResolvedValue({
      affected_files: ['src/a.ts'],
    } as never);

    await sessionService.setSessionModel('session-1', 'sonnet');
    await sessionService.setSessionThinkingBudget('session-1', 2048);
    const rewindResponse = await sessionService.rewindSessionFiles('session-1', 'user-1', true);
    sessionService.respondToPermissionRequest('session-1', 'req-1', true);
    sessionService.respondToQuestionRequest('session-1', 'req-2', { q: 'a' });

    expect(claudeSessionProviderAdapter.setModel).toHaveBeenCalledWith('session-1', 'sonnet');
    expect(claudeSessionProviderAdapter.setThinkingBudget).toHaveBeenCalledWith('session-1', 2048);
    expect(claudeSessionProviderAdapter.rewindFiles).toHaveBeenCalledWith(
      'session-1',
      'user-1',
      true
    );
    expect(rewindResponse).toEqual({ affected_files: ['src/a.ts'] });
    expect(claudeSessionProviderAdapter.respondToPermission).toHaveBeenCalledWith(
      'session-1',
      'req-1',
      true
    );
    expect(claudeSessionProviderAdapter.respondToQuestion).toHaveBeenCalledWith(
      'session-1',
      'req-2',
      { q: 'a' }
    );
  });

  it('stops both Claude and Codex providers during shutdown', async () => {
    vi.mocked(claudeSessionProviderAdapter.stopAllClients).mockResolvedValue(undefined);
    vi.mocked(codexSessionProviderAdapter.stopAllClients).mockResolvedValue(undefined);

    await sessionService.stopAllClients(4321);

    expect(claudeSessionProviderAdapter.stopAllClients).toHaveBeenCalledWith(4321);
    expect(codexSessionProviderAdapter.stopAllClients).toHaveBeenCalledTimes(1);
  });

  it('still attempts Codex shutdown when Claude shutdown fails', async () => {
    vi.mocked(claudeSessionProviderAdapter.stopAllClients).mockRejectedValueOnce(
      new Error('claude shutdown failed')
    );
    vi.mocked(codexSessionProviderAdapter.stopAllClients).mockResolvedValue(undefined);

    await expect(sessionService.stopAllClients()).rejects.toThrow('claude shutdown failed');
    expect(codexSessionProviderAdapter.stopAllClients).toHaveBeenCalledTimes(1);
  });

  it('marks terminal turn tracking for terminal Codex notifications', () => {
    codexTestState.codexManagerHandlers?.onNotification?.({
      sessionId: 'session-1',
      method: 'turn/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });

    expect(codexTestState.codexRegistry.markTurnTerminal).toHaveBeenCalledWith(
      'session-1',
      'turn-1'
    );
  });

  it('persists runtime snapshots for translated Codex runtime deltas', () => {
    const setRuntimeSnapshotSpy = vi.spyOn(sessionDomainService, 'setRuntimeSnapshot');
    const emitDeltaSpy = vi.spyOn(sessionDomainService, 'emitDelta');

    codexTestState.codexManagerHandlers?.onNotification?.({
      sessionId: 'session-1',
      method: 'turn/started',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });

    expect(setRuntimeSnapshotSpy).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        phase: 'running',
        processState: 'alive',
        activity: 'WORKING',
      }),
      false
    );
    expect(emitDeltaSpy).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'session_runtime_updated' })
    );
  });

  it('responds to unsupported Codex interactive requests', () => {
    codexTestState.codexManagerHandlers?.onServerRequest?.({
      sessionId: 'session-1',
      method: 'item/unsupported/request',
      params: { threadId: 'thread-1' },
      canonicalRequestId: 'request-1',
    });

    expect(codexSessionProviderAdapter.rejectInteractiveRequest).toHaveBeenCalledWith(
      'session-1',
      'request-1',
      expect.objectContaining({
        message: expect.stringContaining('Unsupported Codex interactive request'),
      })
    );
  });

  it('maps provider message to public delta through adapter translation seam', () => {
    vi.mocked(claudeSessionProviderAdapter.toCanonicalAgentMessage).mockReturnValue({
      type: 'agent_message',
      provider: 'CLAUDE',
      kind: 'provider_event',
      order: 3,
      data: {
        type: 'result',
        subtype: 'success',
      } as never,
    });
    vi.mocked(claudeSessionProviderAdapter.toPublicDeltaEvent).mockReturnValue({
      type: 'agent_message',
      order: 3,
      data: {
        type: 'result',
      } as never,
    });

    const delta = sessionService.toPublicMessageDelta(
      {
        type: 'result',
      } as never,
      3
    );

    expect(claudeSessionProviderAdapter.toCanonicalAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'result' }),
      3
    );
    expect(claudeSessionProviderAdapter.toPublicDeltaEvent).toHaveBeenCalled();
    expect(delta).toMatchObject({ type: 'agent_message', order: 3 });
  });
});
