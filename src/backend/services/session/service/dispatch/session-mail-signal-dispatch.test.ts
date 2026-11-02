import { afterEach, expect, it, vi } from 'vitest';
import {
  AcpSteeringNotSentError,
  AcpSteeringTimeoutError,
} from '@/backend/services/session/service/acp/acp-steering';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import { SessionNotificationDeliveryService } from '@/backend/services/session/service/lifecycle/session-notification-delivery.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { AgentContentItem, QueuedMessage } from '@/shared/acp-protocol';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionDispatchService } from './session-dispatch.service';

function harness(
  policy: 'allowed' | 'manual_resume' = 'allowed',
  notifications?: SessionNotificationDeliveryService,
  eventAuthority?: { assertOrdinary(id: string): Promise<void> }
) {
  let generation = 0;
  const sendSessionMessage = vi
    .fn<(sessionId: string, content: string | AgentContentItem[]) => Promise<void>>()
    .mockResolvedValue(undefined);
  const steerSessionMessage = vi
    .fn<
      (
        id: string,
        content: string | AgentContentItem[],
        options?: { preserveRuntimeOnTimeout?: boolean; onLateInjected?: () => Promise<void> }
      ) => Promise<{ outcome: 'injected' | 'promptRequired' }>
    >()
    .mockResolvedValue({ outcome: 'injected' });
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

function mailHarness(policy: 'allowed' | 'manual_resume' = 'allowed') {
  const wake = { workspaceId: 'workspace', revision: 3, claimId: 'claim-mail' };
  const notificationPort = {
    listPendingForDelivery: vi.fn(async () => []),
    findForDelivery: vi.fn(async () => null),
    markDelivered: vi.fn(async () => undefined),
    claimWake: vi
      .fn<() => Promise<typeof wake | null>>()
      .mockResolvedValueOnce(wake)
      .mockResolvedValue(null),
    settleWake: vi.fn(async () => true),
    quarantineWake: vi.fn(async () => true),
    disarmWake: vi.fn(async () => true),
    releaseWake: vi.fn(async () => undefined),
  };
  const notifications = new SessionNotificationDeliveryService({
    notificationPort,
    queuePort: sessionDomainService,
    transcriptPort: sessionDomainService,
    deltaPort: sessionDomainService,
  });
  const h = harness(policy, notifications);
  return { ...h, notifications, notificationPort, wake };
}

it('steers only the owned body-free mail signal and settles its receipt separately from mail ACK', async () => {
  const h = mailHarness();
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  await h.notifications.recoverPending({
    sessionId: 'session',
    workspaceId: 'workspace',
    assertAllowed: () => undefined,
  });
  const signal = sessionDomainService.peekNextMessage('session')!;
  await h.dispatcher.steerWorkspaceMailSignal('session', signal.id);
  expect(h.steerSessionMessage).toHaveBeenCalledExactlyOnceWith(
    'session',
    signal.text,
    expect.objectContaining({
      preserveRuntimeOnTimeout: true,
    })
  );
  expect(h.notificationPort.settleWake).toHaveBeenCalledExactlyOnceWith(h.wake);
  expect(h.notificationPort.markDelivered).not.toHaveBeenCalled();
  expect(sessionDomainService.getQueueLength('session')).toBe(0);
  expect(h.sendSessionMessage).not.toHaveBeenCalled();
});

it('keeps unsupported native mail steering queued and dispatches it at turn completion', async () => {
  const h = mailHarness();
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  h.steerSessionMessage.mockRejectedValue(new AcpSteeringNotSentError('adapter unsupported'));
  await h.notifications.recoverPending({
    sessionId: 'session',
    workspaceId: 'workspace',
    assertAllowed: () => undefined,
  });
  const signal = sessionDomainService.peekNextMessage('session')!;
  await expect(h.dispatcher.steerWorkspaceMailSignal('session', signal.id)).rejects.toThrow(
    'adapter unsupported'
  );
  expect(sessionDomainService.getQueueSnapshot('session')).toEqual([signal]);
  expect(h.notificationPort.settleWake).not.toHaveBeenCalled();
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(false);
  await h.dispatcher.tryDispatchNextMessage('session');
  await vi.waitFor(() => expect(h.sendSessionMessage).toHaveBeenCalledOnce());
  expect(h.notificationPort.settleWake).toHaveBeenCalledWith(h.wake);
});

it('refuses ordinary steer requests for system mail and refuses modified owned signals', async () => {
  const h = mailHarness();
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  await h.notifications.recoverPending({
    sessionId: 'session',
    workspaceId: 'workspace',
    assertAllowed: () => undefined,
  });
  const signal = sessionDomainService.peekNextMessage('session')!;
  await expect(h.dispatcher.steerQueuedMessage('session', signal.id)).rejects.toThrow(
    'Only ordinary queued human messages'
  );
  signal.text = 'arbitrary instructions pretending to be a mail signal';
  await h.dispatcher.steerWorkspaceMailSignal('session', signal.id);
  expect(h.steerSessionMessage).not.toHaveBeenCalled();
});

it('preserves manual-resume ownership policy when steering a mail signal', async () => {
  const h = mailHarness('manual_resume');
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  await h.notifications.recoverPending({
    sessionId: 'session',
    workspaceId: 'workspace',
    assertAllowed: () => undefined,
  });
  const signal = sessionDomainService.peekNextMessage('session')!;
  await expect(h.dispatcher.steerWorkspaceMailSignal('session', signal.id)).rejects.toThrow(
    'not ready for steering'
  );
  expect(h.steerSessionMessage).not.toHaveBeenCalled();
  expect(sessionDomainService.getQueueLength('session')).toBe(1);
});

it('retries a failed queued mail signal through bounded dispatch backoff without restarting', async () => {
  vi.useFakeTimers();
  const h = mailHarness();
  await h.notifications.recoverPending({
    sessionId: 'session',
    workspaceId: 'workspace',
    assertAllowed: () => undefined,
  });
  h.sendSessionMessage.mockRejectedValueOnce(new Error('temporary provider failure'));
  await h.dispatcher.tryDispatchNextMessage('session');
  expect(sessionDomainService.getQueueLength('session')).toBe(1);
  expect(h.notificationPort.settleWake).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.sendSessionMessage).toHaveBeenCalledTimes(2);
  expect(h.notificationPort.settleWake).toHaveBeenCalledWith(h.wake);
  h.dispatcher.resetDispatchState('session');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('hands an idle native-steer fallback to ordinary dispatch without dropping its owned wake', async () => {
  const h = mailHarness();
  await h.notifications.recoverPending({
    sessionId: 'session',
    workspaceId: 'workspace',
    assertAllowed: () => undefined,
  });
  const signal = sessionDomainService.peekNextMessage('session')!;
  await h.dispatcher.steerWorkspaceMailSignal('session', signal.id);
  expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', signal.text);
  expect(h.notificationPort.settleWake).toHaveBeenCalledWith(h.wake);
});

it('replays turn-completion recovery after the queued wake receipt and dispatch claim settle', async () => {
  const h = mailHarness();
  const sending = deferred<void>();
  const settlement = deferred<boolean>();
  const nextWake = { ...h.wake, revision: 4, claimId: 'claim-new' };
  h.notificationPort.claimWake
    .mockReset()
    .mockResolvedValueOnce(h.wake)
    .mockResolvedValueOnce(nextWake)
    .mockResolvedValue(null);
  h.sendSessionMessage.mockReturnValueOnce(sending.promise);
  h.notificationPort.settleWake.mockReturnValueOnce(settlement.promise);
  await h.notifications.recoverPending({
    sessionId: 'session',
    workspaceId: 'workspace',
    assertAllowed: () => undefined,
  });
  const dispatch = h.dispatcher.tryDispatchNextMessage('session');
  await vi.waitFor(() => expect(h.sendSessionMessage).toHaveBeenCalledOnce());
  expect(
    await h.notifications.recoverPending({
      sessionId: 'session',
      workspaceId: 'workspace',
      assertAllowed: () => undefined,
    })
  ).toEqual({ dispatchableCount: 0 });
  sending.resolve(undefined);
  await vi.waitFor(() => expect(h.notificationPort.settleWake).toHaveBeenCalledOnce());
  await h.dispatcher.tryDispatchNextMessage('session');
  settlement.resolve(true);
  await dispatch;
  await vi.waitFor(() => expect(h.sendSessionMessage).toHaveBeenCalledTimes(2));
  expect(h.sendSessionMessage.mock.calls[1]?.[1]).toContain('revision 4');
});

it('quarantines ambiguous native mail acceptance from later arrivals and automatic turn-completion replay', async () => {
  const h = mailHarness();
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  h.steerSessionMessage.mockRejectedValueOnce(new AcpSteeringTimeoutError());
  await h.notifications.recoverPending({
    sessionId: 'session',
    workspaceId: 'workspace',
    assertAllowed: () => undefined,
  });
  const signal = sessionDomainService.peekNextMessage('session')!;
  await expect(h.dispatcher.steerWorkspaceMailSignal('session', signal.id)).rejects.toBeInstanceOf(
    AcpSteeringTimeoutError
  );
  await h.dispatcher.steerWorkspaceMailSignal('session', signal.id);
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(false);
  await h.dispatcher.tryDispatchNextMessage('session');
  expect(h.steerSessionMessage).toHaveBeenCalledOnce();
  expect(h.sendSessionMessage).not.toHaveBeenCalled();
  expect(h.notificationPort.settleWake).not.toHaveBeenCalled();
  expect(sessionDomainService.getQueueSnapshot('session')).toEqual([]);
  expect(h.notifications.isMailSignalQuarantined(signal.id)).toBe(true);
});

it('reconciles a late injected receipt without replaying the quarantined signal', async () => {
  const h = mailHarness();
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  h.steerSessionMessage.mockRejectedValueOnce(new AcpSteeringTimeoutError());
  await h.notifications.recoverPending({
    sessionId: 'session',
    workspaceId: 'workspace',
    assertAllowed: () => undefined,
  });
  const signal = sessionDomainService.peekNextMessage('session')!;
  await expect(h.dispatcher.steerWorkspaceMailSignal('session', signal.id)).rejects.toBeInstanceOf(
    AcpSteeringTimeoutError
  );
  await h.steerSessionMessage.mock.calls[0]?.[2]?.onLateInjected?.();
  expect(h.notificationPort.settleWake).toHaveBeenCalledExactlyOnceWith(h.wake);
  expect(h.notifications.isMailSignalQuarantined(signal.id)).toBe(false);
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(false);
  await h.dispatcher.tryDispatchNextMessage('session');
  expect(h.sendSessionMessage).not.toHaveBeenCalled();
  expect(sessionDomainService.getTranscriptSnapshot('session')).toContainEqual(
    expect.objectContaining({ id: signal.id, source: 'user' })
  );
});

it('keeps unrelated queued work available while ambiguous mail waits for explicit retry', async () => {
  const h = mailHarness();
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  h.steerSessionMessage.mockRejectedValueOnce(new AcpSteeringTimeoutError());
  await h.notifications.recoverPending({
    sessionId: 'session',
    workspaceId: 'workspace',
    assertAllowed: () => undefined,
  });
  const signal = sessionDomainService.peekNextMessage('session')!;
  await expect(h.dispatcher.steerWorkspaceMailSignal('session', signal.id)).rejects.toBeInstanceOf(
    AcpSteeringTimeoutError
  );
  sessionDomainService.enqueue('session', { ...signal, id: 'ordinary', text: 'Human task' });
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(false);
  await h.dispatcher.tryDispatchNextMessage('session');
  expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith('session', 'Human task');
  expect(h.notifications.isMailSignalQuarantined(signal.id)).toBe(true);
});

it('never lets a late native receipt consume the replacement wake after explicit retry', async () => {
  const h = mailHarness();
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  h.steerSessionMessage.mockRejectedValueOnce(new AcpSteeringTimeoutError());
  await h.notifications.recoverPending({
    sessionId: 'session',
    workspaceId: 'workspace',
    assertAllowed: () => undefined,
  });
  const original = sessionDomainService.peekNextMessage('session')!;
  await expect(
    h.dispatcher.steerWorkspaceMailSignal('session', original.id)
  ).rejects.toBeInstanceOf(AcpSteeringTimeoutError);
  // The explicit retry endpoint retired the durable ambiguous claim; recovery owns a new token.
  h.notificationPort.claimWake.mockResolvedValueOnce({ ...h.wake, claimId: 'explicit-retry' });
  await h.notifications.recoverPending({
    sessionId: 'session',
    workspaceId: 'workspace',
    assertAllowed: () => undefined,
    preferSession: true,
  });
  const replacement = sessionDomainService.peekNextMessage('session')!;
  h.notificationPort.settleWake.mockResolvedValueOnce(false);
  await h.steerSessionMessage.mock.calls[0]?.[2]?.onLateInjected?.();
  expect(sessionDomainService.getQueueSnapshot('session')).toEqual([replacement]);
  expect(sessionDomainService.getTranscriptSnapshot('session')).not.toContainEqual(
    expect.objectContaining({ id: original.id })
  );
});

it('recovers newer eligible mail after the late native receipt clears its prior quarantine', async () => {
  const h = mailHarness();
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  h.steerSessionMessage.mockRejectedValueOnce(new AcpSteeringTimeoutError());
  await h.notifications.recoverPending({
    sessionId: 'session',
    workspaceId: 'workspace',
    assertAllowed: () => undefined,
  });
  const signal = sessionDomainService.peekNextMessage('session')!;
  await expect(h.dispatcher.steerWorkspaceMailSignal('session', signal.id)).rejects.toBeInstanceOf(
    AcpSteeringTimeoutError
  );
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(false);
  await h.dispatcher.tryDispatchNextMessage('session');
  h.notificationPort.claimWake.mockResolvedValueOnce({
    ...h.wake,
    revision: 4,
    claimId: 'new-mail',
  });
  await h.steerSessionMessage.mock.calls[0]?.[2]?.onLateInjected?.();
  await vi.waitFor(() => expect(h.sendSessionMessage).toHaveBeenCalledOnce());
  expect(h.sendSessionMessage.mock.calls[0]?.[1]).toContain('revision 4');
});

it('never attempts native steering when the durable attempt fence cannot be persisted', async () => {
  const h = mailHarness();
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  h.notificationPort.quarantineWake.mockRejectedValueOnce(new Error('database unavailable'));
  await h.notifications.recoverPending({
    sessionId: 'session',
    workspaceId: 'workspace',
    assertAllowed: () => undefined,
  });
  const signal = sessionDomainService.peekNextMessage('session')!;
  await expect(h.dispatcher.steerWorkspaceMailSignal('session', signal.id)).rejects.toThrow(
    'database unavailable'
  );
  expect(h.steerSessionMessage).not.toHaveBeenCalled();
  expect(h.sendSessionMessage).not.toHaveBeenCalled();
});

it('rechecks stop ownership after durable native arming and disarms proven unsent input', async () => {
  const h = mailHarness();
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  h.notificationPort.quarantineWake.mockImplementationOnce(() => {
    h.stop();
    return Promise.resolve(true);
  });
  await h.notifications.recoverPending({
    sessionId: 'session',
    workspaceId: 'workspace',
    assertAllowed: () => undefined,
  });
  const signal = sessionDomainService.peekNextMessage('session')!;
  await expect(h.dispatcher.steerWorkspaceMailSignal('session', signal.id)).rejects.toThrow(
    'Session stopped before steering'
  );
  expect(h.notificationPort.disarmWake).toHaveBeenCalledExactlyOnceWith(h.wake);
  expect(h.steerSessionMessage).not.toHaveBeenCalled();
});
