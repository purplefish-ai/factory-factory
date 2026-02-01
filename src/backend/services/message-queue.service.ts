/**
 * Backend message queue service for managing queued messages per session.
 *
 * This service handles message queueing on the backend, allowing the frontend
 * to send messages at any time. The backend queues them and dispatches to
 * Claude when the session becomes idle.
 */

import type { QueuedMessage } from '@/lib/claude-types';
import { createLogger } from './logger.service';

const logger = createLogger('message-queue-service');

// Re-export for backwards compatibility
export type { QueuedMessage } from '@/lib/claude-types';

// Max queue size to prevent runaway queueing
const MAX_QUEUE_SIZE = 100;

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
   * Track messages that have been dequeued but not yet confirmed as processed.
   * This covers the "in-flight" gap where a message has been dequeued but
   * Claude hasn't yet received/acknowledged it (e.g., during client startup).
   */
  private inFlight = new Map<string, QueuedMessage>();

  /**
   * Get or create a queue for a session.
   */
  private getOrCreateQueue(sessionId: string): QueuedMessage[] {
    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = [];
      this.queues.set(sessionId, queue);
    }
    return queue;
  }

  /**
   * Clean up empty queue for a session.
   */
  private cleanupEmptyQueue(sessionId: string, queue: QueuedMessage[]): void {
    if (queue.length === 0) {
      this.queues.delete(sessionId);
    }
  }

  /**
   * Enqueue a message for a session.
   * @returns The position in the queue (0-indexed), or an error if queue is full
   */
  enqueue(sessionId: string, msg: QueuedMessage): { position: number } | { error: string } {
    const queue = this.getOrCreateQueue(sessionId);

    if (queue.length >= MAX_QUEUE_SIZE) {
      logger.warn('Queue full, rejecting message', {
        sessionId,
        messageId: msg.id,
        queueLength: queue.length,
        maxSize: MAX_QUEUE_SIZE,
      });
      return { error: `Queue full (max ${MAX_QUEUE_SIZE} messages)` };
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

    this.cleanupEmptyQueue(sessionId, queue);
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

    this.cleanupEmptyQueue(sessionId, queue);
    return true;
  }

  /**
   * Re-queue a message at the front of the queue.
   * Used when a dequeued message cannot be dispatched (e.g., client busy or failed to start).
   */
  requeue(sessionId: string, msg: QueuedMessage): void {
    const queue = this.getOrCreateQueue(sessionId);
    queue.unshift(msg);

    logger.info('Message re-queued at front', {
      sessionId,
      messageId: msg.id,
      queueLength: queue.length,
    });
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

  // =============================================================================
  // In-Flight Message Tracking
  // =============================================================================

  /**
   * Mark a message as in-flight (dequeued but not yet confirmed as dispatched to Claude).
   * Only one message can be in-flight per session at a time.
   */
  markInFlight(sessionId: string, msg: QueuedMessage): void {
    this.inFlight.set(sessionId, msg);
    logger.info('Message marked in-flight', {
      sessionId,
      messageId: msg.id,
    });
  }

  /**
   * Clear the in-flight message for a session.
   * Called when dispatch is complete (message sent to Claude) or on re-queue.
   *
   * @param sessionId - The session ID
   * @param messageId - Optional message ID to match. If provided, only clears if the
   *                    in-flight message matches this ID (prevents stale dispatch attempts
   *                    from clearing a newer in-flight message).
   * @returns true if the in-flight message was cleared, false otherwise
   */
  clearInFlight(sessionId: string, messageId?: string): boolean {
    const msg = this.inFlight.get(sessionId);
    if (!msg) {
      return false;
    }

    // If messageId provided, only clear if it matches (compare-and-delete)
    if (messageId !== undefined && msg.id !== messageId) {
      logger.warn('In-flight clear skipped - message ID mismatch', {
        sessionId,
        expectedMessageId: messageId,
        actualMessageId: msg.id,
      });
      return false;
    }

    this.inFlight.delete(sessionId);
    logger.info('In-flight cleared', {
      sessionId,
      messageId: msg.id,
    });
    return true;
  }

  /**
   * Get the current in-flight message for a session.
   */
  getInFlight(sessionId: string): QueuedMessage | undefined {
    return this.inFlight.get(sessionId);
  }

  /**
   * Get the queue including any in-flight message at the front.
   * The in-flight message appears first since it's actively being dispatched.
   * De-duplicates by ID to prevent the same message appearing twice.
   */
  getQueueWithInFlight(sessionId: string): QueuedMessage[] {
    const queue = this.getQueue(sessionId);
    const inFlightMsg = this.inFlight.get(sessionId);
    if (inFlightMsg) {
      // Filter out any queued message with the same ID to prevent duplicates
      const filteredQueue = queue.filter((msg) => msg.id !== inFlightMsg.id);
      return [inFlightMsg, ...filteredQueue];
    }
    return queue;
  }

  /**
   * Remove the in-flight message if it matches the given message ID.
   * Used when user explicitly removes a message that's currently in-flight.
   * @returns true if the in-flight message was removed, false otherwise
   */
  removeInFlight(sessionId: string, messageId: string): boolean {
    const msg = this.inFlight.get(sessionId);
    if (msg && msg.id === messageId) {
      this.inFlight.delete(sessionId);
      logger.info('In-flight message removed', {
        sessionId,
        messageId,
      });
      return true;
    }
    return false;
  }

  /**
   * Requeue the current in-flight message back to the front of the queue.
   * Used when session is stopped while a message is in-flight.
   * @returns true if a message was requeued, false if no in-flight message
   */
  requeueInFlight(sessionId: string): boolean {
    const msg = this.inFlight.get(sessionId);
    if (msg) {
      this.inFlight.delete(sessionId);
      this.requeue(sessionId, msg);
      logger.info('In-flight message requeued due to session stop', {
        sessionId,
        messageId: msg.id,
      });
      return true;
    }
    return false;
  }
}

// Export singleton instance
export const messageQueueService = new MessageQueueService();
