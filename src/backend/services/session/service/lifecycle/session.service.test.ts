import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatConnectionService } from '@/backend/services/session/service/chat/chat-connection.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { ChatMessage } from '@/shared/acp-protocol';
import { SessionStatus } from '@/shared/core';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

const mockNotifyToolStart = vi.fn();
const mockNotifyToolComplete = vi.fn();
const mockClearRatchetActiveSessionIfMatching = vi.fn();
const mockAcpTraceLoggerCloseSession = vi.fn();

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getCurrentProcessEnv: () => ({ ...process.env }),
}));

vi.mock('@/backend/services/workspace');
vi.mock('./closed-session-persistence.service');

vi.mock('@/backend/services/session/service/acp', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AcpEventTranslator: class MockAcpEventTranslator {
      translateSessionUpdate = vi.fn().mockReturnValue([]);
    },
    AcpPermissionBridge: class MockAcpPermissionBridge {
      cancelAll = vi.fn();
      resolvePermission = vi.fn();
    },
    acpRuntimeManager: {
      getClient: vi.fn().mockReturnValue(undefined),
      getOrCreateClient: vi.fn(),
      stopClient: vi.fn(),
      stopAllClients: vi.fn(),
      sendPrompt: vi.fn(),
      cancelPrompt: vi.fn(),
      isSessionRunning: vi.fn().mockReturnValue(false),
      isSessionWorking: vi.fn().mockReturnValue(false),
      isAnySessionWorking: vi.fn().mockReturnValue(false),
      isStopInProgress: vi.fn().mockReturnValue(false),
      setConfigOption: vi.fn(),
      setSessionMode: vi.fn(),
      setSessionModel: vi.fn(),
    },
  };
});

vi.mock('@/backend/interceptors/registry', () => ({
  interceptorRegistry: {
    notifyToolStart: (...args: unknown[]) => mockNotifyToolStart(...args),
    notifyToolComplete: (...args: unknown[]) => mockNotifyToolComplete(...args),
  },
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

vi.mock('@/backend/services/session/service/logging/acp-trace-logger.service', () => ({
  acpTraceLogger: {
    log: vi.fn(),
    closeSession: (...args: unknown[]) => mockAcpTraceLoggerCloseSession(...args),
  },
}));

import type { AcpProcessHandle, AcpRuntimeEvent } from '@/backend/services/session/service/acp';
import { acpRuntimeManager } from '@/backend/services/session/service/acp';
import { workspaceAccessor } from '@/backend/services/workspace';
import { closedSessionPersistenceService } from './closed-session-persistence.service';
import { sessionPromptBuilder } from './session.prompt-builder';
import { sessionRepository } from './session.repository';
import { sessionService } from './session.service';

function getAcpProcessorState() {
  return (
    sessionService as unknown as {
      acpEventProcessor: {
        pendingAcpToolCalls: Map<string, Map<string, unknown>>;
        sessionToWorkspace: Map<string, string>;
        sessionToWorkingDir: Map<string, string>;
        registerSessionContext: (
          sessionId: string,
          context: { workspaceId: string; workingDir: string }
        ) => void;
        beginPromptTurn: (sessionId: string) => void;
        handleAcpDelta: (sid: string, delta: unknown) => void;
      };
    }
  ).acpEventProcessor;
}

function mockCreatedAcpClient(acpHandle: AcpProcessHandle): void {
  vi.mocked(acpRuntimeManager.getOrCreateClient).mockImplementation(() => {
    vi.mocked(acpRuntimeManager.getClient).mockReturnValue(acpHandle);
    return Promise.resolve(acpHandle);
  });
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

describe('SessionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotifyToolStart.mockReset();
    mockNotifyToolComplete.mockReset();
    mockClearRatchetActiveSessionIfMatching.mockReset();
    mockAcpTraceLoggerCloseSession.mockReset();
    const acpProcessor = getAcpProcessorState();
    acpProcessor.pendingAcpToolCalls.clear();
    acpProcessor.sessionToWorkspace.clear();
    acpProcessor.sessionToWorkingDir.clear();
    sessionService.setPromptTurnCompleteHandler(null);
    sessionService.configure({
      workspace: {
        markSessionRunning: vi.fn(),
        markSessionIdle: vi.fn(),
        clearRatchetActiveSessionIfMatching: mockClearRatchetActiveSessionIfMatching,
      },
    });
    vi.mocked(acpRuntimeManager.getClient).mockReturnValue(undefined);
    vi.mocked(acpRuntimeManager.isSessionRunning).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.isSessionWorking).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.isAnySessionWorking).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.isStopInProgress).mockReturnValue(false);
    vi.mocked(workspaceAccessor.findById).mockResolvedValue(
      unsafeCoerce({
        id: 'workspace-1',
        worktreePath: '/tmp/work',
      })
    );
    vi.mocked(closedSessionPersistenceService.persistClosedSession).mockResolvedValue();
  });

  it('starts a session via ACP runtime and updates DB state', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      provider: 'CLAUDE',
      providerSessionId: null,
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

    const acpHandle = unsafeCoerce<AcpProcessHandle>({
      getPid: vi.fn().mockReturnValue(123),
      isPromptInFlight: false,
      configOptions: [],
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

    mockCreatedAcpClient(acpHandle);
    vi.mocked(acpRuntimeManager.sendPrompt).mockResolvedValue({ stopReason: 'end_turn' });

    await sessionService.startSession('session-1', { initialPrompt: 'Hello' });

    expect(sessionPromptBuilder.shouldInjectBranchRename).toHaveBeenCalledWith({
      branchName: 'auto-branch',
      isAutoGeneratedBranch: true,
      hasHadSessions: false,
    });
    expect(sessionRepository.markWorkspaceHasHadSessions).toHaveBeenCalledWith('workspace-1');
    expect(acpRuntimeManager.getOrCreateClient).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        workingDir: '/tmp/work',
        systemPrompt: 'system',
        model: 'sonnet',
        sessionId: 'session-1',
      }),
      expect.any(Object),
      { workspaceId: 'workspace-1', workingDir: '/tmp/work' }
    );
    expect(sessionRepository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.RUNNING,
    });
  });

  it('delegates to ACP runtime for new session creation', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      provider: 'CLAUDE',
      providerSessionId: null,
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

    const acpHandle = unsafeCoerce<AcpProcessHandle>({
      getPid: vi.fn().mockReturnValue(456),
      isPromptInFlight: false,
      configOptions: [],
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

    mockCreatedAcpClient(acpHandle);

    const result = await sessionService.getOrCreateSessionClient('session-1');

    expect(result).toBe(acpHandle);
    expect(acpRuntimeManager.getOrCreateClient).toHaveBeenCalledWith(
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
    });
  });

  it('injects replayed user_message_chunk events while session is idle', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      provider: 'CLAUDE',
      providerSessionId: 'provider-session-1',
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

    const acpHandle = unsafeCoerce<AcpProcessHandle>({
      getPid: vi.fn().mockReturnValue(456),
      isPromptInFlight: false,
      configOptions: [],
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
    mockCreatedAcpClient(acpHandle);

    const injectUserMessageSpy = vi.spyOn(sessionDomainService, 'injectCommittedUserMessage');
    await sessionService.getOrCreateSessionClient('session-1');

    const acpHandlers = vi.mocked(acpRuntimeManager.getOrCreateClient).mock.calls[0]![2] as {
      onAcpEvent: (id: string, event: AcpRuntimeEvent) => void;
    };
    acpHandlers.onAcpEvent('session-1', {
      type: 'acp_session_update',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'ping' },
      },
    });

    expect(injectUserMessageSpy).toHaveBeenCalledWith('session-1', 'ping');
  });

  it('ignores malformed user_message_chunk events without content', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      provider: 'CLAUDE',
      providerSessionId: 'provider-session-1',
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

    const acpHandle = unsafeCoerce<AcpProcessHandle>({
      getPid: vi.fn().mockReturnValue(456),
      isPromptInFlight: false,
      configOptions: [],
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
    mockCreatedAcpClient(acpHandle);

    const injectUserMessageSpy = vi.spyOn(sessionDomainService, 'injectCommittedUserMessage');
    await sessionService.getOrCreateSessionClient('session-1');

    const acpHandlers = vi.mocked(acpRuntimeManager.getOrCreateClient).mock.calls[0]![2] as {
      onAcpEvent: (id: string, event: AcpRuntimeEvent) => void;
    };

    expect(() =>
      acpHandlers.onAcpEvent(
        'session-1',
        unsafeCoerce<AcpRuntimeEvent>({
          type: 'acp_session_update',
          update: {
            sessionUpdate: 'user_message_chunk',
          },
        })
      )
    ).not.toThrow();

    expect(injectUserMessageSpy).not.toHaveBeenCalled();
  });

  it('suppresses replayed user_message_chunk when transcript is already hydrated', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      provider: 'CLAUDE',
      providerSessionId: 'provider-session-1',
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

    const acpHandle = unsafeCoerce<AcpProcessHandle>({
      getPid: vi.fn().mockReturnValue(456),
      isPromptInFlight: false,
      configOptions: [],
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
    mockCreatedAcpClient(acpHandle);

    const historyHydratedSpy = vi
      .spyOn(sessionDomainService, 'isHistoryHydrated')
      .mockReturnValue(true);
    const transcriptSpy = vi.spyOn(sessionDomainService, 'getTranscriptSnapshot').mockReturnValue([
      unsafeCoerce({
        id: 'hist-1',
        source: 'user',
        text: 'already loaded',
        timestamp: '2026-02-14T00:00:00.000Z',
        order: 0,
      }),
    ]);

    try {
      const injectUserMessageSpy = vi.spyOn(sessionDomainService, 'injectCommittedUserMessage');
      await sessionService.getOrCreateSessionClient('session-1');

      const acpHandlers = vi.mocked(acpRuntimeManager.getOrCreateClient).mock.calls[0]![2] as {
        onAcpEvent: (id: string, event: AcpRuntimeEvent) => void;
      };
      acpHandlers.onAcpEvent('session-1', {
        type: 'acp_session_update',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'ping' },
        },
      });

      expect(injectUserMessageSpy).not.toHaveBeenCalled();
    } finally {
      historyHydratedSpy.mockRestore();
      transcriptSpy.mockRestore();
    }
  });

  it('ignores live user_message_chunk events while session is working', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      provider: 'CLAUDE',
      providerSessionId: 'provider-session-1',
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

    const acpHandle = unsafeCoerce<AcpProcessHandle>({
      getPid: vi.fn().mockReturnValue(456),
      isPromptInFlight: false,
      configOptions: [],
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
    mockCreatedAcpClient(acpHandle);

    const injectUserMessageSpy = vi.spyOn(sessionDomainService, 'injectCommittedUserMessage');
    await sessionService.getOrCreateSessionClient('session-1');
    vi.mocked(acpRuntimeManager.isSessionWorking).mockReturnValue(true);

    const acpHandlers = vi.mocked(acpRuntimeManager.getOrCreateClient).mock.calls[0]![2] as {
      onAcpEvent: (id: string, event: AcpRuntimeEvent) => void;
    };
    acpHandlers.onAcpEvent('session-1', {
      type: 'acp_session_update',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'ping' },
      },
    });

    expect(injectUserMessageSpy).not.toHaveBeenCalled();
  });

  it('notifies interceptors for ACP tool_use start and tool_result completion', () => {
    const acpProcessor = getAcpProcessorState();
    acpProcessor.sessionToWorkspace.set('session-1', 'workspace-1');
    acpProcessor.sessionToWorkingDir.set('session-1', '/tmp/workspace');

    acpProcessor.handleAcpDelta('session-1', {
      type: 'agent_message',
      data: {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'call-1',
            name: 'commandExecution',
            input: { command: 'gh pr create --title "Fix bug"' },
          },
        },
      },
    });

    acpProcessor.handleAcpDelta('session-1', {
      type: 'tool_progress',
      tool_use_id: 'call-1',
      tool_name: 'commandExecution',
      acpStatus: 'completed',
      elapsed_time_seconds: 1,
    });

    acpProcessor.handleAcpDelta('session-1', {
      type: 'agent_message',
      data: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-1',
              content: 'https://github.com/purplefish-ai/factory-factory/pull/1047',
            },
          ],
        },
      },
    });

    expect(mockNotifyToolStart).toHaveBeenCalledWith(
      expect.objectContaining({
        toolUseId: 'call-1',
        toolName: 'commandExecution',
        input: { command: 'gh pr create --title "Fix bug"' },
      }),
      expect.objectContaining({
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        workingDir: '/tmp/workspace',
        timestamp: expect.any(Date),
      })
    );
    expect(mockNotifyToolStart).toHaveBeenCalledTimes(1);

    expect(mockNotifyToolComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        toolUseId: 'call-1',
        toolName: 'commandExecution',
        input: { command: 'gh pr create --title "Fix bug"' },
        output: {
          content: 'https://github.com/purplefish-ai/factory-factory/pull/1047',
          isError: false,
        },
      }),
      expect.objectContaining({
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        workingDir: '/tmp/workspace',
        timestamp: expect.any(Date),
      })
    );
    expect(mockNotifyToolComplete).toHaveBeenCalledTimes(1);
  });

  it('creates client from preloaded session without re-querying session row', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      provider: 'CLAUDE',
      providerSessionId: null,
    });

    const workspace = unsafeCoerce<Awaited<ReturnType<typeof sessionRepository.getWorkspaceById>>>({
      id: 'workspace-1',
      worktreePath: '/tmp/work',
      branchName: 'feature-branch',
      isAutoGeneratedBranch: false,
      hasHadSessions: true,
      name: 'Workspace A',
      description: null,
      projectId: 'project-1',
    });

    const acpHandle = unsafeCoerce<AcpProcessHandle>({
      getPid: vi.fn().mockReturnValue(777),
      isPromptInFlight: false,
      configOptions: [],
    });

    vi.mocked(sessionRepository.getWorkspaceById).mockResolvedValue(workspace);
    vi.mocked(sessionRepository.updateSession).mockResolvedValue(session);
    vi.mocked(sessionPromptBuilder.shouldInjectBranchRename).mockReturnValue(false);
    vi.mocked(sessionPromptBuilder.buildSystemPrompt).mockReturnValue({
      workflowPrompt: undefined,
      systemPrompt: undefined,
      injectedBranchRename: false,
    });
    mockCreatedAcpClient(acpHandle);

    const result = await sessionService.getOrCreateSessionClientFromRecord(session);

    expect(result).toBe(acpHandle);
    expect(sessionRepository.getSessionById).not.toHaveBeenCalled();
    expect(acpRuntimeManager.getOrCreateClient).toHaveBeenCalledWith(
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
  });

  it('skips stop when already stopping', async () => {
    vi.mocked(acpRuntimeManager.isStopInProgress).mockReturnValue(true);

    await sessionService.stopSession('session-1');

    expect(acpRuntimeManager.stopClient).not.toHaveBeenCalled();
    expect(sessionRepository.updateSession).not.toHaveBeenCalled();
  });

  it('clears queued work during manual stop', async () => {
    vi.mocked(acpRuntimeManager.isStopInProgress).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);
    const clearQueuedWorkSpy = vi.spyOn(sessionDomainService, 'clearQueuedWork');

    await sessionService.stopSession('session-1');

    expect(clearQueuedWorkSpy).toHaveBeenCalledWith('session-1', { emitSnapshot: true });
  });

  it('rejects queued ACP prompts during manual stop', async () => {
    const firstPrompt = createDeferred<{ stopReason: string }>();
    vi.mocked(acpRuntimeManager.isStopInProgress).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.sendPrompt).mockReturnValueOnce(firstPrompt.promise as never);
    vi.mocked(acpRuntimeManager.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);

    const firstSend = sessionService.sendAcpMessage('session-queued-stop', [
      { type: 'text', text: 'first' },
    ]);
    await Promise.resolve();
    expect(acpRuntimeManager.sendPrompt).toHaveBeenCalledTimes(1);

    const secondSend = sessionService.sendAcpMessage('session-queued-stop', [
      { type: 'text', text: 'second' },
    ]);
    const secondRejection = expect(secondSend).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(acpRuntimeManager.sendPrompt).toHaveBeenCalledTimes(1);

    await sessionService.stopSession('session-queued-stop');
    await secondRejection;
    expect(acpRuntimeManager.sendPrompt).toHaveBeenCalledTimes(1);

    firstPrompt.resolve({ stopReason: 'end_turn' });
    await expect(firstSend).resolves.toBe('end_turn');
    expect(acpRuntimeManager.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('rejects queued ACP prompts during unexpected runtime exit', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-runtime-exit',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      provider: 'CLAUDE',
      providerSessionId: null,
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

    const acpHandle = unsafeCoerce<AcpProcessHandle>({
      getPid: vi.fn().mockReturnValue(456),
      isPromptInFlight: false,
      configOptions: [],
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
    mockCreatedAcpClient(acpHandle);
    await sessionService.getOrCreateSessionClient('session-runtime-exit');

    const acpHandlers = vi.mocked(acpRuntimeManager.getOrCreateClient).mock.calls[0]![2] as {
      onExit: (id: string, exitCode: number | null) => Promise<void>;
    };

    const firstPrompt = createDeferred<{ stopReason: string }>();
    vi.mocked(acpRuntimeManager.sendPrompt).mockReturnValueOnce(firstPrompt.promise as never);

    const firstSend = sessionService.sendAcpMessage('session-runtime-exit', [
      { type: 'text', text: 'first' },
    ]);
    await Promise.resolve();
    expect(acpRuntimeManager.sendPrompt).toHaveBeenCalledTimes(1);

    const secondSend = sessionService.sendAcpMessage('session-runtime-exit', [
      { type: 'text', text: 'second' },
    ]);
    const secondRejection = expect(secondSend).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(acpRuntimeManager.sendPrompt).toHaveBeenCalledTimes(1);

    await acpHandlers.onExit('session-runtime-exit', 1);
    await secondRejection;
    expect(acpRuntimeManager.sendPrompt).toHaveBeenCalledTimes(1);

    firstPrompt.resolve({ stopReason: 'end_turn' });
    await expect(firstSend).resolves.toBe('end_turn');
    expect(acpRuntimeManager.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('keeps active ACP prompt serialization during manual stop', async () => {
    const firstPrompt = createDeferred<{ stopReason: string }>();
    const thirdPrompt = createDeferred<{ stopReason: string }>();
    vi.mocked(acpRuntimeManager.isStopInProgress).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.sendPrompt)
      .mockReturnValueOnce(firstPrompt.promise as never)
      .mockReturnValueOnce(thirdPrompt.promise as never);
    vi.mocked(acpRuntimeManager.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);

    const firstSend = sessionService.sendAcpMessage('session-active-stop', [
      { type: 'text', text: 'first' },
    ]);
    await Promise.resolve();
    expect(acpRuntimeManager.sendPrompt).toHaveBeenCalledTimes(1);

    const secondSend = sessionService.sendAcpMessage('session-active-stop', [
      { type: 'text', text: 'second' },
    ]);
    const secondRejection = expect(secondSend).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(acpRuntimeManager.sendPrompt).toHaveBeenCalledTimes(1);

    await sessionService.stopSession('session-active-stop');
    await secondRejection;

    const thirdSend = sessionService.sendAcpMessage('session-active-stop', [
      { type: 'text', text: 'third' },
    ]);
    await Promise.resolve();
    expect(acpRuntimeManager.sendPrompt).toHaveBeenCalledTimes(1);

    firstPrompt.resolve({ stopReason: 'end_turn' });
    await expect(firstSend).resolves.toBe('end_turn');
    await Promise.resolve();

    expect(acpRuntimeManager.sendPrompt).toHaveBeenCalledTimes(2);
    thirdPrompt.resolve({ stopReason: 'end_turn' });
    await expect(thirdSend).resolves.toBe('end_turn');
  });

  it('clears in-memory session state after manual stop when no clients are connected', async () => {
    vi.mocked(acpRuntimeManager.isStopInProgress).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);
    const clearSessionSpy = vi.spyOn(sessionDomainService, 'clearSession');

    await sessionService.stopSession('session-clear');

    expect(clearSessionSpy).toHaveBeenCalledWith('session-clear');
  });

  it('keeps in-memory session state after manual stop when clients are connected', async () => {
    vi.mocked(acpRuntimeManager.isStopInProgress).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);
    const clearSessionSpy = vi.spyOn(sessionDomainService, 'clearSession');

    const connectionId = 'conn-active-session';
    chatConnectionService.register(connectionId, {
      ws: {} as never,
      dbSessionId: 'session-active',
      workingDir: null,
    });
    try {
      await sessionService.stopSession('session-active');
    } finally {
      chatConnectionService.unregister(connectionId);
    }

    expect(clearSessionSpy).not.toHaveBeenCalled();
  });

  it('marks workspace session idle during manual stop', async () => {
    const markSessionIdle = vi.fn();
    sessionService.configure({
      workspace: {
        markSessionRunning: vi.fn(),
        markSessionIdle,
        clearRatchetActiveSessionIfMatching: mockClearRatchetActiveSessionIfMatching,
      },
    });
    vi.mocked(acpRuntimeManager.isStopInProgress).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(
      unsafeCoerce({
        id: 'session-1',
        workspaceId: 'workspace-1',
      })
    );
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);

    await sessionService.stopSession('session-1');

    expect(markSessionIdle).toHaveBeenCalledWith('workspace-1', 'session-1');
  });

  it('still clears queued work and marks idle when runtime stop fails', async () => {
    vi.mocked(acpRuntimeManager.isStopInProgress).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.stopClient).mockRejectedValue(new Error('stop failed'));
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(
      unsafeCoerce({
        id: 'session-1',
        workspaceId: 'workspace-1',
        workflow: 'ratchet',
      })
    );
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);
    const clearQueuedWorkSpy = vi.spyOn(sessionDomainService, 'clearQueuedWork');

    await sessionService.stopSession('session-1');

    expect(sessionRepository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.IDLE,
    });
    expect(clearQueuedWorkSpy).toHaveBeenCalledWith('session-1', { emitSnapshot: true });
    expect(mockClearRatchetActiveSessionIfMatching).not.toHaveBeenCalled();
    expect(sessionRepository.deleteSession).not.toHaveBeenCalled();
  });

  it('finalizes orphaned ACP tool calls during manual stop', async () => {
    const pendingToolCalls = getAcpProcessorState().pendingAcpToolCalls as Map<
      string,
      Map<
        string,
        {
          toolUseId: string;
          toolName: string;
          acpKind?: string;
          acpLocations?: Array<{ path: string; line?: number | null }>;
        }
      >
    >;

    pendingToolCalls.set(
      'session-1',
      new Map([
        [
          'call-1',
          {
            toolUseId: 'call-1',
            toolName: 'Run pwd',
            acpKind: 'execute',
          },
        ],
      ])
    );

    vi.mocked(acpRuntimeManager.isStopInProgress).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(
      unsafeCoerce({
        id: 'session-1',
        workspaceId: 'workspace-1',
      })
    );
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);
    const emitDeltaSpy = vi.spyOn(sessionDomainService, 'emitDelta');
    const appendClaudeEventSpy = vi
      .spyOn(sessionDomainService, 'appendClaudeEvent')
      .mockReturnValue(77);

    await sessionService.stopSession('session-1');

    expect(emitDeltaSpy).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'tool_progress',
        tool_use_id: 'call-1',
        tool_name: 'Run pwd',
        acpStatus: 'failed',
        elapsed_time_seconds: 0,
      })
    );
    expect(appendClaudeEventSpy).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'user',
        message: expect.objectContaining({
          content: [
            expect.objectContaining({
              type: 'tool_result',
              tool_use_id: 'call-1',
              is_error: true,
            }),
          ],
        }),
      })
    );
    expect(pendingToolCalls.has('session-1')).toBe(false);
  });

  it('continues stop cleanup when orphaned tool-call finalization throws', async () => {
    const markSessionIdle = vi.fn();
    sessionService.configure({
      workspace: {
        markSessionRunning: vi.fn(),
        markSessionIdle,
        clearRatchetActiveSessionIfMatching: mockClearRatchetActiveSessionIfMatching,
      },
    });

    const pendingToolCalls = getAcpProcessorState().pendingAcpToolCalls as Map<
      string,
      Map<
        string,
        {
          toolUseId: string;
          toolName: string;
          acpKind?: string;
          acpLocations?: Array<{ path: string; line?: number | null }>;
        }
      >
    >;

    pendingToolCalls.set(
      'session-1',
      new Map([
        [
          'call-1',
          {
            toolUseId: 'call-1',
            toolName: 'Run pwd',
            acpKind: 'execute',
          },
        ],
      ])
    );

    vi.mocked(acpRuntimeManager.isStopInProgress).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(
      unsafeCoerce({
        id: 'session-1',
        workspaceId: 'workspace-1',
      })
    );
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);
    vi.spyOn(sessionDomainService, 'emitDelta').mockImplementationOnce(() => {
      throw new Error('emit failed');
    });

    await sessionService.stopSession('session-1');

    expect(sessionRepository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.IDLE,
    });
    expect(markSessionIdle).toHaveBeenCalledWith('workspace-1', 'session-1');
    expect(pendingToolCalls.has('session-1')).toBe(false);
  });

  it('persists transcript before deleting ratchet session record during manual stop', async () => {
    const startedAt = new Date('2026-02-25T12:00:00.000Z');
    const transcript: ChatMessage[] = [
      unsafeCoerce({
        id: 'message-1',
        source: 'assistant',
        text: 'Fixed the failing check',
        timestamp: '2026-02-25T12:01:00.000Z',
        order: 0,
      }),
    ];
    const transcriptSpy = vi
      .spyOn(sessionDomainService, 'getTranscriptSnapshot')
      .mockReturnValue(transcript);

    vi.mocked(acpRuntimeManager.isStopInProgress).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(
      unsafeCoerce({
        id: 'session-1',
        workspaceId: 'workspace-1',
        name: 'Auto-Fix',
        workflow: 'ratchet',
        provider: 'CLAUDE',
        model: 'sonnet',
        createdAt: startedAt,
      })
    );
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);
    vi.mocked(sessionRepository.deleteSession).mockResolvedValue({} as never);

    try {
      await sessionService.stopSession('session-1');

      expect(mockClearRatchetActiveSessionIfMatching).toHaveBeenCalledWith(
        'workspace-1',
        'session-1'
      );
      expect(closedSessionPersistenceService.persistClosedSession).toHaveBeenCalledWith({
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        worktreePath: '/tmp/work',
        name: 'Auto-Fix',
        workflow: 'ratchet',
        provider: 'CLAUDE',
        model: 'sonnet',
        startedAt,
        messages: transcript,
      });
      expect(sessionRepository.deleteSession).toHaveBeenCalledWith('session-1');
      expect(
        vi.mocked(closedSessionPersistenceService.persistClosedSession).mock.invocationCallOrder[0]
      ).toBeLessThan(vi.mocked(sessionRepository.deleteSession).mock.invocationCallOrder[0]!);
    } finally {
      transcriptSpy.mockRestore();
    }
  });

  it('does not delete ratchet session during manual stop when transcript persistence fails', async () => {
    vi.mocked(acpRuntimeManager.isStopInProgress).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(
      unsafeCoerce({
        id: 'session-1',
        workspaceId: 'workspace-1',
        name: 'Auto-Fix',
        workflow: 'ratchet',
        provider: 'CLAUDE',
        model: 'sonnet',
        createdAt: new Date('2026-02-25T12:00:00.000Z'),
      })
    );
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);
    vi.mocked(closedSessionPersistenceService.persistClosedSession).mockRejectedValue(
      new Error('Disk full')
    );

    await sessionService.stopSession('session-1');

    expect(closedSessionPersistenceService.persistClosedSession).toHaveBeenCalledTimes(1);
    expect(sessionRepository.deleteSession).not.toHaveBeenCalled();
  });

  it('does not delete non-ratchet session during manual stop', async () => {
    vi.mocked(acpRuntimeManager.isStopInProgress).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(
      unsafeCoerce({
        id: 'session-2',
        workspaceId: 'workspace-1',
        workflow: 'default',
      })
    );
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);

    await sessionService.stopSession('session-2');

    expect(sessionRepository.deleteSession).not.toHaveBeenCalled();
  });

  it('clears ratchet pointer but does not delete session when transient cleanup is disabled', async () => {
    vi.mocked(acpRuntimeManager.isStopInProgress).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(
      unsafeCoerce({
        id: 'session-3',
        workspaceId: 'workspace-1',
        workflow: 'ratchet',
      })
    );
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);

    await sessionService.stopSession('session-3', {
      cleanupTransientRatchetSession: false,
    });

    expect(mockClearRatchetActiveSessionIfMatching).toHaveBeenCalledWith(
      'workspace-1',
      'session-3'
    );
    expect(closedSessionPersistenceService.persistClosedSession).not.toHaveBeenCalled();
    expect(sessionRepository.deleteSession).not.toHaveBeenCalled();
  });

  it('marks process as stopped when ACP client creation fails', async () => {
    const session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      provider: 'CLAUDE',
      providerSessionId: null,
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
    vi.mocked(acpRuntimeManager.getOrCreateClient).mockRejectedValue(new Error('spawn failed'));
    const setRuntimeSnapshotSpy = vi.spyOn(sessionDomainService, 'setRuntimeSnapshot');

    await expect(sessionService.getOrCreateSessionClient('session-1')).rejects.toThrow(
      'spawn failed'
    );

    expect(setRuntimeSnapshotSpy).toHaveBeenNthCalledWith(
      1,
      'session-1',
      expect.objectContaining({
        phase: 'starting',
        processState: 'alive',
        activity: 'IDLE',
      })
    );
    expect(setRuntimeSnapshotSpy).toHaveBeenNthCalledWith(
      2,
      'session-1',
      expect.objectContaining({
        phase: 'error',
        processState: 'stopped',
        activity: 'IDLE',
        errorMessage: 'Failed to start agent: spawn failed',
      })
    );
  });

  it('throws when session not found during client creation', async () => {
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(null);

    await expect(sessionService.getOrCreateSessionClient('session-1')).rejects.toThrow(
      'Session not found: session-1'
    );
  });

  it('returns null session options when workspace is missing', async () => {
    const session = unsafeCoerce<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      providerSessionId: null,
    });

    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(session);
    vi.mocked(sessionRepository.getWorkspaceById).mockResolvedValue(null);

    const options = await sessionService.getSessionOptions('session-1');

    expect(options).toBeNull();
  });

  it('clears ratchetActiveSessionId and deletes session on ACP ratchet exit', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'ratchet',
      model: 'sonnet',
      provider: 'CLAUDE',
      providerSessionId: null,
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

    const acpHandle = unsafeCoerce<AcpProcessHandle>({
      getPid: vi.fn().mockReturnValue(456),
      isPromptInFlight: false,
      configOptions: [],
    });

    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(session);
    vi.mocked(sessionRepository.getWorkspaceById).mockResolvedValue(workspace);
    vi.mocked(sessionRepository.getProjectById).mockResolvedValue(project);
    vi.mocked(sessionRepository.markWorkspaceHasHadSessions).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue(session);
    vi.mocked(sessionRepository.deleteSession).mockResolvedValue(session);

    vi.mocked(sessionPromptBuilder.shouldInjectBranchRename).mockReturnValue(false);
    vi.mocked(sessionPromptBuilder.buildSystemPrompt).mockReturnValue({
      workflowPrompt: 'workflow',
      systemPrompt: 'system',
      injectedBranchRename: false,
    });

    mockCreatedAcpClient(acpHandle);
    vi.mocked(acpRuntimeManager.sendPrompt).mockResolvedValue({ stopReason: 'end_turn' });

    await sessionService.startSession('session-1');

    // Extract the onExit handler from the ACP event handlers passed to acpRuntimeManager
    const acpHandlers = vi.mocked(acpRuntimeManager.getOrCreateClient).mock.calls[0]![2] as {
      onExit: (id: string, exitCode: number | null) => Promise<void>;
    };
    await acpHandlers.onExit('session-1', 0);

    expect(sessionRepository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.COMPLETED,
    });
    expect(mockClearRatchetActiveSessionIfMatching).toHaveBeenCalledWith(
      'workspace-1',
      'session-1'
    );
    expect(sessionRepository.deleteSession).toHaveBeenCalledWith('session-1');
  });

  it('does not delete ratchet session when closed-session persistence fails', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'ratchet',
      model: 'sonnet',
      provider: 'CLAUDE',
      providerSessionId: null,
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

    const acpHandle = unsafeCoerce<AcpProcessHandle>({
      getPid: vi.fn().mockReturnValue(456),
      isPromptInFlight: false,
      configOptions: [],
    });

    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(session);
    vi.mocked(sessionRepository.getWorkspaceById).mockResolvedValue(workspace);
    vi.mocked(sessionRepository.getProjectById).mockResolvedValue(project);
    vi.mocked(sessionRepository.markWorkspaceHasHadSessions).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue(session);
    vi.mocked(sessionRepository.deleteSession).mockResolvedValue(session);
    vi.mocked(closedSessionPersistenceService.persistClosedSession).mockRejectedValue(
      new Error('Disk full')
    );

    vi.mocked(sessionPromptBuilder.shouldInjectBranchRename).mockReturnValue(false);
    vi.mocked(sessionPromptBuilder.buildSystemPrompt).mockReturnValue({
      workflowPrompt: 'workflow',
      systemPrompt: 'system',
      injectedBranchRename: false,
    });

    mockCreatedAcpClient(acpHandle);
    vi.mocked(acpRuntimeManager.sendPrompt).mockResolvedValue({ stopReason: 'end_turn' });

    await sessionService.startSession('session-1');

    const acpHandlers = vi.mocked(acpRuntimeManager.getOrCreateClient).mock.calls[0]![2] as {
      onExit: (id: string, exitCode: number | null) => Promise<void>;
    };
    await expect(acpHandlers.onExit('session-1', 0)).resolves.toBeUndefined();

    expect(sessionRepository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.COMPLETED,
    });
    expect(closedSessionPersistenceService.persistClosedSession).toHaveBeenCalledTimes(1);
    expect(sessionRepository.deleteSession).not.toHaveBeenCalled();
  });

  it('does not delete session on ACP exit for non-ratchet workflows', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-2',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      provider: 'CLAUDE',
      providerSessionId: null,
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

    const acpHandle = unsafeCoerce<AcpProcessHandle>({
      getPid: vi.fn().mockReturnValue(789),
      isPromptInFlight: false,
      configOptions: [],
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

    mockCreatedAcpClient(acpHandle);
    vi.mocked(acpRuntimeManager.sendPrompt).mockResolvedValue({ stopReason: 'end_turn' });

    await sessionService.startSession('session-2');

    const acpHandlers = vi.mocked(acpRuntimeManager.getOrCreateClient).mock.calls[0]![2] as {
      onExit: (id: string, exitCode: number | null) => Promise<void>;
    };
    await acpHandlers.onExit('session-2', 0);

    expect(sessionRepository.updateSession).toHaveBeenCalledWith('session-2', {
      status: SessionStatus.COMPLETED,
    });
    expect(sessionRepository.deleteSession).not.toHaveBeenCalled();
  });

  it('closes ACP trace session even when stop cleanup throws', async () => {
    vi.mocked(acpRuntimeManager.isStopInProgress).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.stopClient).mockResolvedValue();
    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(
      unsafeCoerce({
        id: 'session-1',
        workspaceId: 'workspace-1',
        workflow: 'default',
      })
    );
    vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);
    vi.mocked(acpRuntimeManager.isSessionRunning).mockImplementation(() => {
      throw new Error('isSessionRunning failed');
    });

    await expect(sessionService.stopSession('session-1')).rejects.toThrow(
      'isSessionRunning failed'
    );

    expect(mockAcpTraceLoggerCloseSession).toHaveBeenCalledWith('session-1');
  });

  it('closes ACP trace session even when runtime-exit cleanup throws', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-2',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      provider: 'CLAUDE',
      providerSessionId: null,
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

    const acpHandle = unsafeCoerce<AcpProcessHandle>({
      getPid: vi.fn().mockReturnValue(789),
      isPromptInFlight: false,
      configOptions: [],
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
    mockCreatedAcpClient(acpHandle);
    vi.mocked(acpRuntimeManager.sendPrompt).mockResolvedValue({ stopReason: 'end_turn' });

    await sessionService.startSession('session-2');

    const acpHandlers = vi.mocked(acpRuntimeManager.getOrCreateClient).mock.calls[0]![2] as {
      onExit: (id: string, exitCode: number | null) => Promise<void>;
    };

    vi.mocked(acpRuntimeManager.isSessionRunning).mockImplementation(() => {
      throw new Error('isSessionRunning failed');
    });

    await expect(acpHandlers.onExit('session-2', 0)).rejects.toThrow('isSessionRunning failed');

    expect(mockAcpTraceLoggerCloseSession).toHaveBeenCalledWith('session-2');
  });

  it('updates DB status when ACP client is created', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      provider: 'CLAUDE',
      providerSessionId: null,
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

    const acpHandle = unsafeCoerce<AcpProcessHandle>({
      getPid: vi.fn().mockReturnValue(999),
      isPromptInFlight: false,
      configOptions: [],
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

    mockCreatedAcpClient(acpHandle);

    await sessionService.getOrCreateSessionClient('session-1');

    expect(acpRuntimeManager.getOrCreateClient).toHaveBeenCalled();
    expect(sessionRepository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.RUNNING,
    });
  });

  it('finalizes orphaned ACP tool calls when prompt ends without terminal updates', async () => {
    const pendingToolCalls = getAcpProcessorState().pendingAcpToolCalls as Map<
      string,
      Map<
        string,
        {
          toolUseId: string;
          toolName: string;
          acpKind?: string;
          acpLocations?: Array<{ path: string; line?: number | null }>;
        }
      >
    >;

    vi.mocked(acpRuntimeManager.sendPrompt).mockImplementation(() => {
      pendingToolCalls.set(
        'session-1',
        new Map([
          [
            'call-1',
            {
              toolUseId: 'call-1',
              toolName: 'Run pwd',
              acpKind: 'execute',
            },
          ],
        ])
      );
      return Promise.resolve({ stopReason: 'end_turn' } as never);
    });

    const emitDeltaSpy = vi.spyOn(sessionDomainService, 'emitDelta');
    const appendClaudeEventSpy = vi
      .spyOn(sessionDomainService, 'appendClaudeEvent')
      .mockReturnValue(77);

    await sessionService.sendAcpMessage('session-1', [{ type: 'text', text: 'hello' }]);

    expect(emitDeltaSpy).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'tool_progress',
        tool_use_id: 'call-1',
        tool_name: 'Run pwd',
        elapsed_time_seconds: 0,
      })
    );
    expect(appendClaudeEventSpy).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'user',
        message: expect.objectContaining({
          content: [
            expect.objectContaining({
              type: 'tool_result',
              tool_use_id: 'call-1',
              is_error: true,
            }),
          ],
        }),
      })
    );
    expect(pendingToolCalls.has('session-1')).toBe(false);
  });

  it('does not synthesize tool call completion when no ACP tool calls are pending', async () => {
    vi.mocked(acpRuntimeManager.sendPrompt).mockResolvedValue({ stopReason: 'end_turn' } as never);
    const appendClaudeEventSpy = vi.spyOn(sessionDomainService, 'appendClaudeEvent');

    await sessionService.sendAcpMessage('session-1', [{ type: 'text', text: 'hello' }]);

    expect(appendClaudeEventSpy).not.toHaveBeenCalled();
  });

  it('requests prompt cancellation instead of hard-stopping on tool timeout', async () => {
    vi.useFakeTimers();
    try {
      const acpProcessor = getAcpProcessorState();
      vi.mocked(acpRuntimeManager.isSessionRunning).mockReturnValue(true);
      vi.mocked(acpRuntimeManager.isSessionWorking).mockReturnValue(true);
      vi.mocked(acpRuntimeManager.cancelPrompt).mockResolvedValue(undefined);

      acpProcessor.registerSessionContext('session-1', {
        workspaceId: 'workspace-1',
        workingDir: '/tmp/work',
      });
      acpProcessor.beginPromptTurn('session-1');
      acpProcessor.handleAcpDelta(
        'session-1',
        unsafeCoerce({
          type: 'agent_message',
          data: {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'tool-timeout',
                name: 'exec_command',
                input: {},
              },
            },
          },
        })
      );

      vi.advanceTimersByTime(3_600_001);
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(acpRuntimeManager.cancelPrompt).toHaveBeenCalledWith('session-1');
      expect(acpRuntimeManager.stopClient).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('schedules prompt-turn completion callbacks after ACP prompt settles', async () => {
    vi.useFakeTimers();
    try {
      const onPromptTurnComplete = vi.fn().mockResolvedValue(undefined);
      sessionService.setPromptTurnCompleteHandler(onPromptTurnComplete);
      vi.mocked(acpRuntimeManager.sendPrompt).mockResolvedValue({
        stopReason: 'end_turn',
      } as never);

      await sessionService.sendAcpMessage('session-1', [{ type: 'text', text: 'hello' }]);

      expect(onPromptTurnComplete).not.toHaveBeenCalled();
      await vi.runOnlyPendingTimersAsync();
      expect(onPromptTurnComplete).toHaveBeenCalledWith('session-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels scheduled prompt-turn completion callback when session stops first', async () => {
    vi.useFakeTimers();
    try {
      const onPromptTurnComplete = vi.fn().mockResolvedValue(undefined);
      sessionService.setPromptTurnCompleteHandler(onPromptTurnComplete);
      vi.mocked(acpRuntimeManager.sendPrompt).mockResolvedValue({
        stopReason: 'end_turn',
      } as never);
      vi.mocked(acpRuntimeManager.stopClient).mockResolvedValue();
      vi.mocked(sessionRepository.updateSession).mockResolvedValue({} as never);

      await sessionService.sendAcpMessage('session-1', [{ type: 'text', text: 'hello' }]);
      await sessionService.stopSession('session-1');

      await vi.runOnlyPendingTimersAsync();
      expect(onPromptTurnComplete).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('swallows prompt-turn completion callback failures', async () => {
    vi.useFakeTimers();
    try {
      const onPromptTurnComplete = vi.fn().mockRejectedValue(new Error('dispatch failed'));
      sessionService.setPromptTurnCompleteHandler(onPromptTurnComplete);
      vi.mocked(acpRuntimeManager.sendPrompt).mockResolvedValue({
        stopReason: 'end_turn',
      } as never);

      await expect(
        sessionService.sendAcpMessage('session-1', [{ type: 'text', text: 'hello' }])
      ).resolves.toBe('end_turn');
      await vi.runOnlyPendingTimersAsync();
      expect(onPromptTurnComplete).toHaveBeenCalledWith('session-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('avoids redundant session DB lookups during startSession', async () => {
    const session = unsafeCoerce<
      NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>
    >({
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      provider: 'CLAUDE',
      providerSessionId: null,
    });

    const workspace = unsafeCoerce<Awaited<ReturnType<typeof sessionRepository.getWorkspaceById>>>({
      id: 'workspace-1',
      worktreePath: '/tmp/work',
      branchName: 'feature-branch',
      isAutoGeneratedBranch: false,
      hasHadSessions: true,
      name: 'Workspace A',
      description: null,
      projectId: 'project-1',
    });

    const acpHandle = unsafeCoerce<AcpProcessHandle>({
      getPid: vi.fn().mockReturnValue(111),
      isPromptInFlight: false,
      configOptions: [],
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
    mockCreatedAcpClient(acpHandle);
    vi.mocked(acpRuntimeManager.sendPrompt).mockResolvedValue({ stopReason: 'end_turn' });

    await sessionService.startSession('session-1', { initialPrompt: 'go' });

    // startSession loads session once and passes to getOrCreateAcpSessionClient(session)
    // which passes to createAcpClient(session) -> loadSessionContext(preloadedSession)
    // Total: 1 call (session is passed through, no redundant DB lookup)
    expect(sessionRepository.getSessionById).toHaveBeenCalledTimes(1);
  });

  it('normalizes stale loading runtime to idle when no process is active', () => {
    vi.spyOn(sessionDomainService, 'getRuntimeSnapshot').mockReturnValue({
      phase: 'loading',
      processState: 'unknown',
      activity: 'IDLE',
      updatedAt: new Date('2026-02-10T01:45:35.844Z').toISOString(),
    });

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

    const runtime = sessionService.getRuntimeSnapshot('session-1');

    expect(runtime).toMatchObject({
      phase: 'loading',
      processState: 'unknown',
      activity: 'IDLE',
    });
  });

  it('keeps updatedAt stable while ACP client remains in same runtime state', () => {
    const updatedAt = '2026-02-10T01:45:35.844Z';
    vi.spyOn(sessionDomainService, 'getRuntimeSnapshot').mockReturnValue({
      phase: 'idle',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt,
    });

    vi.mocked(acpRuntimeManager.getClient).mockReturnValue(
      unsafeCoerce<AcpProcessHandle>({
        isPromptInFlight: false,
        configOptions: [],
      })
    );
    vi.mocked(acpRuntimeManager.isSessionWorking).mockReturnValue(false);

    const runtime = sessionService.getRuntimeSnapshot('session-1');

    expect(runtime).toEqual({
      phase: 'idle',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt,
    });
  });

  it('stops all ACP clients during shutdown', async () => {
    vi.mocked(acpRuntimeManager.stopAllClients).mockResolvedValue(undefined);

    await sessionService.stopAllClients(4321);

    expect(acpRuntimeManager.stopAllClients).toHaveBeenCalledTimes(1);
    expect(acpRuntimeManager.stopAllClients).toHaveBeenCalledWith(4321);
  });

  it('propagates ACP shutdown failure', async () => {
    vi.mocked(acpRuntimeManager.stopAllClients).mockRejectedValueOnce(
      new Error('acp shutdown failed')
    );

    await expect(sessionService.stopAllClients()).rejects.toThrow('acp shutdown failed');
    expect(acpRuntimeManager.stopAllClients).toHaveBeenCalledWith(5000);
  });
});
