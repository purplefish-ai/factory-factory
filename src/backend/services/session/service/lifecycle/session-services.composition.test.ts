import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chatMessageHandlerService as publicChatMessageHandlerService,
  sessionLifecycleService as publicSessionLifecycleService,
} from '@/backend/services/session';
import { WorkspaceStatus } from '@/shared/core';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { sessionLifecycleService as coreSessionLifecycleService } from './session-core-services';
import {
  createLifecycleHarness,
  createLifecycleTestSession,
} from './session-lifecycle.test-helpers';
import { chatMessageHandlerService, sessionLifecycleService } from './session-services';

describe('session services composition', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports one configured chat singleton whose startup adapter filters chat-only options', async () => {
    expect(publicChatMessageHandlerService).toBe(chatMessageHandlerService);
    expect(publicSessionLifecycleService).toBe(sessionLifecycleService);
    expect(coreSessionLifecycleService).toBe(sessionLifecycleService);
    vi.spyOn(sessionLifecycleService, 'getSessionOptions').mockResolvedValue({
      workingDir: '/tmp/worktree',
      resumeProviderSessionId: undefined,
      systemPrompt: undefined,
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

    handlers?.onRuntimeError?.({
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

    expect(sessionDomainService.clearSession).toHaveBeenCalledWith('session-1');
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
