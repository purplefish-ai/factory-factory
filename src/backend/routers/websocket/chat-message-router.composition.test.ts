import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultApplicationDependencies } from '@/backend/app-context';
import {
  sessionLifecycleService,
  sessionDispatchService,
  sessionBackgroundDeliveryService,
  sessionDomainService,
} from '@/backend/services/session';
import { WorkspaceStatus } from '@/shared/core';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { createChatMessageRouterForApplication } from './chat-message-router';
const router = createChatMessageRouterForApplication(
  createDefaultApplicationDependencies().services
);

describe('chat router application composition', () => {
  afterEach(() => {
    sessionDomainService.clearAllSessions();
    vi.restoreAllMocks();
  });
  it('filters chat-only startup options before calling the shared lifecycle service', async () => {
    vi.spyOn(sessionLifecycleService, 'getSessionOptions').mockResolvedValue({
      workingDir: '/tmp/worktree',
      resumeProviderSessionId: undefined,
      model: 'sonnet',
      workspaceStatus: WorkspaceStatus.READY,
    });
    const getOrCreateSessionClient = vi
      .spyOn(sessionLifecycleService, 'getOrCreateSessionClient')
      .mockResolvedValue(unsafeCoerce({ sessionId: 'session-1' }));

    await router.handleMessage('session-1', '/tmp/worktree', {
      type: 'start',
      thinkingEnabled: true,
      planModeEnabled: true,
      selectedModel: 'opus',
      reasoningEffort: 'high',
    });

    expect(getOrCreateSessionClient).toHaveBeenCalledOnce();
    expect(getOrCreateSessionClient).toHaveBeenCalledWith('session-1', {
      thinkingEnabled: true,
      model: 'opus',
      reasoningEffort: 'high',
    });
  });

  it('routes user queue, manual resume, and stop requests through the public dispatcher', async () => {
    const dispatch = vi.spyOn(sessionDispatchService, 'tryDispatchNextMessage').mockResolvedValue();
    const resume = vi.spyOn(sessionDispatchService, 'setManualDispatchResume');
    const reset = vi.spyOn(sessionDispatchService, 'resetDispatchState');
    const stop = vi.spyOn(sessionLifecycleService, 'stopSession').mockResolvedValue();
    vi.spyOn(sessionBackgroundDeliveryService, 'captureResumeGuard').mockReturnValue(() => true);
    vi.spyOn(sessionBackgroundDeliveryService, 'userResume').mockResolvedValue();

    await router.handleMessage('queued-session', '/tmp/worktree', {
      type: 'queue_message',
      id: 'user-message',
      text: 'hello from the user',
    });
    expect(sessionDomainService.peekNextMessage('queued-session')).toMatchObject({
      id: 'user-message',
      text: 'hello from the user',
    });
    await router.handleMessage('queued-session', '/tmp/worktree', {
      type: 'resume_queued_messages',
    });
    await router.handleMessage('queued-session', '/tmp/worktree', {
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
});
