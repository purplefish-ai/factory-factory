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
      'item/started',
      ITEM_PARAMS,
      () => Promise.reject(new Error('malformed notification')),
      onError
    );
    const continued = queue.enqueue(
      'item/completed',
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
      'item/started',
      ITEM_PARAMS,
      () => Promise.reject(new Error('malformed notification')),
      () => {
        throw new Error('reporting unavailable');
      }
    );
    await queue.enqueue('item/completed', ITEM_PARAMS, () => {
      processed.push('continued');
      return Promise.resolve();
    });

    expect(processed).toEqual(['continued']);
  });

  it('processes turn completion after earlier item notifications on the same thread', async () => {
    const queue = new CodexNotificationQueue();
    const processed: string[] = [];
    let releaseStarted: () => void = () => undefined;
    const startedBlocked = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });

    const started = queue.enqueue('item/started', ITEM_PARAMS, async () => {
      processed.push('started');
      await startedBlocked;
    });
    await vi.waitFor(() => expect(processed).toEqual(['started']));

    const completed = queue.enqueue('item/completed', ITEM_PARAMS, () => {
      processed.push('completed');
      return Promise.resolve();
    });
    const turnCompleted = queue.enqueue(
      'turn/completed',
      {
        threadId: ITEM_PARAMS.threadId,
        turn: { id: 'turn-1', status: 'completed' },
      },
      () => {
        processed.push('turn-completed');
        return Promise.resolve();
      }
    );

    expect(processed).toEqual(['started']);
    releaseStarted();
    await Promise.all([started, completed, turnCompleted]);

    expect(processed).toEqual(['started', 'completed', 'turn-completed']);
  });

  it('waits for every earlier item on the completed turn thread', async () => {
    const queue = new CodexNotificationQueue();
    const processed: string[] = [];
    let releaseFirstItem: () => void = () => undefined;
    const firstItemBlocked = new Promise<void>((resolve) => {
      releaseFirstItem = resolve;
    });

    const firstItem = queue.enqueue(
      'item/started',
      { threadId: ITEM_PARAMS.threadId, itemId: 'item-1' },
      async () => {
        await firstItemBlocked;
        processed.push('item-1');
      }
    );
    const secondItem = queue.enqueue(
      'item/started',
      { threadId: ITEM_PARAMS.threadId, itemId: 'item-2' },
      () => {
        processed.push('item-2');
        return Promise.resolve();
      }
    );
    const turnCompleted = queue.enqueue(
      'turn/completed',
      {
        threadId: ITEM_PARAMS.threadId,
        turn: { id: 'turn-1', status: 'completed' },
      },
      () => {
        processed.push('turn-completed');
        return Promise.resolve();
      }
    );

    await secondItem;
    expect(processed).toEqual(['item-2']);
    releaseFirstItem();
    await Promise.all([firstItem, turnCompleted]);

    expect(processed).toEqual(['item-2', 'item-1', 'turn-completed']);
  });

  it('does not make turn completion wait for items on another thread', async () => {
    const queue = new CodexNotificationQueue();
    const processed: string[] = [];
    let releaseItem: () => void = () => undefined;
    const itemBlocked = new Promise<void>((resolve) => {
      releaseItem = resolve;
    });

    const item = queue.enqueue('item/started', ITEM_PARAMS, async () => {
      await itemBlocked;
      processed.push('item');
    });
    await queue.enqueue(
      'turn/completed',
      {
        threadId: 'thread-2',
        turn: { id: 'turn-2', status: 'completed' },
      },
      () => {
        processed.push('turn-completed');
        return Promise.resolve();
      }
    );

    expect(processed).toEqual(['turn-completed']);
    releaseItem();
    await item;
  });

  it('releases a completed plan barrier only after the handler marks the turn safe', async () => {
    const queue = new CodexNotificationQueue();
    const processed: string[] = [];
    let releasePreDispatch: () => void = () => undefined;
    const preDispatchBlocked = new Promise<void>((resolve) => {
      releasePreDispatch = resolve;
    });
    let releaseApproval: () => void = () => undefined;
    const approvalBlocked = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });

    const planCompleted = queue.enqueue(
      'item/completed',
      {
        threadId: ITEM_PARAMS.threadId,
        item: { id: ITEM_PARAMS.itemId, type: 'plan', status: 'completed' },
      },
      async (releaseTurnBarrier?: () => void) => {
        processed.push('plan-started');
        await preDispatchBlocked;
        processed.push('plan-held');
        releaseTurnBarrier?.();
        await approvalBlocked;
      }
    );
    const turnCompleted = queue.enqueue(
      'turn/completed',
      {
        threadId: ITEM_PARAMS.threadId,
        turn: { id: 'turn-1', status: 'completed' },
      },
      () => {
        processed.push('turn-completed');
        return Promise.resolve();
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(processed).toEqual(['plan-started']);

    releasePreDispatch();
    await turnCompleted;
    expect(processed).toEqual(['plan-started', 'plan-held', 'turn-completed']);

    releaseApproval();
    await planCompleted;
  });
});
