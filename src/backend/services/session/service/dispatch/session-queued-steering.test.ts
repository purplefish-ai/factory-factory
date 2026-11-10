import { afterEach, expect, it, vi } from 'vitest';
import { sessionDomainService } from '../session-domain.service';
import { SessionQueuedSteering } from './session-queued-steering';

function fixture() {
  let generation = 0;
  const completions: Array<(outcome: { outcome: 'promptRequired' }) => void> = [];
  const send = vi.fn(
    () =>
      new Promise<{ outcome: 'promptRequired' }>((resolve) => {
        completions.push(resolve);
      })
  );
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
    id: 'message',
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
    completions,
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
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  const completed = vi.fn();
  const second = f.steering.steer('session', 'message').then(completed);
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  f.completions[0]!({ outcome: 'promptRequired' });
  await Promise.all([first, second]);
  expect(completed).toHaveBeenCalledOnce();
  expect(f.send).toHaveBeenCalledOnce();
});

it('starts a fresh operation after reset and keeps its ownership when the old operation settles', async () => {
  const f = fixture();
  const old = f.steering.steer('session', 'message');
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  f.reset();
  const replacement = f.steering.steer('session', 'message');
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
  f.completions[0]!({ outcome: 'promptRequired' });
  await old;
  const completed = vi.fn();
  const joined = f.steering.steer('session', 'message').then(completed);
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  expect(f.send).toHaveBeenCalledTimes(2);
  f.completions[1]!({ outcome: 'promptRequired' });
  await Promise.all([replacement, joined]);
  expect(completed).toHaveBeenCalledOnce();
});

it('delivers the original failure to joined requesters', async () => {
  const f = fixture();
  let fail!: (error: Error) => void;
  f.send.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      })
  );
  const first = f.steering.steer('session', 'message');
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  const second = f.steering.steer('session', 'message');
  const outcomes = Promise.allSettled([first, second]);
  const error = new Error('Native delivery failed');
  fail(error);
  expect(await outcomes).toEqual([
    { status: 'rejected', reason: error },
    { status: 'rejected', reason: error },
  ]);
  expect(f.send).toHaveBeenCalledOnce();
});
