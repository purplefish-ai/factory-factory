import { expect, it, vi } from 'vitest';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { createQueueMessageHandler } from './queue-message.handler';

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
