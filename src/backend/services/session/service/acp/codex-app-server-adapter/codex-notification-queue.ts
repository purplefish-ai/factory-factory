import { isRecord } from './acp-adapter-utils';

function getNotificationItemKey(params: unknown): string | null {
  if (!isRecord(params) || typeof params.threadId !== 'string') {
    return null;
  }
  const itemId =
    typeof params.itemId === 'string'
      ? params.itemId
      : isRecord(params.item) && typeof params.item.id === 'string'
        ? params.item.id
        : null;
  return itemId ? `${params.threadId}:${itemId}` : null;
}

function getNotificationThreadId(params: unknown): string | null {
  return isRecord(params) && typeof params.threadId === 'string' ? params.threadId : null;
}

function releasesTurnBarrierWhenSignaled(method: string, params: unknown): boolean {
  return (
    method === 'item/completed' &&
    isRecord(params) &&
    isRecord(params.item) &&
    params.item.type === 'plan'
  );
}

export class CodexNotificationQueue {
  private readonly chainsByItemKey = new Map<string, Promise<void>>();
  private readonly itemBarriersByThreadId = new Map<string, Set<Promise<void>>>();
  private readonly turnBarriersByThreadId = new Map<string, Promise<void>>();

  enqueue(
    method: string,
    params: unknown,
    processNotification: (releaseTurnBarrier?: () => void) => Promise<void>,
    onError?: (error: unknown) => void
  ): Promise<void> {
    const processSafely = async (releaseTurnBarrier?: () => void): Promise<void> => {
      try {
        await processNotification(releaseTurnBarrier);
      } catch (error) {
        try {
          onError?.(error);
        } catch {
          // Notification failures are isolated so later provider events can continue.
        }
      }
    };
    const threadId = getNotificationThreadId(params);
    if (!threadId) {
      return processSafely();
    }

    const itemKey = getNotificationItemKey(params);
    if (!itemKey && method !== 'turn/completed') {
      return processSafely();
    }

    if (!itemKey) {
      const previousTurnBarrier = this.turnBarriersByThreadId.get(threadId);
      const itemBarriers = [...(this.itemBarriersByThreadId.get(threadId) ?? [])];
      const dependencies = previousTurnBarrier
        ? [previousTurnBarrier, ...itemBarriers]
        : itemBarriers;
      const turnBarrier =
        dependencies.length > 0
          ? Promise.all(dependencies).then(() => processSafely())
          : processSafely();
      this.turnBarriersByThreadId.set(threadId, turnBarrier);
      void turnBarrier.then(() => {
        if (this.turnBarriersByThreadId.get(threadId) === turnBarrier) {
          this.turnBarriersByThreadId.delete(threadId);
        }
      });
      return turnBarrier;
    }

    const previousNotification = this.chainsByItemKey.get(itemKey);
    const previousTurnBarrier = this.turnBarriersByThreadId.get(threadId);
    const dependencies = [previousNotification, previousTurnBarrier].filter(
      (dependency): dependency is Promise<void> => dependency !== undefined
    );
    const releasesWhenSignaled = releasesTurnBarrierWhenSignaled(method, params);
    let releaseTurnBarrier: () => void = () => undefined;
    const signaledTurnBarrier = releasesWhenSignaled
      ? new Promise<void>((resolve) => {
          releaseTurnBarrier = resolve;
        })
      : null;
    const processQueued = async (): Promise<void> => {
      await processSafely(releasesWhenSignaled ? releaseTurnBarrier : undefined);
      releaseTurnBarrier();
    };
    const notificationChain =
      dependencies.length > 0 ? Promise.all(dependencies).then(processQueued) : processQueued();
    this.chainsByItemKey.set(itemKey, notificationChain);
    void notificationChain.then(() => {
      if (this.chainsByItemKey.get(itemKey) === notificationChain) {
        this.chainsByItemKey.delete(itemKey);
      }
    });

    const itemBarrier = signaledTurnBarrier ?? notificationChain;
    const threadItemBarriers =
      this.itemBarriersByThreadId.get(threadId) ?? new Set<Promise<void>>();
    threadItemBarriers.add(itemBarrier);
    this.itemBarriersByThreadId.set(threadId, threadItemBarriers);
    void itemBarrier.then(() => {
      threadItemBarriers.delete(itemBarrier);
      if (threadItemBarriers.size === 0) {
        this.itemBarriersByThreadId.delete(threadId);
      }
    });
    return notificationChain;
  }
}
