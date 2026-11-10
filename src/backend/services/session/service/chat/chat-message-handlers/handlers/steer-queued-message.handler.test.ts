import { expect, it, vi } from 'vitest';
import { QueuedMessageNotFoundError } from '@/backend/services/session/service/dispatch/session-steering-errors';
import { createSteerQueuedMessageHandler } from './steer-queued-message.handler';

const command = {
  type: 'steer_queued_message',
  messageId: 'message',
  requestId: 'request',
} as const;
const context = { sessionId: 'session', workingDir: '/tmp' };

it('acknowledges only after steering settles, including queue fallback', async () => {
  let finish!: () => void;
  const steerQueuedMessage = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  const completed = vi.fn();
  const result = createSteerQueuedMessageHandler({ steerQueuedMessage })(context, command);
  void Promise.resolve(result).then(completed);
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  finish();
  expect(await result).toEqual({ replies: [{ type: 'steer_settled', requestId: 'request' }] });
});

it('correlates failures with the request', async () => {
  const cause = new Error('Unavailable');
  const steerQueuedMessage = vi.fn().mockRejectedValue(cause);
  expect(
    await createSteerQueuedMessageHandler({ steerQueuedMessage })(context, command)
  ).toMatchObject({
    replies: [{ type: 'error', requestId: 'request' }],
  });
});

it('settles a stale queue request without reporting an error', async () => {
  const steerQueuedMessage = vi.fn().mockRejectedValue(new QueuedMessageNotFoundError());
  expect(await createSteerQueuedMessageHandler({ steerQueuedMessage })(context, command)).toEqual({
    replies: [{ type: 'steer_settled', requestId: 'request' }],
  });
});

it.each([false, true])(
  'joins an in-flight request from a reconnected requester (failure: %s)',
  async (fail) => {
    let finish!: () => void;
    let reject!: (cause: Error) => void;
    const steerQueuedMessage = vi.fn(
      () =>
        new Promise<void>((resolve, rejectOperation) => {
          finish = resolve;
          reject = rejectOperation;
        })
    );
    const handler = createSteerQueuedMessageHandler({ steerQueuedMessage });
    const original = handler(context, command);
    const completed = vi.fn();
    const reconnected = handler(context, { ...command, requestId: 'reconnected' });
    void Promise.resolve(reconnected).then(completed);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    expect(steerQueuedMessage).toHaveBeenCalledTimes(1);
    if (fail) {
      reject(new Error('Rejected'));
    } else {
      finish();
    }
    await original;
    expect(await reconnected).toMatchObject({
      replies: [{ type: fail ? 'error' : 'steer_settled', requestId: 'reconnected' }],
    });
  }
);
