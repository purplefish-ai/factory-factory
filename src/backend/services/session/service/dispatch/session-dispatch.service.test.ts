import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { QueuedMessage } from '@/shared/acp-protocol';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionDispatchService } from './session-dispatch.service';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function enqueue(id: string) {
  const message: QueuedMessage = {
    id,
    text: id,
    timestamp: '2026-10-27T00:00:00Z',
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  };
  sessionDomainService.enqueue('session', message);
  return message;
}

function harness(policy: 'allowed' | 'manual_resume' = 'allowed') {
  let generation = 0;
  const sendSessionMessage = vi.fn().mockResolvedValue(undefined);
  const startup = {
    getSessionClient: vi.fn<() => unknown>().mockReturnValue({}),
    getOrCreateSessionClient: vi.fn().mockResolvedValue({}),
  };
  const dispatcher = new SessionDispatchService({
    runtimeManager: { isSessionWorking: () => false, isSessionRunning: () => true },
    configService: {
      setSessionCollaborationMode: vi.fn().mockResolvedValue(undefined),
      setSessionThinkingBudget: vi.fn().mockResolvedValue(undefined),
      setSessionModel: vi.fn().mockResolvedValue(undefined),
      setSessionReasoningEffort: vi.fn().mockResolvedValue(undefined),
    },
    promptService: { sendSessionMessage },
    backgroundDelivery: {
      prepare: vi.fn(),
      validate: vi.fn(),
      fail: vi.fn(),
      complete: vi.fn(),
    },
  });
  dispatcher.configure({
    initPolicy: { getWorkspaceInitPolicy: () => ({ dispatchPolicy: policy }) },
  });
  dispatcher.configureLifecycle({
    gate: {
      getGeneration: () => generation,
      isGenerationCurrent: (_sessionId, expected) => expected === generation,
      isSessionStopping: () => false,
    },
    startup,
    notificationDelivery: {
      claimForDispatch: () => ({ status: 'not_notification' }),
      isAlreadyDelivered: async () => false,
      acknowledgeSuccessfulDispatch: async () => undefined,
      recoverPending: async () => ({ dispatchableCount: 0 }),
      resetSession: () => undefined,
      removeDuplicateFromQueue: () => false,
      isNotificationMessage: () => false,
    },
  });
  vi.spyOn(sessionDataService, 'findAgentSessionById').mockResolvedValue(
    unsafeCoerce({ workspace: { status: 'READY', worktreePath: '/tmp/workspace' } })
  );
  return {
    dispatcher,
    sendSessionMessage,
    startup,
    stop: () => {
      generation += 1;
    },
  };
}

afterEach(() => {
  sessionDomainService.clearAllSessions();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('session dispatcher queue and lifecycle coordination', () => {
  it('keeps the queued message visible until startup finishes across repeated dispatch requests', async () => {
    const { dispatcher, startup, sendSessionMessage } = harness();
    const message = enqueue('first');
    const started = deferred();
    startup.getSessionClient.mockReturnValue(undefined);
    startup.getOrCreateSessionClient.mockImplementation(async () => {
      await started.promise;
      startup.getSessionClient.mockReturnValue({});
      return {};
    });
    const pending = dispatcher.tryDispatchNextMessage('session');
    await vi.waitFor(() => expect(startup.getOrCreateSessionClient).toHaveBeenCalledOnce());
    await dispatcher.tryDispatchNextMessage('session');
    expect(sessionDomainService.peekNextMessage('session')).toBe(message);
    expect(sendSessionMessage).not.toHaveBeenCalled();
    started.resolve();
    await pending;
    expect(sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'first');
    expect(sessionDomainService.peekNextMessage('session')).toBeUndefined();
  });

  it('does not let an old completion unlock a replacement dispatch after lifecycle reset', async () => {
    const { dispatcher, sendSessionMessage, stop } = harness();
    const first = deferred();
    const second = deferred();
    sendSessionMessage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    enqueue('first');
    const oldDispatch = dispatcher.tryDispatchNextMessage('session');
    await vi.waitFor(() => expect(sendSessionMessage).toHaveBeenCalledTimes(1));
    stop();
    dispatcher.resetDispatchState('session');
    enqueue('second');
    const replacement = dispatcher.tryDispatchNextMessage('session');
    await vi.waitFor(() => expect(sendSessionMessage).toHaveBeenCalledTimes(2));
    first.resolve();
    await oldDispatch;
    const third = enqueue('third');
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage).toHaveBeenCalledTimes(2);
    expect(sessionDomainService.peekNextMessage('session')).toBe(third);
    second.resolve();
    await replacement;
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage.mock.calls).toEqual([
      ['session', 'first'],
      ['session', 'second'],
      ['session', 'third'],
    ]);
  });

  it('preserves manual resume across dispatch requests and preserves it when dispatch state resets', async () => {
    const { dispatcher, sendSessionMessage } = harness('manual_resume');
    const message = enqueue('first');
    await dispatcher.tryDispatchNextMessage('session');
    expect(sessionDomainService.peekNextMessage('session')).toBe(message);
    dispatcher.setManualDispatchResume('session', true);
    await dispatcher.tryDispatchNextMessage('session');
    dispatcher.resetDispatchState('session');
    enqueue('second');
    await dispatcher.tryDispatchNextMessage('session');
    dispatcher.setManualDispatchResume('session', false);
    const third = enqueue('third');
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage.mock.calls).toEqual([
      ['session', 'first'],
      ['session', 'second'],
    ]);
    expect(sessionDomainService.peekNextMessage('session')).toBe(third);
  });

  it('shares busy backoff and cancels its retry timer through dispatch-state reset', async () => {
    vi.useFakeTimers();
    const { dispatcher, sendSessionMessage } = harness();
    sendSessionMessage.mockRejectedValueOnce(
      new Error('A turn is already in progress for this session')
    );
    const message = enqueue('first');
    await dispatcher.tryDispatchNextMessage('session');
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage).toHaveBeenCalledOnce();
    expect(sessionDomainService.peekNextMessage('session')).toBe(message);
    await vi.advanceTimersByTimeAsync(999);
    expect(sendSessionMessage).toHaveBeenCalledOnce();
    dispatcher.resetDispatchState('session');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendSessionMessage).toHaveBeenCalledOnce();
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage).toHaveBeenCalledTimes(2);
  });
});
