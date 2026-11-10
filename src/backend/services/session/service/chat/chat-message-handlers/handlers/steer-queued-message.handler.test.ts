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

it('correlates the busy error for another message without settling the active request', async () => {
  let finish!: () => void;
  const steerQueuedMessage = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    )
    .mockRejectedValueOnce(new Error('Another queued message is being steered'));
  const handler = createSteerQueuedMessageHandler({ steerQueuedMessage });
  const original = handler(context, command);
  const busy = await handler(context, {
    ...command,
    messageId: 'other',
    requestId: 'other-request',
  });
  expect(busy).toMatchObject({
    replies: [{ type: 'error', error: { kind: 'steer_failed' }, requestId: 'other-request' }],
  });
  expect(steerQueuedMessage).toHaveBeenNthCalledWith(2, 'session', 'other');
  finish();
  expect(await original).toEqual({ replies: [{ type: 'steer_settled', requestId: 'request' }] });
});
