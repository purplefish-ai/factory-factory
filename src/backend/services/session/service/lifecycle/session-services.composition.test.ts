import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chatMessageHandlerService as publicChatMessageHandlerService,
  sessionLifecycleService as publicSessionLifecycleService,
  sessionDispatchService as publicSessionDispatchService,
  sessionBackgroundDeliveryService,
  sessionDomainService,
} from '@/backend/services/session';
import { WorkspaceStatus } from '@/shared/core';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { sessionLifecycleService as coreSessionLifecycleService } from './session-core-services';
import {
  createLifecycleHarness,
  createLifecycleTestSession,
} from './session-lifecycle.test-helpers';
import {
  chatMessageHandlerService,
  sessionLifecycleService,
  sessionDispatchService,
} from './session-services';

describe('session services composition', () => {
  afterEach(() => {
    sessionDomainService.clearAllSessions();
    vi.restoreAllMocks();
  });

  it('exports one configured chat singleton whose startup adapter filters chat-only options', async () => {
    expect(publicChatMessageHandlerService).toBe(chatMessageHandlerService);
    expect(publicSessionLifecycleService).toBe(sessionLifecycleService);
    expect(coreSessionLifecycleService).toBe(sessionLifecycleService);
    vi.spyOn(sessionLifecycleService, 'getSessionOptions').mockResolvedValue({
      workingDir: '/tmp/worktree',
      resumeProviderSessionId: undefined,
      model: 'sonnet',
      workspaceStatus: WorkspaceStatus.READY,
    });
    const getOrCreateSessionClient = vi
      .spyOn(sessionLifecycleService, 'getOrCreateSessionClient')
      .mockResolvedValue(unsafeCoerce({ sessionId: 'session-1' }));

    await chatMessageHandlerService.handleMessage(
      unsafeCoerce({ send: vi.fn() }),
      'session-1',
      '/tmp/worktree',
      {
        type: 'start',
        thinkingEnabled: true,
        planModeEnabled: true,
        selectedModel: 'opus',
        reasoningEffort: 'high',
      }
    );

    expect(getOrCreateSessionClient).toHaveBeenCalledOnce();
    expect(getOrCreateSessionClient).toHaveBeenCalledWith('session-1', {
      thinkingEnabled: true,
      model: 'opus',
      reasoningEffort: 'high',
    });
  });

  it('routes user queue, manual resume, and stop requests through the public dispatcher', async () => {
    expect(publicSessionDispatchService).toBe(sessionDispatchService);
    const dispatch = vi.spyOn(sessionDispatchService, 'tryDispatchNextMessage').mockResolvedValue();
    const resume = vi.spyOn(sessionDispatchService, 'setManualDispatchResume');
    const reset = vi.spyOn(sessionDispatchService, 'resetDispatchState');
    const stop = vi.spyOn(sessionLifecycleService, 'stopSession').mockResolvedValue();
    vi.spyOn(sessionBackgroundDeliveryService, 'captureResumeGuard').mockReturnValue(() => true);
    vi.spyOn(sessionBackgroundDeliveryService, 'userResume').mockResolvedValue();
    const socket = unsafeCoerce<Parameters<typeof chatMessageHandlerService.handleMessage>[0]>({
      send: vi.fn(),
    });

    await chatMessageHandlerService.handleMessage(socket, 'queued-session', '/tmp/worktree', {
      type: 'queue_message',
      id: 'user-message',
      text: 'hello from the user',
    });
    expect(sessionDomainService.peekNextMessage('queued-session')).toMatchObject({
      id: 'user-message',
      text: 'hello from the user',
    });
    await chatMessageHandlerService.handleMessage(socket, 'queued-session', '/tmp/worktree', {
      type: 'resume_queued_messages',
    });
    await chatMessageHandlerService.handleMessage(socket, 'queued-session', '/tmp/worktree', {
      type: 'stop',
    });

    expect(dispatch.mock.calls).toEqual([
      ['queued-session'],
      ['queued-session'],
      ['queued-session'],
    ]);
    expect(resume).toHaveBeenCalledExactlyOnceWith('queued-session', true);
    expect(stop).toHaveBeenCalledExactlyOnceWith('queued-session', { reason: 'USER_STOP' });
    expect(reset).toHaveBeenCalledExactlyOnceWith('queued-session');
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(reset.mock.invocationCallOrder[0]!);
    expect(sessionDomainService.peekNextMessage('queued-session')?.id).toBe('user-message');
  });

  it('composes browse startup through the real startup coordinator', async () => {
    const { service, runtimeManager } = createLifecycleHarness({
      provider: 'CODEX',
      providerSessionId: 'provider-session-1',
    });
    runtimeManager.getSubagentBrowseCapability.mockImplementation(() =>
      runtimeManager.getOrCreateClient.mock.calls.length > 0
        ? { version: 1, list: true, read: true, notifications: true }
        : null
    );

    await expect(service.ensureSubagentBrowseSession('session-1')).resolves.toBe(true);

    expect(runtimeManager.getOrCreateClient).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        provider: 'CODEX',
        purpose: 'browse',
        resumeProviderSessionId: 'provider-session-1',
      }),
      expect.objectContaining({
        onRuntimeError: expect.any(Function),
        onRuntimeExit: expect.any(Function),
      }),
      {
        workspaceId: 'workspace-1',
        workingDir: '/tmp/workspace',
      }
    );
  });

  it('builds runtime handlers backed by complete lifecycle harness ports', async () => {
    const { service, runtimeManager, sessionDomainService, acpEventProcessor } =
      createLifecycleHarness();
    await service.getOrCreateSessionClient('session-1');
    const handlers = runtimeManager.getOrCreateClient.mock.calls[0]?.[2];
    expect(handlers?.onRuntimeError).toEqual(expect.any(Function));
    expect(handlers?.onAcpLog).toEqual(expect.any(Function));

    await handlers?.onRuntimeError?.({
      sessionId: 'session-1',
      error: new Error('runtime failed'),
      incarnationId: 'incarnation-1',
      purpose: 'active',
    });
    handlers?.onAcpLog?.('session-1', { message: 'provider log' });

    expect(sessionDomainService.markError).toHaveBeenCalledWith('session-1', 'runtime failed');
    expect(acpEventProcessor.handleAcpLog).toHaveBeenCalledWith('session-1', {
      message: 'provider log',
    });
  });

  it('builds workflow finalization with recovery and transient deletion ports', async () => {
    const { service, sessionDomainService } = createLifecycleHarness({
      session: { workflow: 'ratchet' },
    });

    await expect(service.recoverStaleRunningSessions()).resolves.toBe(0);
    await service.stopSession('session-1', {
      cleanupTransientRatchetSession: true,
      recordLifecycleEvent: false,
    });

    expect(sessionDomainService.clearSession).toHaveBeenCalledWith('session-1', {
      permanentlyDeleted: true,
    });
  });

  it('wires a lifecycle coordinator to a later workspace bridge without mutating the singleton', async () => {
    const { service, repository, runtimeManager } = createLifecycleHarness();
    const workspaceBridge = {
      markSessionIdle: vi.fn(),
    };
    service.configure({ workspace: unsafeCoerce(workspaceBridge) });
    repository.getSessionById.mockResolvedValue(
      createLifecycleTestSession({ id: 'session-composed', workspaceId: 'workspace-composed' })
    );
    repository.updateSessionIfStatus.mockResolvedValue(1);

    await service.stopSession('session-composed', {
      recordLifecycleEvent: false,
    });

    expect(runtimeManager.stopAndQuiesce).toHaveBeenCalledWith('session-composed');
    expect(workspaceBridge.markSessionIdle).toHaveBeenCalledWith(
      'workspace-composed',
      'session-composed'
    );
  });
});
