import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpSteeringTimeoutError } from '@/backend/services/session/service/acp/acp-steering';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import { SessionNotificationDeliveryService } from '@/backend/services/session/service/lifecycle/session-notification-delivery.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { buildTranscriptFromHistory } from '@/backend/services/session/service/store/session-transcript';
import type { AgentContentItem, QueuedMessage } from '@/shared/acp-protocol';
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

function harness(
  policy: 'allowed' | 'manual_resume' = 'allowed',
  notifications?: SessionNotificationDeliveryService,
  eventAuthority?: { assertOrdinary(id: string): Promise<void> }
) {
  let generation = 0;
  const sendSessionMessage = vi
    .fn<(sessionId: string, content: string | AgentContentItem[]) => Promise<void>>()
    .mockResolvedValue(undefined);
  const steerSessionMessage = vi.fn().mockResolvedValue({ outcome: 'injected' });
  const startup = {
    getSessionClient: vi.fn<() => unknown>().mockReturnValue({}),
    getOrCreateSessionClient: vi.fn().mockResolvedValue({}),
  };
  const runtimeManager = {
    isSessionWorking: vi.fn(() => false),
    isSessionPromptInFlight: vi.fn(() => false),
    isSessionRunning: vi.fn(() => true),
  };
  const resolveQueuedMessageSettings = vi.fn(
    (_id: string, message: QueuedMessage) => message.settings
  );
  const configureQueuedMessage = vi.fn((_id: string, message: QueuedMessage) =>
    Promise.resolve(message.settings)
  );
  const backgroundDelivery = {
    prepare: vi.fn(),
    validate: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
  };
  const dispatcher = new SessionDispatchService({
    eventAuthority,
    runtimeManager,
    configService: {
      resolveQueuedMessageSettings,
      configureQueuedMessage,
    },
    promptService: { sendSessionMessage, steerSessionMessage },
    backgroundDelivery,
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
    notificationDelivery: notifications ?? {
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
    steerSessionMessage,
    resolveQueuedMessageSettings,
    sendSessionMessage,
    startup,
    runtimeManager,
    configureQueuedMessage,
    backgroundDelivery,
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
  it('sends all waiting human messages in one turn and retains their individual transcript entries', async () => {
    const { dispatcher, sendSessionMessage, configureQueuedMessage } = harness();
    const first = enqueue('first');
    const second = enqueue('second');
    second.settings.selectedModel = 'latest-model';
    const pending = deferred();
    sendSessionMessage.mockReturnValueOnce(pending.promise);

    const dispatch = dispatcher.tryDispatchNextMessage('session');
    await vi.waitFor(() => expect(sendSessionMessage).toHaveBeenCalledOnce());
    expect(sendSessionMessage).toHaveBeenCalledWith('session', 'first\n\nsecond');
    expect(configureQueuedMessage).toHaveBeenCalledWith('session', second, false);
    expect(sessionDomainService.getQueueLength('session')).toBe(0);
    expect(sessionDomainService.getTranscriptSnapshot('session').map(({ id }) => id)).toEqual([
      first.id,
      second.id,
    ]);
    const late = enqueue('late');
    pending.resolve();
    await dispatch;
    expect(sessionDomainService.peekNextMessage('session')).toBe(late);
    expect(sendSessionMessage).toHaveBeenCalledOnce();
  });

  it('includes a ready PR batch with queued human messages in the same prompt', async () => {
    const { dispatcher, sendSessionMessage, backgroundDelivery } = harness();
    const human = enqueue('please fix these');
    const pr: QueuedMessage = {
      ...human,
      id: 'pr-event-batch',
      source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 } },
      text: 'PR update queued for the next turn',
    };
    sessionDomainService.enqueue('session', pr);
    backgroundDelivery.prepare.mockImplementation(() => {
      pr.text = '<!-- factory-factory-pr-event:batch -->\nPR #1 and PR #2 updates';
      return Promise.resolve({ status: 'ready' });
    });
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage).toHaveBeenCalledExactlyOnceWith(
      'session',
      'please fix these\n\n<!-- factory-factory-pr-event:batch -->\nPR #1 and PR #2 updates'
    );
    expect(backgroundDelivery.complete).toHaveBeenCalledExactlyOnceWith(pr);
    expect(sessionDomainService.getQueueLength('session')).toBe(0);
  });

  it('requeues every message in its original order when the provider is busy', async () => {
    vi.useFakeTimers();
    const { dispatcher, sendSessionMessage } = harness();
    const first = enqueue('first');
    const second = enqueue('second');
    sendSessionMessage.mockImplementationOnce(() => {
      enqueue('late');
      return Promise.reject(new Error('A turn is already in progress for this session'));
    });
    await dispatcher.tryDispatchNextMessage('session');
    expect(sessionDomainService.peekNextMessage('session')).toBe(first);
    expect(sessionDomainService.getQueueLength('session')).toBe(3);
    expect(sessionDomainService.getTranscriptSnapshot('session')).toEqual([]);
    sessionDomainService.dequeueNext('session');
    expect(sessionDomainService.peekNextMessage('session')).toBe(second);
    dispatcher.resetDispatchState('session');
  });

  it('keeps slash commands as standalone turns between queued batches', async () => {
    const { dispatcher, sendSessionMessage } = harness();
    enqueue('first');
    enqueue('/compact');
    enqueue('second');
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'first');
    expect(sessionDomainService.peekNextMessage('session')?.text).toBe('/compact');
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage.mock.calls[1]).toEqual(['session', '/compact']);
    expect(sessionDomainService.peekNextMessage('session')?.text).toBe('second');
  });

  it('preserves attachments from every queued message in the combined prompt', async () => {
    const { dispatcher, sendSessionMessage } = harness();
    const first = enqueue('inspect this image');
    first.attachments = [
      {
        id: 'image',
        name: 'image.png',
        type: 'image/png',
        size: 67,
        contentType: 'image',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      },
    ];
    const second = enqueue('and these notes');
    second.attachments = [
      {
        id: 'notes',
        name: 'notes.txt',
        type: 'text/plain',
        size: 5,
        contentType: 'text',
        data: 'notes',
      },
    ];
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', [
      { type: 'text', text: 'inspect this image' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: first.attachments[0]!.data },
      },
      { type: 'text', text: '\n\nand these notes\n\n[Pasted content: notes.txt]\nnotes' },
    ]);
    expect(
      sessionDomainService.getTranscriptSnapshot('session').map(({ attachments }) => attachments)
    ).toEqual([first.attachments, second.attachments]);
  });

  it('rejects an invalid attachment without discarding the other queued messages', async () => {
    const { dispatcher, sendSessionMessage } = harness();
    const invalid = enqueue('bad');
    invalid.attachments = [
      { id: 'bad', name: 'bad.png', type: 'image/png', size: 1, contentType: 'image', data: 'bad' },
    ];
    enqueue('good');
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'good');
    expect(sessionDomainService.getTranscriptSnapshot('session').map(({ id }) => id)).toEqual([
      'good',
    ]);
  });

  it('replays human content after a PR update from the actual mixed text/image provider prompt', async () => {
    const { dispatcher, sendSessionMessage, backgroundDelivery } = harness();
    const human = enqueue('Human request\n\nSecond paragraph');
    human.attachments = [
      {
        id: 'image',
        name: 'image.png',
        type: 'image/png',
        size: 67,
        contentType: 'image',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      },
    ];
    const pr: QueuedMessage = {
      ...human,
      id: 'pr-event-before-image',
      attachments: undefined,
      text: '<!-- factory-factory-pr-event:before-image -->\nPR failed',
      source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 } },
    };
    // A busy PR-only send can be restored in front of a human message arriving mid-send.
    sessionDomainService.requeueFront('session', pr);
    backgroundDelivery.prepare.mockResolvedValue({ status: 'ready' });
    await dispatcher.tryDispatchNextMessage('session');
    const content = sendSessionMessage.mock.calls[0]?.[1];
    if (!Array.isArray(content)) {
      throw new Error('Expected text/image provider blocks');
    }
    const restored = buildTranscriptFromHistory([
      {
        type: 'user',
        uuid: 'provider-id',
        content: content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n'),
        attachments: human.attachments,
        timestamp: human.timestamp,
      },
    ]);
    expect(restored).toHaveLength(2);
    expect(restored[0]).toMatchObject({
      source: 'agent',
      message: { type: 'pr_update', text: pr.text },
    });
    expect(restored[1]).toMatchObject({
      source: 'user',
      text: human.text,
      attachments: human.attachments,
    });
  });

  it('dispatches human messages while a PR batch is blocked', async () => {
    const { dispatcher, sendSessionMessage, backgroundDelivery } = harness();
    const first = enqueue('first');
    enqueue('second');
    const pr: QueuedMessage = {
      ...first,
      id: 'pr-event-blocked',
      source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 } },
    };
    sessionDomainService.enqueue('session', pr);
    backgroundDelivery.prepare.mockResolvedValue({ status: 'blocked' });
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'first\n\nsecond');
    expect(sessionDomainService.peekNextMessage('session')).toBe(pr);
    expect(backgroundDelivery.complete).not.toHaveBeenCalled();
  });

  it('does not send any member when the session stops during batch configuration', async () => {
    const { dispatcher, sendSessionMessage, configureQueuedMessage, stop } = harness();
    enqueue('first');
    enqueue('second');
    const fail = vi.spyOn(sessionDomainService, 'failMessage');
    configureQueuedMessage.mockImplementation((_id, message) => {
      stop();
      return Promise.resolve(message.settings);
    });
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage).not.toHaveBeenCalled();
    expect(fail.mock.calls.map(([, message]) => message.id).sort()).toEqual(['first', 'second']);
    expect(sessionDomainService.getTranscriptSnapshot('session')).toEqual([]);
  });

  it('releases a validated PR claim when stop wins before the batch is submitted', async () => {
    const { dispatcher, sendSessionMessage, backgroundDelivery, stop } = harness();
    const human = enqueue('human');
    const pr: QueuedMessage = {
      ...human,
      id: 'pr-event-stop-after-validation',
      source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 } },
    };
    sessionDomainService.enqueue('session', pr);
    backgroundDelivery.prepare.mockResolvedValue({ status: 'ready' });
    backgroundDelivery.validate.mockImplementation(() => {
      // Stop after the individual validator returns true, before the batch resumes.
      queueMicrotask(() => queueMicrotask(stop));
      return Promise.resolve(true);
    });
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage).not.toHaveBeenCalled();
    expect(backgroundDelivery.fail).toHaveBeenCalledExactlyOnceWith(
      pr,
      expect.any(Error),
      'cancelled'
    );
  });

  it('retries the surviving batch when a human message is cancelled during PR preparation', async () => {
    const { dispatcher, sendSessionMessage, backgroundDelivery } = harness();
    const first = enqueue('first');
    const cancelled = enqueue('cancelled');
    const pr: QueuedMessage = {
      ...first,
      id: 'pr-event-race',
      source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 } },
    };
    sessionDomainService.enqueue('session', pr);
    const preparing = deferred();
    backgroundDelivery.prepare
      .mockImplementationOnce(async () => {
        await preparing.promise;
        pr.text = 'PR facts';
        return { status: 'ready' };
      })
      .mockResolvedValue({ status: 'ready' });
    const dispatch = dispatcher.tryDispatchNextMessage('session');
    await vi.waitFor(() => expect(backgroundDelivery.prepare).toHaveBeenCalledOnce());
    sessionDomainService.removeQueuedMessage('session', cancelled.id);
    preparing.resolve();
    await dispatch;
    expect(sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'first\n\nPR facts');
    expect(sessionDomainService.getQueueLength('session')).toBe(0);
    expect(backgroundDelivery.fail.mock.calls.every((call) => call[2] !== 'cancelled')).toBe(true);
  });

  it('dispatches the human batch even if refreshing PR facts throws', async () => {
    const { dispatcher, sendSessionMessage, backgroundDelivery } = harness();
    const first = enqueue('first');
    enqueue('second');
    const pr: QueuedMessage = {
      ...first,
      id: 'pr-event-refresh-error',
      source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 } },
    };
    sessionDomainService.enqueue('session', pr);
    backgroundDelivery.prepare.mockRejectedValue(new Error('GitHub unavailable'));
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'first\n\nsecond');
    expect(sessionDomainService.peekNextMessage('session')).toBe(pr);
  });

  it('retains successfully sent human messages if acknowledging the PR delivery fails', async () => {
    const { dispatcher, sendSessionMessage, backgroundDelivery } = harness();
    const first = enqueue('first');
    const pr: QueuedMessage = {
      ...first,
      id: 'pr-event-settlement-error',
      source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 } },
      text: 'PR facts',
    };
    sessionDomainService.enqueue('session', pr);
    backgroundDelivery.prepare.mockResolvedValue({ status: 'ready' });
    backgroundDelivery.complete.mockRejectedValue(new Error('database unavailable'));
    const fail = vi.spyOn(sessionDomainService, 'failMessage');
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'first\n\nPR facts');
    expect(fail).not.toHaveBeenCalled();
    expect(backgroundDelivery.fail).not.toHaveBeenCalled();
    expect(sessionDomainService.getTranscriptSnapshot('session').map(({ id }) => id)).toEqual([
      first.id,
      pr.id,
    ]);
  });

  it('holds every notification claim until the combined turn is received and acknowledges each one', async () => {
    const delivered = new Set<string>();
    const notifications = new SessionNotificationDeliveryService({
      notificationPort: {
        listPendingForDelivery: async () => [],
        findForDelivery: async (id) => ({ deliveredAt: delivered.has(id) ? new Date() : null }),
        markDelivered: (ids) => {
          ids.forEach((id) => delivered.add(id));
          return Promise.resolve();
        },
      },
      queuePort: sessionDomainService,
      transcriptPort: {
        getTranscriptSnapshot: (id) => sessionDomainService.getTranscriptSnapshot(id),
        getHistoryHydrationSource: () => 'none',
        appendClaudeEvent: () => 0,
      },
      deltaPort: sessionDomainService,
    });
    const { dispatcher, sendSessionMessage } = harness('allowed', notifications);
    enqueue('human');
    enqueue('workspace-notification-one');
    enqueue('workspace-notification-two');
    const pending = deferred();
    sendSessionMessage.mockReturnValueOnce(pending.promise);
    const dispatch = dispatcher.tryDispatchNextMessage('session');
    await vi.waitFor(() => expect(sendSessionMessage).toHaveBeenCalledOnce());
    expect(
      notifications.claimForDispatch('other-session', 'workspace-notification-one').status
    ).toBe('duplicate');
    expect(
      notifications.claimForDispatch('other-session', 'workspace-notification-two').status
    ).toBe('duplicate');
    expect(delivered.size).toBe(0);
    pending.resolve();
    await dispatch;
    expect([...delivered].sort()).toEqual(['one', 'two']);
    expect(sessionDomainService.getQueueLength('session')).toBe(0);
  });

  it('retains fresh background details already finalized by a failed prompt', async () => {
    const { dispatcher, sendSessionMessage } = harness();
    enqueue('follow-up');
    sendSessionMessage.mockImplementation(() => {
      sessionDomainService.setRuntimeSnapshot('session', {
        phase: 'error',
        processState: 'alive',
        activity: 'IDLE',
        errorMessage: 'Provider failed',
        updatedAt: '2026-10-28T00:00:00.000Z',
        work: {
          promptInFlight: false,
          backgroundTasks: [{ id: 'preview', name: 'pnpm storybook', kind: 'shell' }],
          runningSubagents: 0,
          activeGoals: 0,
        },
      });
      return Promise.reject(new Error('Provider failed'));
    });
    await dispatcher.tryDispatchNextMessage('session');
    expect(sessionDomainService.getRuntimeSnapshot('session')).toMatchObject({
      phase: 'error',
      errorMessage: 'Provider failed',
      work: { promptInFlight: false, backgroundTasks: [{ name: 'pnpm storybook' }] },
    });
  });

  it('dispatches a follow-up while background activity keeps the session working', async () => {
    // A long-lived shell, child agent, or goal must not own the parent's prompt slot.
    const { dispatcher, runtimeManager, sendSessionMessage } = harness();
    runtimeManager.isSessionWorking.mockReturnValue(true);
    const message = enqueue('follow-up');

    await dispatcher.tryDispatchNextMessage('session');

    expect(sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'follow-up');
    expect(sessionDomainService.peekNextMessage('session')).toBeUndefined();
    expect(sessionDomainService.getTranscriptSnapshot('session')).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: message.id })])
    );
  });

  it('keeps a message queued until the active prompt finishes even if display activity is stale', async () => {
    const { dispatcher, runtimeManager, sendSessionMessage } = harness();
    runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
    const message = enqueue('next-turn');

    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage).not.toHaveBeenCalled();
    expect(sessionDomainService.peekNextMessage('session')).toBe(message);

    runtimeManager.isSessionPromptInFlight.mockReturnValue(false);
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'next-turn');
  });

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

  it('uses newer accepted settings before starting a stopped session for an older queued turn', async () => {
    const { dispatcher, startup, resolveQueuedMessageSettings } = harness();
    enqueue('stopped-follow-up');
    startup.getSessionClient.mockReturnValue(undefined);
    startup.getOrCreateSessionClient.mockImplementation(() => {
      startup.getSessionClient.mockReturnValue({});
      return Promise.resolve({});
    });
    resolveQueuedMessageSettings.mockImplementation((_id, message) => ({
      ...message.settings,
      selectedModel: 'newer-model',
      reasoningEffort: 'high',
      planModeEnabled: true,
    }));
    await dispatcher.tryDispatchNextMessage('session');
    expect(startup.getOrCreateSessionClient).toHaveBeenCalledWith('session', {
      thinkingEnabled: false,
      planModeEnabled: true,
      model: 'newer-model',
      reasoningEffort: 'high',
    });
  });

  it('rechecks the prompt slot when another turn starts during auto-start', async () => {
    const { dispatcher, startup, runtimeManager, sendSessionMessage } = harness();
    const message = enqueue('follow-up');
    startup.getSessionClient.mockReturnValue(undefined);
    startup.getOrCreateSessionClient.mockImplementation(() => {
      startup.getSessionClient.mockReturnValue({});
      runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
      return Promise.resolve({});
    });

    await dispatcher.tryDispatchNextMessage('session');

    expect(sessionDomainService.peekNextMessage('session')).toBe(message);
    expect(sendSessionMessage).not.toHaveBeenCalled();
    runtimeManager.isSessionPromptInFlight.mockReturnValue(false);
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'follow-up');
  });

  it('waits for compaction even when no prompt or background task is active', async () => {
    const { dispatcher, startup, sendSessionMessage } = harness();
    let compacting = true;
    startup.getSessionClient.mockReturnValue({
      isCompactingActive: () => compacting,
      startCompaction: vi.fn(),
      endCompaction: vi.fn(),
    });
    const message = enqueue('after-compaction');

    await dispatcher.tryDispatchNextMessage('session');
    expect(sessionDomainService.peekNextMessage('session')).toBe(message);
    expect(sendSessionMessage).not.toHaveBeenCalled();
    compacting = false;
    await dispatcher.tryDispatchNextMessage('session');
    expect(sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'after-compaction');
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

describe('explicit queued-message steering', () => {
  it('injects only the selected queued message while the original turn remains active', async () => {
    const h = harness();
    h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
    const first = enqueue('first');
    const selected = enqueue('selected');
    await h.dispatcher.steerQueuedMessage('session', selected.id);
    expect(h.steerSessionMessage).toHaveBeenCalledWith('session', 'selected');
    expect(h.sendSessionMessage).not.toHaveBeenCalled();
    expect(h.configureQueuedMessage).not.toHaveBeenCalled();
    expect(sessionDomainService.getQueueSnapshot('session')).toEqual([first]);
    expect(sessionDomainService.getTranscriptSnapshot('session').map(({ id }) => id)).toEqual([
      selected.id,
    ]);
  });

  it('leaves failed steering queued and does not turn it into a message rejection', async () => {
    const h = harness();
    h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
    const selected = enqueue('selected');
    h.steerSessionMessage.mockRejectedValueOnce(new Error('provider refused'));
    await expect(h.dispatcher.steerQueuedMessage('session', selected.id)).rejects.toThrow(
      'provider refused'
    );
    expect(sessionDomainService.getQueueSnapshot('session')).toEqual([selected]);
    expect(sessionDomainService.getTranscriptSnapshot('session')).toEqual([]);
  });

  it('keeps host ownership when the provider reports an idle race', async () => {
    const h = harness();
    h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
    const selected = enqueue('selected');
    h.steerSessionMessage.mockResolvedValueOnce({ outcome: 'promptRequired' });
    await h.dispatcher.steerQueuedMessage('session', selected.id);
    expect(sessionDomainService.getQueueSnapshot('session')).toEqual([selected]);
    expect(h.sendSessionMessage).not.toHaveBeenCalled();
    h.runtimeManager.isSessionPromptInFlight.mockReturnValue(false);
    await h.dispatcher.tryDispatchNextMessage('session');
    await vi.waitFor(() =>
      expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'selected')
    );
  });

  it('blocks duplicate steering and normal dispatch until the steer settles', async () => {
    const h = harness();
    h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
    const selected = enqueue('selected');
    const pending = deferred();
    h.steerSessionMessage.mockImplementationOnce(async () => {
      await pending.promise;
      return { outcome: 'injected' };
    });
    const steer = h.dispatcher.steerQueuedMessage('session', selected.id);
    await vi.waitFor(() => expect(h.steerSessionMessage).toHaveBeenCalledOnce());
    await h.dispatcher.steerQueuedMessage('session', selected.id);
    h.runtimeManager.isSessionPromptInFlight.mockReturnValue(false);
    await h.dispatcher.tryDispatchNextMessage('session');
    expect(h.sendSessionMessage).not.toHaveBeenCalled();
    pending.resolve();
    await steer;
    expect(h.steerSessionMessage).toHaveBeenCalledOnce();
    expect(sessionDomainService.getQueueSnapshot('session')).toEqual([]);
  });

  it('does not steer slash commands or background messages', async () => {
    const h = harness();
    h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
    const command = enqueue('/compact');
    const background = enqueue('pr-event-hidden');
    await expect(h.dispatcher.steerQueuedMessage('session', command.id)).rejects.toThrow(
      'Only ordinary queued human messages can be steered'
    );
    await expect(h.dispatcher.steerQueuedMessage('session', background.id)).rejects.toThrow(
      'Only ordinary queued human messages can be steered'
    );
    expect(h.steerSessionMessage).not.toHaveBeenCalled();
    expect(sessionDomainService.getQueueLength('session')).toBe(2);
  });
});

it('does not resend accepted steering after a stop-generation change', async () => {
  const h = harness();
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  const selected = enqueue('selected');
  const pending = deferred();
  h.steerSessionMessage.mockImplementationOnce(async () => {
    await pending.promise;
    return { outcome: 'injected' };
  });
  const steer = h.dispatcher.steerQueuedMessage('session', selected.id);
  await vi.waitFor(() => expect(h.steerSessionMessage).toHaveBeenCalledOnce());
  h.stop();
  pending.resolve();
  await steer;
  expect(sessionDomainService.hasQueuedMessage('session', selected.id)).toBe(false);
  expect(h.sendSessionMessage).not.toHaveBeenCalled();
});

it('preserves validated attachments when steering a selected message', async () => {
  const h = harness();
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  const selected = enqueue('selected');
  selected.attachments = [
    {
      id: 'a',
      name: 'notes.txt',
      type: 'text/plain',
      size: 7,
      data: 'context',
      contentType: 'text',
    },
  ];
  await h.dispatcher.steerQueuedMessage('session', selected.id);
  expect(h.steerSessionMessage).toHaveBeenCalledWith(
    'session',
    expect.stringContaining('[Pasted content: notes.txt]\ncontext')
  );
});

it('wakes normal queue delivery if the turn completes before a failed steer settles', async () => {
  const h = harness();
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  const selected = enqueue('selected');
  const pending = deferred();
  h.steerSessionMessage.mockImplementationOnce(async () => {
    await pending.promise;
    throw new Error('steer refused');
  });
  const steer = h.dispatcher.steerQueuedMessage('session', selected.id);
  await vi.waitFor(() => expect(h.steerSessionMessage).toHaveBeenCalledOnce());
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(false);
  await h.dispatcher.tryDispatchNextMessage('session');
  pending.resolve();
  await expect(steer).rejects.toThrow('steer refused');
  await vi.waitFor(() =>
    expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'selected')
  );
});

it('releases stale steering ownership on stop so a replacement turn can dispatch', async () => {
  const h = harness();
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  const selected = enqueue('selected');
  const pending = deferred();
  h.steerSessionMessage.mockImplementationOnce(async () => {
    await pending.promise;
    return { outcome: 'injected' };
  });
  const steer = h.dispatcher.steerQueuedMessage('session', selected.id);
  await vi.waitFor(() => expect(h.steerSessionMessage).toHaveBeenCalledOnce());
  h.stop();
  sessionDomainService.clearQueuedWork('session');
  enqueue('new-input');
  h.dispatcher.resetDispatchState('session');
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(false);
  await h.dispatcher.tryDispatchNextMessage('session');
  const dispatched = h.sendSessionMessage.mock.calls.length;
  pending.resolve();
  await steer;
  expect(dispatched).toBe(1);
  expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'new-input');
  expect(sessionDomainService.getTranscriptSnapshot('session').map(({ id }) => id)).toEqual([
    'new-input',
  ]);
});

it('reports a conflicting steer for another queued message instead of silently ignoring it', async () => {
  const h = harness();
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  const selected = enqueue('selected');
  const other = enqueue('other');
  const pending = deferred();
  h.steerSessionMessage.mockImplementationOnce(async () => {
    await pending.promise;
    return { outcome: 'injected' };
  });
  const steer = h.dispatcher.steerQueuedMessage('session', selected.id);
  await vi.waitFor(() => expect(h.steerSessionMessage).toHaveBeenCalledOnce());
  const conflicting = h.dispatcher.steerQueuedMessage('session', other.id);
  pending.resolve();
  await expect(conflicting).rejects.toThrow('Another queued message is being steered');
  await steer;
  expect(sessionDomainService.hasQueuedMessage('session', other.id)).toBe(true);
});

it('does not dispatch an earlier message when a stale steer selects a later queued message', async () => {
  const h = harness();
  const first = enqueue('first');
  const selected = enqueue('selected');
  await expect(h.dispatcher.steerQueuedMessage('session', selected.id)).rejects.toThrow(
    'No active turn to steer'
  );
  expect(h.sendSessionMessage).not.toHaveBeenCalled();
  expect(sessionDomainService.getQueueSnapshot('session')).toEqual([first, selected]);
});

it('retains timed-out steering without automatically restarting and resending it', async () => {
  const h = harness();
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  const selected = enqueue('selected');
  h.steerSessionMessage.mockImplementationOnce(() => {
    h.runtimeManager.isSessionPromptInFlight.mockReturnValue(false);
    return Promise.reject(new AcpSteeringTimeoutError());
  });
  await expect(h.dispatcher.steerQueuedMessage('session', selected.id)).rejects.toThrow(
    'timed out'
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(h.sendSessionMessage).not.toHaveBeenCalled();
  expect(sessionDomainService.getQueueSnapshot('session')).toEqual([selected]);
  // The claim is released so a later user-triggered delivery can proceed.
  await h.dispatcher.tryDispatchNextMessage('session');
  expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'selected');
});

it('a real busy retry timer rechecks the event fence before dequeue or startup', async () => {
  vi.useFakeTimers();
  let fenced = false;
  const h = harness('allowed', undefined, {
    assertOrdinary: () => (fenced ? Promise.reject(new Error('fenced')) : Promise.resolve()),
  });
  h.sendSessionMessage.mockRejectedValueOnce(
    new Error('A turn is already in progress for this session')
  );
  const message = enqueue('retry');
  await h.dispatcher.tryDispatchNextMessage('session');
  expect(h.sendSessionMessage).toHaveBeenCalledOnce();
  const dequeue = vi.spyOn(sessionDomainService, 'dequeueNext');
  fenced = true;
  h.startup.getSessionClient.mockReturnValue(undefined);
  await vi.advanceTimersByTimeAsync(1001);
  expect(dequeue).not.toHaveBeenCalled();
  expect(h.startup.getOrCreateSessionClient).not.toHaveBeenCalled();
  expect(h.sendSessionMessage).toHaveBeenCalledOnce();
  expect(sessionDomainService.peekNextMessage('session')).toBe(message);
});
