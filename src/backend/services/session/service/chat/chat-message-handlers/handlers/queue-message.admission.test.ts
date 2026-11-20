import { expect, it, vi } from 'vitest';
import { sessionEventBus } from '@/backend/services/session/service/event-bus/session-event-bus';
import { SessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import { deferred } from '@/test-utils/deferred';
import { createQueueMessageHandler } from './queue-message.handler';
import { createRemoveQueuedMessageHandler } from './remove-queued-message.handler';

it('serializes cancellation after slow admission without sending CANCELLED before ACCEPTED', async () => {
  const domain = new SessionDomainService();
  let resolve!: () => void;
  const persisted = new Promise<void>((done) => {
    resolve = done;
  });
  const emitDelta = vi.spyOn(domain, 'emitDelta');
  const handler = createQueueMessageHandler({
    domain,
    backgroundDelivery: {
      captureResumeGuard: () => () => true,
      userResume: vi.fn().mockResolvedValue(undefined),
    },
    humanMessageAccepted: () => persisted,
    tryDispatchNextMessage: vi.fn().mockResolvedValue(undefined),
  });
  try {
    const accepted = handler(
      { sessionId: 'session', workingDir: '/tmp' },
      { type: 'queue_message', id: 'human', text: 'continue' }
    );
    const cancelled = createRemoveQueuedMessageHandler({ domain })(
      { sessionId: 'session', workingDir: '/tmp' },
      { type: 'remove_queued_message', messageId: 'human' }
    );
    expect(domain.getQueueSnapshot('session')).toHaveLength(1);
    expect(emitDelta).not.toHaveBeenCalled();
    resolve();
    await accepted;
    await cancelled;
    expect(
      emitDelta.mock.calls.map(([, event]) =>
        event.type === 'message_state_changed' ? event.newState : event.type
      )
    ).toEqual(['ACCEPTED', 'CANCELLED']);
    expect(domain.getQueueSnapshot('session')).toEqual([]);
  } finally {
    resolve();
    domain.clearSession('session');
  }
});

it.each([false, true])(
  'does not acknowledge, reject, or cancel a replacement after the original admission settles (failed: %s)',
  async (failed) => {
    const domain = new SessionDomainService();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const persisted = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const emitDelta = vi.spyOn(domain, 'emitDelta');
    const rejectMessage = vi.spyOn(domain, 'rejectMessage');
    const handler = createQueueMessageHandler({
      domain,
      backgroundDelivery: {
        captureResumeGuard: () => () => true,
        userResume: vi.fn().mockResolvedValue(undefined),
      },
      humanMessageAccepted: () => persisted,
      tryDispatchNextMessage: vi.fn().mockResolvedValue(undefined),
    });
    try {
      const accepted = handler(
        { sessionId: 'session', workingDir: '/tmp' },
        { type: 'queue_message', id: 'human', text: 'original' }
      );
      const original = domain.getQueueSnapshot('session')[0];
      if (!original) {
        throw new Error('Expected queued original');
      }
      const cancelled = createRemoveQueuedMessageHandler({ domain })(
        { sessionId: 'session', workingDir: '/tmp' },
        { type: 'remove_queued_message', messageId: 'human' }
      );
      domain.removeQueuedMessage('session', 'human', { expectedMessage: original });
      const replacement = { ...original, text: 'replacement' };
      domain.enqueue('session', replacement);
      if (failed) {
        reject(new Error('DB unavailable'));
      } else {
        resolve();
      }
      await accepted;
      await cancelled;
      expect(domain.getQueueSnapshot('session')).toEqual([replacement]);
      expect(emitDelta).not.toHaveBeenCalled();
      expect(rejectMessage).not.toHaveBeenCalled();
    } finally {
      resolve();
      domain.clearSession('session');
    }
  }
);

it.each([false, true])(
  'holds human input from independent dispatch until persistence settles (reject: %s)',
  async (reject) => {
    const domain = new SessionDomainService();
    let resolve!: () => void;
    let fail!: (error: Error) => void;
    const persisted = new Promise<void>((done, failed) => {
      resolve = done;
      fail = failed;
    });

    const dispatch = vi.fn().mockResolvedValue(undefined);
    const handler = createQueueMessageHandler({
      domain,
      backgroundDelivery: {
        captureResumeGuard: () => () => true,
        userResume: vi.fn().mockResolvedValue(undefined),
      },
      humanMessageAccepted: () => persisted,
      tryDispatchNextMessage: dispatch,
    });
    try {
      const outcome = handler(
        { sessionId: 'session', workingDir: '/tmp' },
        { type: 'queue_message', id: 'human', text: 'continue' }
      );
      const queued = domain.getQueueSnapshot('session')[0];
      expect(queued?.id).toBe('human');
      if (!queued) {
        throw new Error('Expected queued input');
      }
      expect(domain.isMessageAdmissionPending(queued)).toBe(true);
      expect(domain.peekNextMessage('session')).toBeUndefined();
      expect(domain.dequeueNext('session')).toBeUndefined();
      expect(dispatch).not.toHaveBeenCalled();
      if (reject) {
        fail(new Error('DB unavailable'));
      } else {
        resolve();
      }
      await outcome;
      if (reject) {
        expect(domain.getQueueSnapshot('session')).toEqual([]);
        expect(
          domain.prepareLoad('session', domain.getRuntimeSnapshot('session')).replayEvents
        ).toContainEqual(expect.objectContaining({ newState: 'REJECTED' }));
        expect(dispatch).toHaveBeenCalledOnce();
      } else {
        expect(domain.peekNextMessage('session')).toBe(queued);
        expect(domain.dequeueNext('session')).toBe(queued);
        expect(dispatch).toHaveBeenCalledOnce();
      }
    } finally {
      resolve();
      domain.clearSession('session');
    }
  }
);

it('wakes accepted follow-up messages after an earlier admission fails', async () => {
  const domain = new SessionDomainService();
  let fail!: (error: Error) => void;
  const first = new Promise<void>((_resolve, reject) => {
    fail = reject;
  });
  const delivered: string[] = [];
  const handler = createQueueMessageHandler({
    domain,
    backgroundDelivery: {
      captureResumeGuard: () => () => true,
      userResume: vi.fn().mockResolvedValue(undefined),
    },
    humanMessageAccepted: vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined),
    tryDispatchNextMessage: () => {
      const message = domain.dequeueNext('session');
      if (message) {
        delivered.push(message.id);
      }
      return Promise.resolve();
    },
  });
  try {
    const failed = handler(
      { sessionId: 'session', workingDir: '/tmp' },
      { type: 'queue_message', id: 'first', text: 'first' }
    );
    await handler(
      { sessionId: 'session', workingDir: '/tmp' },
      { type: 'queue_message', id: 'second', text: 'second' }
    );
    expect(delivered).toEqual([]);
    fail(new Error('DB unavailable'));
    await failed;
    expect(delivered).toEqual(['second']);
    expect(domain.getQueueSnapshot('session')).toEqual([]);
  } finally {
    domain.clearSession('session');
  }
});

const context = { sessionId: 'session', workingDir: '/tmp' };
const submit = { type: 'queue_message', id: 'human', text: 'continue' } as const;

function admission(
  domain: SessionDomainService,
  persist: () => Promise<void> = async () => undefined
) {
  return createQueueMessageHandler({
    domain,
    humanMessageAccepted: persist,
    backgroundDelivery: {
      captureResumeGuard: () => () => true,
      userResume: async () => undefined,
    },
    tryDispatchNextMessage: async () => undefined,
  });
}

it('admits one human submission while persistence is pending and acknowledges subsequent retries', async () => {
  const domain = new SessionDomainService();
  const gate = deferred();
  const persist = vi.fn(() => gate.promise);
  const run = admission(domain, persist);
  const first = run(context, submit);
  const retry = run(context, submit);
  try {
    expect(domain.getQueueSnapshot('session').map(({ id }) => id)).toEqual(['human']);
  } finally {
    gate.resolve();
    const [, retried] = await Promise.all([first, retry]);
    expect(retried).toEqual({ replies: [] });
  }
  expect(persist).toHaveBeenCalledOnce();
  expect((await run(context, submit)).replies).toMatchObject([
    { type: 'message_state_changed', id: 'human', newState: 'ACCEPTED', queuePosition: 0 },
  ]);
  const message = domain.dequeueNext('session')!;
  domain.commitSentUserMessage('session', message);
  expect((await run(context, submit)).replies).toMatchObject([
    {
      type: 'session_delta',
      data: {
        type: 'transcript_message_committed',
        chatMessage: { id: 'human', order: 0 },
        queuedMessages: [],
      },
    },
  ]);
  expect(domain.getQueueSnapshot('session')).toEqual([]);
  expect(persist).toHaveBeenCalledOnce();
});

it('preserves submission options through history refresh and reports unverified history IDs to the requester', async () => {
  const domain = new SessionDomainService();
  const run = admission(domain);
  const sent = { ...submit, voiceMode: true };
  await run(context, sent);
  domain.commitSentUserMessage('session', domain.dequeueNext('session')!);
  const history = structuredClone(domain.getTranscriptSnapshot('session'));
  domain.replaceTranscript('session', history);
  expect((await run(context, sent)).replies).toMatchObject([
    { data: { type: 'transcript_message_committed' } },
  ]);
  expect((await run(context, submit)).replies).toMatchObject([{ type: 'error' }]);

  // A newly hydrated store knows the provider row, but cannot authenticate its client options.
  const restored = new SessionDomainService();
  restored.replaceTranscript('session', history);
  expect((await admission(restored)(context, submit)).replies).toMatchObject([{ type: 'error' }]);
  expect(restored.getQueueSnapshot('session')).toEqual([]);
  expect(restored.getTranscriptSnapshot('session')).toEqual(history);
});

it('keeps a matching reserved workspace notification private to its delivery subsystem', async () => {
  const domain = new SessionDomainService();
  const id = 'workspace-notification-real';
  domain.enqueue('session', {
    id,
    text: submit.text,
    timestamp: '2026-11-20T14:24:00Z',
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  });
  const frames = vi.spyOn(sessionEventBus, 'publishToSession');
  try {
    expect((await admission(domain)(context, { ...submit, id })).replies).toMatchObject([
      { type: 'error', error: { kind: 'queue_input_invalid' } },
    ]);
    expect(frames).not.toHaveBeenCalled();
    expect(domain.hasQueuedMessage('session', id)).toBe(true);
  } finally {
    frames.mockRestore();
  }
});

it.each(['different', ''])(
  'reports an ID conflict only to its requester and preserves the original submission (%j)',
  async (text) => {
    const domain = new SessionDomainService();
    const run = admission(domain);
    await run(context, submit);
    const frames = vi.spyOn(sessionEventBus, 'publishToSession');
    try {
      expect((await run(context, { ...submit, text })).replies).toMatchObject([
        { type: 'error', error: { kind: 'queue_input_invalid' } },
      ]);
      expect(frames).not.toHaveBeenCalled();
      expect(domain.getQueueSnapshot('session').map(({ text }) => text)).toEqual(['continue']);
    } finally {
      frames.mockRestore();
    }
  }
);

it('removes failed admission with a recoverable rejection on the live channel and replay', async () => {
  const domain = new SessionDomainService();
  const gate = deferred();
  const attachment = {
    id: 'file',
    name: 'notes.txt',
    type: 'text/plain',
    contentType: 'text' as const,
    size: 3,
    data: 'abc',
  };
  const run = admission(
    domain,
    vi.fn(async () => {
      await gate.promise;
      throw new Error('persistence unavailable');
    })
  );
  const outcome = run(context, { ...submit, attachments: [attachment] });
  const frames = vi.spyOn(sessionEventBus, 'publishToSession');
  try {
    gate.resolve();
    await outcome;
    const rejection = {
      type: 'message_state_changed',
      id: 'human',
      newState: 'REJECTED',
      userMessage: { text: 'continue', sessionId: 'session', attachments: [attachment] },
    };
    expect(frames.mock.calls.map(([, frame]) => frame)).toMatchObject([
      { type: 'session_delta', data: rejection },
    ]);
    expect(domain.getQueueSnapshot('session')).toEqual([]);
    expect(
      domain.prepareLoad('session', domain.getRuntimeSnapshot('session')).replayEvents
    ).toContainEqual(
      expect.objectContaining({
        ...rejection,
        userMessage: expect.objectContaining(rejection.userMessage),
      })
    );
  } finally {
    frames.mockRestore();
  }
});
