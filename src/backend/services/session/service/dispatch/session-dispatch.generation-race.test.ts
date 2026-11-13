import { afterEach, expect, it, vi } from 'vitest';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import { SessionLifecycleGate } from '@/backend/services/session/service/lifecycle/session-lifecycle-gate';
import { sessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import type { AgentContentItem, QueuedMessage } from '@/shared/acp-protocol';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionDispatchService } from './session-dispatch.service';

const SESSION_ID = 'session';

function enqueue(id: string): QueuedMessage {
  const message: QueuedMessage = {
    id,
    text: id,
    timestamp: '2026-11-09T00:00:00Z',
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  };
  sessionDomainService.enqueue(SESSION_ID, message);
  return message;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A real lifecycle gate shared by dispatch and an unrelated startup caller. */
function raceHarness() {
  const gate = new SessionLifecycleGate({ isRuntimeStopInProgress: () => false });
  const sendSessionMessage = vi
    .fn<(sessionId: string, content: string | AgentContentItem[]) => Promise<void>>()
    .mockResolvedValue(undefined);
  const dispatcher = new SessionDispatchService({
    runtimeManager: { isSessionPromptInFlight: () => false, isSessionRunning: () => true },
    configService: {
      resolveQueuedMessageSettings: (_id, message) => message.settings,
      configureQueuedMessage: (_id, message) => Promise.resolve(message.settings),
    },
    promptService: {
      sendSessionMessage,
      steerSessionMessage: vi.fn().mockResolvedValue({ outcome: 'injected' }),
    },
    backgroundDelivery: {
      prepare: vi.fn(),
      validate: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(undefined),
    },
  });
  dispatcher.configure({
    initPolicy: { getWorkspaceInitPolicy: () => ({ dispatchPolicy: 'allowed' }) },
  });
  // No runtime yet: dispatch auto-starts one through a real startup lease, as
  // the startup coordinator does, so only an established runtime is reused.
  const client = unsafeCoerce<AcpProcessHandle>({});
  let established = false;
  dispatcher.configureLifecycle({
    gate,
    startup: {
      getSessionClient: () => (established ? client : undefined),
      getOrCreateSessionClient: (id) =>
        gate.runStartup(id, (lease) => {
          gate.establishStartup(lease);
          established = true;
          return Promise.resolve(client);
        }),
    },
    notificationDelivery: {
      configureRetry: () => undefined,
      recoverSession: async () => undefined,
      captureMailSignalReceipt: () => null,
      isMailSignalQuarantined: () => false,
      isOwnedMailSignal: () => false,
      claimForDispatch: () => ({ status: 'not_notification' }),
      isAlreadyDelivered: async () => false,
      acknowledgeSuccessfulDispatch: async () => undefined,
      recoverPending: async () => ({ dispatchableCount: 0 }),
      resetSession: () => undefined,
      removeDuplicateFromQueue: () => false,
      isNotificationMessage: () => false,
    },
  });
  // Hold the dispatch gate's session lookup so another caller can interleave.
  const lookup = deferred<unknown>();
  vi.spyOn(sessionDataService, 'findAgentSessionById').mockReturnValueOnce(
    unsafeCoerce(lookup.promise)
  );
  const releaseLookup = () =>
    lookup.resolve({ workspace: { status: 'READY', worktreePath: '/tmp/workspace' } });
  return { gate, dispatcher, sendSessionMessage, releaseLookup };
}

afterEach(() => {
  sessionDomainService.clearAllSessions();
  vi.restoreAllMocks();
});

// Race: dispatch captures the lifecycle generation, and an unrelated startup
// lease that ends without establishing a runtime (for example
// ensureSubagentBrowseSession returning false for a non-Codex session) deletes
// that generation. Dispatch must not read that as a stop: it would return with
// the message still queued and schedule no retry.
it.each([
  ['returns without establishing', () => Promise.resolve(false)],
  ['fails before establishing', () => Promise.reject(new Error('spawn failed'))],
] as const)(
  'dispatches a queued message when an unrelated startup lease %s mid-dispatch',
  async (_label, startup) => {
    const { gate, dispatcher, sendSessionMessage, releaseLookup } = raceHarness();
    enqueue('hello');

    const dispatch = dispatcher.tryDispatchNextMessage(SESSION_ID);
    await vi.waitFor(() => expect(sessionDataService.findAgentSessionById).toHaveBeenCalled());
    await gate.runStartup(SESSION_ID, startup).catch(() => undefined);
    releaseLookup();
    await dispatch;

    await vi.waitFor(() => expect(sendSessionMessage).toHaveBeenCalledWith(SESSION_ID, 'hello'));
    expect(sessionDomainService.getQueueLength(SESSION_ID)).toBe(0);
  }
);

it('still fences a dispatch that a stop overtakes mid-dispatch', async () => {
  const { gate, dispatcher, sendSessionMessage, releaseLookup } = raceHarness();
  enqueue('hello');

  const dispatch = dispatcher.tryDispatchNextMessage(SESSION_ID);
  await vi.waitFor(() => expect(sessionDataService.findAgentSessionById).toHaveBeenCalled());
  gate.reserveStop(SESSION_ID)?.release();
  releaseLookup();
  await dispatch;

  expect(sendSessionMessage).not.toHaveBeenCalled();
  expect(sessionDomainService.peekNextMessage(SESSION_ID)?.id).toBe('hello');
});
