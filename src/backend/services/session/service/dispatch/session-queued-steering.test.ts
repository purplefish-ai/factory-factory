import { afterEach, expect, it, vi } from 'vitest';
import { sessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import { deferred } from '@/test-utils/deferred';
import { SessionQueuedSteering } from './session-queued-steering';

function fixture(messageId = 'message', firstOutcome?: Promise<{ outcome: 'promptRequired' }>) {
  let generation = 0;
  const firstSend = deferred();
  const firstResult = deferred<{ outcome: 'promptRequired' }>();
  const secondSend = deferred();
  const secondResult = deferred<{ outcome: 'promptRequired' }>();
  const send = vi
    .fn()
    .mockImplementationOnce(() => {
      firstSend.resolve();
      return firstOutcome ?? firstResult.promise;
    })
    .mockImplementationOnce(() => {
      secondSend.resolve();
      return secondResult.promise;
    });
  const steering = new SessionQueuedSteering({
    captureGuard: () => {
      const captured = generation;
      return () => generation === captured;
    },
    isPromptInFlight: () => true,
    isAllowed: async () => true,
    send,
    dispatch: vi.fn().mockResolvedValue(undefined),
  });
  sessionDomainService.enqueue('session', {
    id: messageId,
    text: 'steer',
    timestamp: new Date().toISOString(),
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  });
  return {
    steering,
    send,
    firstSend,
    firstResult,
    secondSend,
    secondResult,
    reset: () => {
      generation += 1;
      steering.reset('session');
    },
  };
}

afterEach(() => sessionDomainService.clearAllSessions());

it('waits for the shared operation across reconnects', async () => {
  const f = fixture();
  const first = f.steering.steer('session', 'message');
  await f.firstSend.promise;
  expect(f.send).toHaveBeenCalledOnce();
  const completed = vi.fn();
  const second = f.steering.steer('session', 'message').then(completed);
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  f.firstResult.resolve({ outcome: 'promptRequired' });
  await Promise.all([first, second]);
  expect(completed).toHaveBeenCalledOnce();
  expect(f.send).toHaveBeenCalledOnce();
});

it('starts a fresh operation after reset and keeps its ownership when the old operation settles', async () => {
  const f = fixture();
  const old = f.steering.steer('session', 'message');
  await f.firstSend.promise;
  expect(f.send).toHaveBeenCalledTimes(1);
  f.reset();
  const replacement = f.steering.steer('session', 'message');
  await f.secondSend.promise;
  expect(f.send).toHaveBeenCalledTimes(2);
  f.firstResult.resolve({ outcome: 'promptRequired' });
  await old;
  expect(f.steering.isPending('session')).toBe(true);
  const completed = vi.fn();
  const joined = f.steering.steer('session', 'message').then(completed);
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  expect(f.send).toHaveBeenCalledTimes(2);
  f.secondResult.resolve({ outcome: 'promptRequired' });
  await Promise.all([replacement, joined]);
  expect(completed).toHaveBeenCalledOnce();
});

it('delivers the original failure to joined requesters', async () => {
  let fail!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  const f = fixture('message', failure);
  const first = f.steering.steer('session', 'message');
  await f.firstSend.promise;
  expect(f.send).toHaveBeenCalledOnce();
  const second = f.steering.steer('session', 'message');
  const outcomes = Promise.allSettled([first, second]);
  const error = new Error('Native delivery failed');
  fail(error);
  expect(await outcomes).toEqual([
    { status: 'rejected', reason: error },
    { status: 'rejected', reason: error },
  ]);
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.steering.isPending('session')).toBe(false);
  const retry = f.steering.steer('session', 'message');
  await f.secondSend.promise;
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.steering.isPending('session')).toBe(true);
  f.secondResult.resolve({ outcome: 'promptRequired' });
  await retry;
  expect(f.steering.isPending('session')).toBe(false);
});

it('does not join an ordinary user request to a mail-signal operation', async () => {
  const id = 'workspace-mail-wake-message';
  const f = fixture(id);
  const mail = f.steering.steerMailSignal(
    'session',
    id,
    async () => true,
    () => undefined,
    {
      arm: async () => true,
      disarm: async () => true,
      accept: async () => true,
      quarantine: () => undefined,
    }
  );
  await f.firstSend.promise;
  expect(f.send).toHaveBeenCalledOnce();
  const user = f.steering.steer('session', id);
  const finished = vi.fn();
  void user.then(
    () => finished('joined'),
    () => finished('rejected')
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(finished).toHaveBeenCalledExactlyOnceWith('rejected');
  await expect(user).rejects.toThrow('Another queued message');
  expect(f.steering.isPending('session')).toBe(true);
  f.firstResult.resolve({ outcome: 'promptRequired' });
  await mail;
  expect(f.send).toHaveBeenCalledOnce();
});
