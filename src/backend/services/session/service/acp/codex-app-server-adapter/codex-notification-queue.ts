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

export class CodexNotificationQueue {
  private readonly chainsByItemKey = new Map<string, Promise<void>>();

  enqueue(
    params: unknown,
    processNotification: () => Promise<void>,
    onError?: (error: unknown) => void
  ): Promise<void> {
    const processSafely = async (): Promise<void> => {
      try {
        await processNotification();
      } catch (error) {
        try {
          onError?.(error);
        } catch {
          // Notification failures are isolated so later provider events can continue.
        }
      }
    };
    const itemKey = getNotificationItemKey(params);
    if (!itemKey) {
      return processSafely();
    }

    const previousNotification = this.chainsByItemKey.get(itemKey);
    const notificationChain = previousNotification
      ? previousNotification.then(processSafely)
      : processSafely();
    this.chainsByItemKey.set(itemKey, notificationChain);
    void notificationChain.then(() => {
      if (this.chainsByItemKey.get(itemKey) === notificationChain) {
        this.chainsByItemKey.delete(itemKey);
      }
    });
    return notificationChain;
  }
}
