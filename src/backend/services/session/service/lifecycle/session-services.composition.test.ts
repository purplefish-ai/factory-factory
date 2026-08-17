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
import { SessionStartupCoordinator } from './session-startup.coordinator';

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

  it('exports the public lifecycle singleton with startup configured', async () => {
    const ensureSubagentBrowseSession = vi
      .spyOn(SessionStartupCoordinator.prototype, 'ensureSubagentBrowseSession')
      .mockResolvedValueOnce(false);

    await expect(
      publicSessionLifecycleService.ensureSubagentBrowseSession('session-1')
    ).resolves.toBe(false);

    expect(ensureSubagentBrowseSession).toHaveBeenCalledWith('session-1');
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
