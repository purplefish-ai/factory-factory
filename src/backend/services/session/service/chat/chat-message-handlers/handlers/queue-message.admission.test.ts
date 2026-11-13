import { expect, it, vi } from 'vitest';
import { SessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
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
    const rejectMessage = vi.spyOn(domain, 'rejectMessage');
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
        expect(rejectMessage).toHaveBeenCalled();
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
