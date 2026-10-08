import { expect, it } from 'vitest';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { SessionBackgroundDeliveryService } from './session-background-delivery.service';

const request = { workspaceId: 'w', prId: 'p', bindingRevision: 1 };
const settings = {
  selectedModel: null,
  reasoningEffort: null,
  thinkingEnabled: false,
  planModeEnabled: false,
};
it('coalesces background queue tokens and keeps human FIFO order ahead of updates', () => {
  const service = new SessionBackgroundDeliveryService();
  service.enqueue('background-test', request);
  service.enqueue('background-test', request);
  sessionDomainService.enqueue('background-test', {
    id: 'human-1',
    text: 'one',
    timestamp: '',
    settings,
  });
  sessionDomainService.enqueue('background-test', {
    id: 'human-2',
    text: 'two',
    timestamp: '',
    settings,
  });
  expect(sessionDomainService.getQueueLength('background-test')).toBe(3);
  expect(sessionDomainService.dequeueNext('background-test')?.id).toBe('human-1');
  expect(sessionDomainService.dequeueNext('background-test')?.id).toBe('human-2');
  expect(sessionDomainService.dequeueNext('background-test')?.source).toEqual({
    type: 'pr_event',
    request,
  });
});
it('invalidates only unstarted tokens for the captured binding', () => {
  const service = new SessionBackgroundDeliveryService();
  service.enqueue('invalidate-test', request);
  sessionDomainService.enqueue('invalidate-test', {
    id: 'human',
    text: 'continue',
    timestamp: '',
    settings,
  });
  service.invalidate('w', 1);
  expect(sessionDomainService.getQueueLength('invalidate-test')).toBe(1);
  expect(sessionDomainService.peekNextMessage('invalidate-test')?.id).toBe('human');
});
it('can enqueue again after discarding an obsolete background token', async () => {
  const service = new SessionBackgroundDeliveryService();
  service.enqueue('discard-test', request);
  const queued = sessionDomainService.peekNextMessage('discard-test')!;
  await service.prepare('discard-test', queued);
  sessionDomainService.removeQueuedMessage('discard-test', queued.id);
  service.enqueue('discard-test', request);
  expect(sessionDomainService.getQueueLength('discard-test')).toBe(1);
});

it('keeps a frozen retry coalesced until its queue item is removed', async () => {
  const service = new SessionBackgroundDeliveryService();
  const delivery = {
    deliveryId: 'frozen',
    sessionId: 'retry-test',
    bindingRevision: 1,
    eventIds: ['e'],
    text: 'frozen facts',
    attempt: 1,
  };
  service.configure({
    prepare: async () => ({ status: 'ready', delivery }),
    validate: async () => true,
    complete: async () => {
      /* No transport work in this queue test. */
    },
    fail: async () => {
      /* No transport work in this queue test. */
    },
    recover: async () => {
      /* No transport work in this queue test. */
    },
    pause: async () => {
      /* No transport work in this queue test. */
    },
    resume: async () => {
      /* No transport work in this queue test. */
    },
  });
  service.enqueue('retry-test', request);
  const queued = sessionDomainService.peekNextMessage('retry-test')!;
  const publishedId = queued.id;
  await service.prepare('retry-test', queued);
  expect(queued.id).toBe(publishedId);
  await service.fail(queued, new Error('retry'));
  service.enqueue('retry-test', request);
  expect(sessionDomainService.getQueueLength('retry-test')).toBe(1);
  sessionDomainService.removeQueuedMessage('retry-test', queued.id);
  service.enqueue('retry-test', request);
  expect(sessionDomainService.getQueueLength('retry-test')).toBe(1);
});

it('retries queue pressure after capacity returns without allocating another session', () => {
  const service = new SessionBackgroundDeliveryService();
  for (let index = 0; index < 100; index++) {
    sessionDomainService.enqueue('pressure-test', {
      id: `human-${index}`,
      text: 'work',
      timestamp: '',
      settings,
    });
  }
  expect(service.enqueue('pressure-test', request).queued).toBe(false);
  expect(sessionDomainService.getQueueLength('pressure-test')).toBe(100);
  sessionDomainService.dequeueNext('pressure-test');
  expect(service.enqueue('pressure-test', request).queued).toBe(true);
  expect(sessionDomainService.getQueueLength('pressure-test')).toBe(100);
});

it.each(['complete', 'fail'] as const)(
  'keeps receipt recovery fenced through %s and releases it after persistence failure',
  async (operation) => {
    const sessionId = `activity-${operation}`;
    const service = new SessionBackgroundDeliveryService();
    const delivery = {
      deliveryId: `delivery-${operation}`,
      sessionId,
      bindingRevision: 1,
      eventIds: ['e'],
      text: 'facts',
      attempt: 1,
    };
    let reject!: (error: Error) => void;
    const settlement = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    service.configure({
      prepare: async () => ({ status: 'ready', delivery }),
      validate: async () => true,
      complete: async () => settlement,
      fail: async () => settlement,
      recover: async () => undefined,
      pause: async () => undefined,
      resume: async () => undefined,
    });
    service.enqueue(sessionId, request);
    const queued = sessionDomainService.peekNextMessage(sessionId)!;
    await service.prepare(sessionId, queued);
    expect(service.isDeliveryActive(delivery.deliveryId)).toBe(true);
    expect(service.isDeliveryActive('another-delivery')).toBe(false);
    const pending =
      operation === 'complete'
        ? service.complete(queued)
        : service.fail(queued, new Error('provider unavailable'));
    const outcome = pending.catch((error: unknown) => error);
    expect(service.isDeliveryActive(delivery.deliveryId)).toBe(true);
    reject(new Error('database unavailable'));
    await expect(outcome).resolves.toEqual(
      expect.objectContaining({ message: 'database unavailable' })
    );
    expect(service.isDeliveryActive(delivery.deliveryId)).toBe(false);
  }
);

it.each(['userStop', 'runtimeFailure'] as const)(
  'keeps a newer %s pause when an earlier resume finishes late',
  async (pauseMethod) => {
    const service = new SessionBackgroundDeliveryService();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pauseReason: string | null = 'RESUME_FAILED';
    service.configure({
      prepare: () => Promise.resolve({ status: 'discard' }),
      validate: () => Promise.resolve(false),
      complete: () => Promise.resolve(),
      fail: () => Promise.resolve(),
      recover: () => Promise.resolve(),
      pause: (_id, reason) => {
        pauseReason = reason;
        return Promise.resolve();
      },
      resume: async (_id, isCurrent?: () => boolean) => {
        await pending;
        if (!isCurrent || isCurrent()) {
          pauseReason = null;
        }
      },
    });
    const resume = service.userResume('concurrent-resume');
    await service[pauseMethod]('concurrent-resume');
    release();
    await resume;
    expect(pauseReason).toBe(pauseMethod === 'userStop' ? 'USER_STOPPED' : 'SESSION_FAILED');
  }
);
it('retains a newly queued token when the prior delivery with its stable ID completes', async () => {
  const service = new SessionBackgroundDeliveryService();
  const sessionId = 'stable-token-completion';
  const delivery = {
    deliveryId: 'old-delivery',
    sessionId,
    bindingRevision: 1,
    eventIds: ['old'],
    text: 'old facts',
    attempt: 1,
  };
  service.configure({
    prepare: () => Promise.resolve({ status: 'ready', delivery }),
    validate: () => Promise.resolve(true),
    complete: () => Promise.resolve(),
    fail: () => Promise.resolve(),
    recover: () => Promise.resolve(),
    pause: () => Promise.resolve(),
    resume: () => Promise.resolve(),
  });
  service.enqueue(sessionId, request);
  const old = sessionDomainService.dequeueNext(sessionId)!;
  await service.prepare(sessionId, old);
  service.enqueue(sessionId, request);
  await service.complete(old);
  service.enqueue(sessionId, request);
  expect(sessionDomainService.getQueueLength(sessionId)).toBe(1);
});
