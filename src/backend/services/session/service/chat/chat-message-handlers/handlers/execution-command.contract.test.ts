import { expect, it, vi } from 'vitest';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import {
  SESSION_OUTBOUND_EVENT,
  sessionEventBus,
} from '@/backend/services/session/service/session-event-bus';
import { MessageState } from '@/shared/acp-protocol';
import { createQueueMessageHandler } from './queue-message.handler';
import { createRemoveQueuedMessageHandler } from './remove-queued-message.handler';
import { createResumeQueuedMessagesHandler } from './resume-queued-messages.handler';
import { createStartHandler } from './start.handler';
import { createStopHandler } from './stop.handler';
import { createUserInputHandler } from './user-input.handler';

vi.mock('@/backend/services/session/service/lifecycle/session-core-services', () => {
  throw new Error('Execution commands must use injected lifecycle capabilities');
});
vi.mock('@/backend/services/session/service/lifecycle/session-background-delivery.service', () => {
  throw new Error('Execution commands must use injected background delivery capabilities');
});

const context = { sessionId: 'plain-session', workingDir: '/tmp/work' };

function pending() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('acknowledges queued input on the session channel before dispatch without waiting for resume', async () => {
  const resume = pending();
  const calls: string[] = [];
  const guard = () => true;
  const domain = {
    enqueue: vi.fn(() => {
      calls.push('enqueue');
      return { position: 2 };
    }),
    rejectMessage: vi.fn(),
    emitDelta: vi.fn(() => {
      calls.push('accepted');
    }),
  };
  const handler = createQueueMessageHandler({
    domain,
    backgroundDelivery: {
      captureResumeGuard: () => guard,
      userResume: vi.fn(() => {
        calls.push('resume');
        return resume.promise;
      }),
    },
    tryDispatchNextMessage: vi.fn(() => {
      calls.push('dispatch');
      return Promise.resolve();
    }),
  });
  try {
    await expect(
      handler(context, { type: 'queue_message', id: 'human', text: ' continue ' })
    ).resolves.toEqual({ replies: [] });
    expect(calls).toEqual(['enqueue', 'accepted', 'resume', 'dispatch']);
    expect(domain.emitDelta).toHaveBeenCalledWith(
      'plain-session',
      expect.objectContaining({
        id: 'human',
        queuePosition: 2,
        userMessage: expect.objectContaining({ text: 'continue' }),
      })
    );
  } finally {
    resume.resolve();
  }
});

it('completes direct input while both provider turn and background resume are pending', async () => {
  const turn = pending();
  const resume = pending();
  const calls: string[] = [];
  const guard = () => true;
  const sendSessionMessage = vi.fn(() => {
    calls.push('send');
    return turn.promise;
  });
  const userResume = vi.fn(() => {
    calls.push('resume');
    return resume.promise;
  });
  const handler = createUserInputHandler({
    acpRuntimeManager: { isSessionRunning: () => true },
    sessionService: { sendSessionMessage },
    backgroundDelivery: { captureResumeGuard: () => guard, userResume },
  });
  try {
    let completed = false;
    const result = Promise.resolve(handler(context, { type: 'user_input', text: 'human' }));
    void result.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(true);
    expect(await result).toEqual({ replies: [] });
    expect(calls).toEqual(['send', 'resume']);
    expect(sendSessionMessage).toHaveBeenCalledWith('plain-session', 'human');
    expect(userResume).toHaveBeenCalledWith('plain-session', guard);
  } finally {
    turn.resolve();
    resume.resolve();
  }
});

it('keeps stop, pending cleanup, dispatcher reset and retry in their original order', async () => {
  const stop = pending();
  const calls: string[] = [];
  const stopSession = vi.fn(() => {
    calls.push('stop');
    return stop.promise;
  });
  const handler = createStopHandler({
    lifecycle: { stopSession },
    clearPendingRequest: vi.fn(() => {
      calls.push('pending');
    }),
    resetDispatchState: vi.fn(() => {
      calls.push('reset');
    }),
    tryDispatchNextMessage: vi.fn(() => {
      calls.push('dispatch');
      return Promise.resolve();
    }),
  });
  const result = handler(context, { type: 'stop' });
  expect(calls).toEqual(['stop']);
  stop.resolve();
  await expect(result).resolves.toEqual({ replies: [] });
  expect(calls).toEqual(['stop', 'pending', 'reset', 'dispatch']);
  expect(stopSession).toHaveBeenCalledWith('plain-session', { reason: 'USER_STOP' });
});

it('does not enable manual dispatch when a stop supersedes pending resume', async () => {
  const resume = pending();
  let current = true;
  const dispatch = vi.fn();
  const manual = vi.fn();
  const handler = createResumeQueuedMessagesHandler({
    backgroundDelivery: {
      captureResumeGuard: () => () => current,
      userResume: () => resume.promise,
    },
    setManualDispatchResume: manual,
    tryDispatchNextMessage: dispatch,
  });
  const result = handler(context, { type: 'resume_queued_messages' });
  current = false;
  resume.resolve();
  await expect(result).resolves.toEqual({ replies: [] });
  expect(manual).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});

it('returns startup failure as a typed requester error after marking domain state', async () => {
  const cause = new Error('provider unavailable');
  const markError = vi.fn();
  const userResume = vi.fn();
  const handler = createStartHandler({
    lifecycle: { getSessionOptions: vi.fn().mockResolvedValue({ workspaceStatus: 'READY' }) },
    domain: { markError },
    backgroundDelivery: { captureResumeGuard: () => () => true, userResume },
    startupService: {
      getSessionClient: vi.fn(),
      getOrCreateSessionClient: vi.fn().mockRejectedValue(cause),
    },
  });
  await expect(handler(context, { type: 'start' })).resolves.toEqual({
    replies: [{ type: 'error', error: { kind: 'start_failed', cause } }],
  });
  expect(markError).toHaveBeenCalledWith(
    'plain-session',
    'Failed to start agent: provider unavailable'
  );
  expect(userResume).not.toHaveBeenCalled();
});

it('returns cancellation feedback without giving the command a socket', () => {
  const domain = { removeQueuedMessage: vi.fn(() => false), emitDelta: vi.fn() };
  const handler = createRemoveQueuedMessageHandler({ domain });
  expect(handler(context, { type: 'remove_queued_message', messageId: 'pr-event-held' })).toEqual({
    replies: [{ type: 'error', error: { kind: 'background_monitoring_required' } }],
  });
  expect(handler(context, { type: 'remove_queued_message', messageId: 'missing' })).toEqual({
    replies: [{ type: 'error', error: { kind: 'message_not_queued' } }],
  });
  expect(domain.removeQueuedMessage).toHaveBeenCalledTimes(1);
});

it('publishes accepted, rejected and cancelled queue state through the real session channel', async () => {
  const domain = new SessionDomainService();
  const first = vi.fn();
  const second = vi.fn();
  sessionEventBus.on(SESSION_OUTBOUND_EVENT, first);
  sessionEventBus.on(SESSION_OUTBOUND_EVENT, second);
  try {
    const queue = createQueueMessageHandler({
      domain,
      backgroundDelivery: {
        captureResumeGuard: () => () => true,
        userResume: vi.fn().mockResolvedValue(undefined),
      },
      tryDispatchNextMessage: vi.fn().mockResolvedValue(undefined),
    });
    expect(await queue(context, { type: 'queue_message', id: 'accepted', text: 'human' })).toEqual({
      replies: [],
    });
    expect(await queue(context, { type: 'queue_message', id: 'rejected', text: ' ' })).toEqual({
      replies: [],
    });
    expect(
      createRemoveQueuedMessageHandler({ domain })(context, {
        type: 'remove_queued_message',
        messageId: 'accepted',
      })
    ).toEqual({ replies: [] });
    for (const viewer of [first, second]) {
      expect(viewer).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'plain-session',
          payload: {
            type: 'session_delta',
            data: expect.objectContaining({
              type: 'message_state_changed',
              id: 'accepted',
              newState: MessageState.ACCEPTED,
            }),
          },
        })
      );
      expect(viewer).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'plain-session',
          payload: {
            type: 'session_delta',
            data: expect.objectContaining({
              type: 'message_state_changed',
              id: 'rejected',
              newState: MessageState.REJECTED,
              errorMessage: 'Empty message',
            }),
          },
        })
      );
      expect(viewer).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'plain-session',
          payload: {
            type: 'session_delta',
            data: expect.objectContaining({
              type: 'message_state_changed',
              id: 'accepted',
              newState: MessageState.CANCELLED,
            }),
          },
        })
      );
    }
    expect(first.mock.calls).toEqual(second.mock.calls);
  } finally {
    sessionEventBus.off(SESSION_OUTBOUND_EVENT, first);
    sessionEventBus.off(SESSION_OUTBOUND_EVENT, second);
  }
});
