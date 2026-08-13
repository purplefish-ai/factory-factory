import { describe, expect, it, vi } from 'vitest';
import { CodexNotificationQueue } from './codex-notification-queue';

const ITEM_PARAMS = {
  threadId: 'thread-1',
  itemId: 'item-1',
};

describe('CodexNotificationQueue', () => {
  it('continues processing an item after an earlier notification rejects', async () => {
    const queue = new CodexNotificationQueue();
    const onError = vi.fn();
    const processed: string[] = [];

    const rejected = queue.enqueue(
      ITEM_PARAMS,
      () => Promise.reject(new Error('malformed notification')),
      onError
    );
    const continued = queue.enqueue(
      ITEM_PARAMS,
      () => {
        processed.push('continued');
        return Promise.resolve();
      },
      onError
    );

    await expect(Promise.all([rejected, continued])).resolves.toEqual([undefined, undefined]);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'malformed notification' })
    );
    expect(processed).toEqual(['continued']);
  });

  it('does not let error reporting poison an item queue', async () => {
    const queue = new CodexNotificationQueue();
    const processed: string[] = [];

    await queue.enqueue(
      ITEM_PARAMS,
      () => Promise.reject(new Error('malformed notification')),
      () => {
        throw new Error('reporting unavailable');
      }
    );
    await queue.enqueue(ITEM_PARAMS, () => {
      processed.push('continued');
      return Promise.resolve();
    });

    expect(processed).toEqual(['continued']);
  });
});
