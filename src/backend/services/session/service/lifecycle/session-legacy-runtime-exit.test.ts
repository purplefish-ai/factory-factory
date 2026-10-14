import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { SessionStatus } from '@/shared/core';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

const mockNotifyToolStart = vi.fn();
const mockNotifyToolComplete = vi.fn();
const mockRecordRatchetSessionEnd = vi.fn();
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
  const RuntimeQuiescence =
    actual.AcpRuntimeQuiescence as typeof import('@/backend/services/session/service/acp').AcpRuntimeQuiescence;
  const stopClient = vi.fn(async () => undefined);
  let quiescence = new RuntimeQuiescence({ stopClient });
  beforeEach(() => {
    stopClient.mockReset().mockResolvedValue(undefined);
    quiescence = new RuntimeQuiescence({ stopClient });
  });
  const runtimeManager = {
    getClient: vi.fn().mockReturnValue(undefined),
    getOrCreateClient: vi.fn(),
    runClientCreationOperation: vi.fn((sessionId, purpose, operation) =>
      quiescence.runClientCreationOperation(sessionId, purpose, operation)
    ),
    stopClient,
    stopAndQuiesce: vi.fn((sessionId: string) => quiescence.stopAndQuiesce(sessionId)),
    beginShutdown: vi.fn().mockReturnValue([]),
    stopAllClients: vi.fn(),
    sendPrompt: vi.fn(),
    cancelPrompt: vi.fn(),
    isSessionRunning: vi.fn().mockReturnValue(false),
    isSessionWorking: vi.fn().mockReturnValue(false),
    isAnySessionWorking: vi.fn().mockReturnValue(false),
    isBrowseOnlySession: vi.fn().mockReturnValue(false),
    isStopInProgress: vi.fn().mockReturnValue(false),
    setConfigOption: vi.fn(),
    setSessionMode: vi.fn(),
    setSessionModel: vi.fn(),
  };
  return {
    ...actual,
    AcpEventTranslator: class MockAcpEventTranslator {
      translateSessionUpdate = vi.fn().mockReturnValue([]);
    },
    AcpPermissionBridge: class MockAcpPermissionBridge {
      cancelAll = vi.fn();
      resolvePermission = vi.fn();
    },
    acpRuntimeManager: runtimeManager,
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
    markWorkspaceHasHadSessions: vi.fn(),
    updateSession: vi.fn(),
    updateSessionIfStatus: vi.fn(),
    deleteSession: vi.fn(),
    recoverStaleRunningSessions: vi.fn(),
  },
}));
vi.mock('@/backend/services/session/service/logging/acp-trace-logger.service', () => ({
  acpTraceLogger: {
    log: vi.fn(),
    closeSession: (...args: unknown[]) => mockAcpTraceLoggerCloseSession(...args),
  },
}));

import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { acpRuntimeManager } from '@/backend/services/session/service/acp';
import { workspaceDataService } from '@/backend/services/workspace';
import { closedSessionPersistenceService } from './closed-session-persistence.service';
import {
  acpEventProcessor,
  sessionLifecycleService,
  sessionPromptTurnCompletionService,
  sessionService,
} from './session-services';
import { sessionRepository } from './session.repository';

const activeRuntime = {
  incarnationId: '11111111-1111-4111-8111-111111111111',
  purpose: 'active',
  managed: false,
} as const;

const getAcpProcessorState = () => acpEventProcessor;
function mockCreatedAcpClient(acpHandle: AcpProcessHandle): void {
  vi.mocked(acpRuntimeManager.getOrCreateClient).mockImplementation(() => {
    vi.mocked(acpRuntimeManager.getClient).mockReturnValue(acpHandle);
    return Promise.resolve(acpHandle);
  });
}
describe('retained legacy runtime exit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotifyToolStart.mockReset();
    mockNotifyToolComplete.mockReset();
    mockRecordRatchetSessionEnd.mockReset();
    mockAcpTraceLoggerCloseSession.mockReset();
    const acpProcessor = getAcpProcessorState();
    acpProcessor.pendingAcpToolCalls.clear();
    acpProcessor.sessionToWorkspace.clear();
    acpProcessor.sessionToWorkingDir.clear();
    sessionPromptTurnCompletionService.setHandler(null);
    const workspaceBridge = {
      markSessionRunning: vi.fn(),
      markSessionIdle: vi.fn(),
      recordRatchetSessionEnd: mockRecordRatchetSessionEnd,
      resetPRDiscoveryBackoff: vi.fn(async () => true),
    };
    sessionService.configure({ workspace: workspaceBridge });
    sessionLifecycleService.configure({ workspace: workspaceBridge });
    vi.mocked(acpRuntimeManager.getClient).mockReturnValue(undefined);
    vi.mocked(acpRuntimeManager.isSessionRunning).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.isSessionWorking).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.isAnySessionWorking).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.isBrowseOnlySession).mockReturnValue(false);
    vi.mocked(acpRuntimeManager.isStopInProgress).mockReturnValue(false);
    vi.mocked(workspaceDataService.findById).mockResolvedValue(
      unsafeCoerce({
        id: 'workspace-1',
        worktreePath: '/tmp/work',
      })
    );
    vi.mocked(closedSessionPersistenceService.persistClosedSession).mockResolvedValue();
    vi.mocked(sessionRepository.updateSessionIfStatus).mockResolvedValue(1);
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

    const acpHandle = unsafeCoerce<AcpProcessHandle>({
      getPid: vi.fn().mockReturnValue(456),
      isPromptInFlight: false,
      configOptions: [],
    });

    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(session);
    vi.mocked(sessionRepository.getWorkspaceById).mockResolvedValue(workspace);
    vi.mocked(sessionRepository.markWorkspaceHasHadSessions).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue(session);
    vi.mocked(sessionRepository.deleteSession).mockResolvedValue(session);

    mockCreatedAcpClient(acpHandle);
    vi.mocked(acpRuntimeManager.sendPrompt).mockResolvedValue({ stopReason: 'end_turn' });
    const clearSessionSpy = vi.spyOn(sessionDomainService, 'clearSession');

    // Install an ordinary runtime; exit reads the retained legacy workflow row.
    // Legacy workflows can no longer be started after the PR-monitoring cutover.
    vi.mocked(sessionRepository.getSessionById).mockResolvedValueOnce({
      ...session,
      workflow: 'default',
    });
    await sessionLifecycleService.startSession('session-1');

    // Dispatch the exit of the active runtime created for this session.
    const acpHandlers = vi.mocked(acpRuntimeManager.getOrCreateClient).mock.calls[0]![2];
    await acpHandlers.onRuntimeExit!({ ...activeRuntime, sessionId: 'session-1', exitCode: 0 });

    expect(sessionRepository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.COMPLETED,
    });
    expect(mockRecordRatchetSessionEnd).toHaveBeenCalledWith(
      'workspace-1',
      'session-1',
      'COMPLETED'
    );
    expect(sessionRepository.deleteSession).toHaveBeenCalledWith('session-1');
    expect(clearSessionSpy).toHaveBeenCalledWith('session-1', { permanentlyDeleted: true });
    const destructiveClearCallIndex = clearSessionSpy.mock.calls.findIndex(
      ([sessionId, options]) => sessionId === 'session-1' && options?.permanentlyDeleted === true
    );
    expect(destructiveClearCallIndex).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(sessionRepository.deleteSession).mock.invocationCallOrder[0]).toBeLessThan(
      clearSessionSpy.mock.invocationCallOrder[destructiveClearCallIndex]!
    );
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

    const acpHandle = unsafeCoerce<AcpProcessHandle>({
      getPid: vi.fn().mockReturnValue(456),
      isPromptInFlight: false,
      configOptions: [],
    });

    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(session);
    vi.mocked(sessionRepository.getWorkspaceById).mockResolvedValue(workspace);
    vi.mocked(sessionRepository.markWorkspaceHasHadSessions).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue(session);
    vi.mocked(sessionRepository.deleteSession).mockResolvedValue(session);
    vi.mocked(closedSessionPersistenceService.persistClosedSession).mockRejectedValue(
      new Error('Disk full')
    );

    mockCreatedAcpClient(acpHandle);
    vi.mocked(acpRuntimeManager.sendPrompt).mockResolvedValue({ stopReason: 'end_turn' });

    // Install an ordinary runtime; exit reads the retained legacy workflow row.
    // Legacy workflows can no longer be started after the PR-monitoring cutover.
    vi.mocked(sessionRepository.getSessionById).mockResolvedValueOnce({
      ...session,
      workflow: 'default',
    });
    await sessionLifecycleService.startSession('session-1');

    const acpHandlers = vi.mocked(acpRuntimeManager.getOrCreateClient).mock.calls[0]![2];
    await expect(
      acpHandlers.onRuntimeExit!({ ...activeRuntime, sessionId: 'session-1', exitCode: 0 })
    ).resolves.toBeUndefined();

    expect(sessionRepository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.COMPLETED,
    });
    expect(closedSessionPersistenceService.persistClosedSession).toHaveBeenCalledTimes(1);
    expect(sessionRepository.deleteSession).not.toHaveBeenCalled();
  });
});
