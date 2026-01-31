/**
 * Backend message queue service for managing queued messages per session.
 *
 * This service handles message queueing on the backend, allowing the frontend
 * to send messages at any time. The backend queues them and dispatches to
 * Claude when the session becomes idle.
 */

import type { MessageAttachment } from '@/lib/claude-types';
import { createLogger } from './logger.service';

const logger = createLogger('message-queue-service');

// =============================================================================
// Types
// =============================================================================

/**
 * A message queued on the backend waiting to be dispatched to Claude.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments?: MessageAttachment[];
  settings: {
    selectedModel: string | null;
    thinkingEnabled: boolean;
    planModeEnabled: boolean;
  };
  queuedAt: Date;
}

// =============================================================================
// MessageQueueService Class
// =============================================================================

/**
 * Simple in-memory queue service for managing messages per session.
 *
 * Each session has its own queue. Messages are dispatched in FIFO order
 * when the session becomes idle.
 *
 * @example
 * ```typescript
 * const { position } = messageQueueService.enqueue(sessionId, {
 *   id: 'msg-123',
 *   text: 'Hello',
 *   settings: { selectedModel: null, thinkingEnabled: false, planModeEnabled: false },
 *   queuedAt: new Date(),
 * });
 *
 * const nextMsg = messageQueueService.dequeue(sessionId);
 * ```
 */
class MessageQueueService {
  private queues = new Map<string, QueuedMessage[]>();

  /**
   * Enqueue a message for a session.
   * @returns The position in the queue (0-indexed)
   */
  enqueue(sessionId: string, msg: QueuedMessage): { position: number } {
    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = [];
      this.queues.set(sessionId, queue);
    }

    queue.push(msg);
    const position = queue.length - 1;

    logger.info('Message enqueued', {
      sessionId,
      messageId: msg.id,
      position,
      queueLength: queue.length,
    });

    return { position };
  }

  /**
   * Dequeue the next message for a session.
   * @returns The next message, or undefined if queue is empty
   */
  dequeue(sessionId: string): QueuedMessage | undefined {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }

    const msg = queue.shift();

    logger.info('Message dequeued', {
      sessionId,
      messageId: msg?.id,
      remainingInQueue: queue.length,
    });

    // Clean up empty queues
    if (queue.length === 0) {
      this.queues.delete(sessionId);
    }

    return msg;
  }

  /**
   * Remove a specific message from the queue.
   * @returns true if the message was found and removed
   */
  remove(sessionId: string, messageId: string): boolean {
    const queue = this.queues.get(sessionId);
    if (!queue) {
      return false;
    }

    const index = queue.findIndex((msg) => msg.id === messageId);
    if (index === -1) {
      return false;
    }

    queue.splice(index, 1);

    logger.info('Message removed from queue', {
      sessionId,
      messageId,
      remainingInQueue: queue.length,
    });

    // Clean up empty queues
    if (queue.length === 0) {
      this.queues.delete(sessionId);
    }

    return true;
  }

  /**
   * Get the current queue for a session (for state restoration).
   * Returns a copy to prevent external mutation.
   */
  getQueue(sessionId: string): QueuedMessage[] {
    const queue = this.queues.get(sessionId);
    return queue ? [...queue] : [];
  }

  /**
   * Clear all queued messages for a session.
   */
  clear(sessionId: string): void {
    const queue = this.queues.get(sessionId);
    if (queue && queue.length > 0) {
      logger.info('Queue cleared', {
        sessionId,
        clearedCount: queue.length,
      });
    }
    this.queues.delete(sessionId);
  }

  /**
   * Check if a session has any queued messages.
   */
  hasMessages(sessionId: string): boolean {
    const queue = this.queues.get(sessionId);
    return queue !== undefined && queue.length > 0;
  }

  /**
   * Get the number of queued messages for a session.
   */
  getQueueLength(sessionId: string): number {
    const queue = this.queues.get(sessionId);
    return queue?.length ?? 0;
  }
}

// Export singleton instance
export const messageQueueService = new MessageQueueService();
