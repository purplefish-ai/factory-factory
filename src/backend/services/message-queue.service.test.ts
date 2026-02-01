/**
 * Tests for the MessageQueueService.
 *
 * Tests the in-memory message queue used for managing messages per session.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { messageQueueService, type QueuedMessage } from './message-queue.service';

// =============================================================================
// Test Helpers
// =============================================================================

function createTestMessage(id: string, text = 'Test message'): QueuedMessage {
  return {
    id,
    text,
    settings: {
      selectedModel: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
    timestamp: new Date().toISOString(),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('MessageQueueService', () => {
  // Clear queues and in-flight state between tests to ensure isolation
  beforeEach(() => {
    // Clear any existing queues by clearing known test sessions
    messageQueueService.clear('session-1');
    messageQueueService.clear('session-2');
    messageQueueService.clear('session-3');
    // Also clear in-flight state
    messageQueueService.clearInFlight('session-1');
    messageQueueService.clearInFlight('session-2');
    messageQueueService.clearInFlight('session-3');
  });

  // ---------------------------------------------------------------------------
  // enqueue
  // ---------------------------------------------------------------------------

  describe('enqueue', () => {
    it('should add message to queue and return position 0 for first message', () => {
      const msg = createTestMessage('msg-1');
      const result = messageQueueService.enqueue('session-1', msg);

      expect('position' in result).toBe(true);
      if ('position' in result) {
        expect(result.position).toBe(0);
      }
      expect(messageQueueService.getQueueLength('session-1')).toBe(1);
    });

    it('should return incrementing positions for subsequent messages', () => {
      const msg1 = createTestMessage('msg-1');
      const msg2 = createTestMessage('msg-2');
      const msg3 = createTestMessage('msg-3');

      const result1 = messageQueueService.enqueue('session-1', msg1);
      const result2 = messageQueueService.enqueue('session-1', msg2);
      const result3 = messageQueueService.enqueue('session-1', msg3);

      expect('position' in result1 && result1.position).toBe(0);
      expect('position' in result2 && result2.position).toBe(1);
      expect('position' in result3 && result3.position).toBe(2);
    });

    it('should create separate queues for different sessions', () => {
      const msg1 = createTestMessage('msg-1');
      const msg2 = createTestMessage('msg-2');

      messageQueueService.enqueue('session-1', msg1);
      messageQueueService.enqueue('session-2', msg2);

      expect(messageQueueService.getQueueLength('session-1')).toBe(1);
      expect(messageQueueService.getQueueLength('session-2')).toBe(1);
    });

    it('should preserve message with attachments', () => {
      const msg: QueuedMessage = {
        id: 'msg-with-attachment',
        text: 'Check this image',
        attachments: [
          { id: 'att-1', name: 'image.png', type: 'image/png', size: 1024, data: 'base64data' },
        ],
        settings: { selectedModel: 'opus', thinkingEnabled: true, planModeEnabled: false },
        timestamp: new Date().toISOString(),
      };

      messageQueueService.enqueue('session-1', msg);
      const queue = messageQueueService.getQueue('session-1');

      expect(queue[0].attachments).toHaveLength(1);
      expect(queue[0].attachments?.[0].name).toBe('image.png');
      expect(queue[0].settings.selectedModel).toBe('opus');
    });

    it('should return error when queue is full (max 100 messages)', () => {
      // Fill the queue to max capacity
      for (let i = 0; i < 100; i++) {
        const result = messageQueueService.enqueue('session-1', createTestMessage(`msg-${i}`));
        expect(result).toHaveProperty('position');
      }

      // 101st message should fail
      const result = messageQueueService.enqueue('session-1', createTestMessage('msg-overflow'));

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Queue full');
      expect(messageQueueService.getQueueLength('session-1')).toBe(100);
    });
  });

  // ---------------------------------------------------------------------------
  // dequeue
  // ---------------------------------------------------------------------------

  describe('dequeue', () => {
    it('should return undefined for empty queue', () => {
      const result = messageQueueService.dequeue('session-1');
      expect(result).toBeUndefined();
    });

    it('should return undefined for non-existent session', () => {
      const result = messageQueueService.dequeue('non-existent-session');
      expect(result).toBeUndefined();
    });

    it('should return and remove first message (FIFO order)', () => {
      const msg1 = createTestMessage('msg-1', 'First');
      const msg2 = createTestMessage('msg-2', 'Second');
      const msg3 = createTestMessage('msg-3', 'Third');

      messageQueueService.enqueue('session-1', msg1);
      messageQueueService.enqueue('session-1', msg2);
      messageQueueService.enqueue('session-1', msg3);

      const dequeued1 = messageQueueService.dequeue('session-1');
      const dequeued2 = messageQueueService.dequeue('session-1');
      const dequeued3 = messageQueueService.dequeue('session-1');

      expect(dequeued1?.id).toBe('msg-1');
      expect(dequeued2?.id).toBe('msg-2');
      expect(dequeued3?.id).toBe('msg-3');
    });

    it('should clean up empty queue after last dequeue', () => {
      const msg = createTestMessage('msg-1');
      messageQueueService.enqueue('session-1', msg);

      messageQueueService.dequeue('session-1');

      expect(messageQueueService.hasMessages('session-1')).toBe(false);
      expect(messageQueueService.getQueueLength('session-1')).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // remove
  // ---------------------------------------------------------------------------

  describe('remove', () => {
    it('should return false for non-existent session', () => {
      const result = messageQueueService.remove('non-existent', 'msg-1');
      expect(result).toBe(false);
    });

    it('should return false for non-existent message', () => {
      const msg = createTestMessage('msg-1');
      messageQueueService.enqueue('session-1', msg);

      const result = messageQueueService.remove('session-1', 'non-existent-msg');
      expect(result).toBe(false);
    });

    it('should remove specific message and return true', () => {
      const msg1 = createTestMessage('msg-1');
      const msg2 = createTestMessage('msg-2');
      const msg3 = createTestMessage('msg-3');

      messageQueueService.enqueue('session-1', msg1);
      messageQueueService.enqueue('session-1', msg2);
      messageQueueService.enqueue('session-1', msg3);

      const result = messageQueueService.remove('session-1', 'msg-2');

      expect(result).toBe(true);
      expect(messageQueueService.getQueueLength('session-1')).toBe(2);

      const queue = messageQueueService.getQueue('session-1');
      expect(queue[0].id).toBe('msg-1');
      expect(queue[1].id).toBe('msg-3');
    });

    it('should clean up empty queue after removing last message', () => {
      const msg = createTestMessage('msg-1');
      messageQueueService.enqueue('session-1', msg);

      messageQueueService.remove('session-1', 'msg-1');

      expect(messageQueueService.hasMessages('session-1')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // requeue
  // ---------------------------------------------------------------------------

  describe('requeue', () => {
    it('should add message to front of existing queue', () => {
      const msg1 = createTestMessage('msg-1');
      const msg2 = createTestMessage('msg-2');
      const msgToRequeue = createTestMessage('msg-requeued');

      messageQueueService.enqueue('session-1', msg1);
      messageQueueService.enqueue('session-1', msg2);
      messageQueueService.requeue('session-1', msgToRequeue);

      const queue = messageQueueService.getQueue('session-1');
      expect(queue).toHaveLength(3);
      expect(queue[0].id).toBe('msg-requeued');
      expect(queue[1].id).toBe('msg-1');
      expect(queue[2].id).toBe('msg-2');
    });

    it('should create queue if it does not exist', () => {
      const msg = createTestMessage('msg-1');

      messageQueueService.requeue('session-1', msg);

      expect(messageQueueService.getQueueLength('session-1')).toBe(1);
      expect(messageQueueService.getQueue('session-1')[0].id).toBe('msg-1');
    });

    it('should work correctly after dequeue and requeue cycle', () => {
      const msg1 = createTestMessage('msg-1');
      const msg2 = createTestMessage('msg-2');

      messageQueueService.enqueue('session-1', msg1);
      messageQueueService.enqueue('session-1', msg2);

      // Dequeue first message
      const dequeued = messageQueueService.dequeue('session-1');
      expect(dequeued).toBeDefined();
      expect(dequeued?.id).toBe('msg-1');

      // Requeue it at the front (dequeued is guaranteed defined by assertion above)
      if (dequeued) {
        messageQueueService.requeue('session-1', dequeued);
      }

      // Now msg-1 should be back at the front
      const queue = messageQueueService.getQueue('session-1');
      expect(queue).toHaveLength(2);
      expect(queue[0].id).toBe('msg-1');
      expect(queue[1].id).toBe('msg-2');
    });
  });

  // ---------------------------------------------------------------------------
  // getQueue
  // ---------------------------------------------------------------------------

  describe('getQueue', () => {
    it('should return empty array for non-existent session', () => {
      const queue = messageQueueService.getQueue('non-existent');
      expect(queue).toEqual([]);
    });

    it('should return copy of queue, not the original', () => {
      const msg = createTestMessage('msg-1');
      messageQueueService.enqueue('session-1', msg);

      const queue1 = messageQueueService.getQueue('session-1');
      const queue2 = messageQueueService.getQueue('session-1');

      // Should be different array references
      expect(queue1).not.toBe(queue2);

      // Mutating the returned array should not affect the internal queue
      queue1.push(createTestMessage('msg-mutated'));
      expect(messageQueueService.getQueueLength('session-1')).toBe(1);
    });

    it('should return messages in queue order', () => {
      const msg1 = createTestMessage('msg-1');
      const msg2 = createTestMessage('msg-2');
      const msg3 = createTestMessage('msg-3');

      messageQueueService.enqueue('session-1', msg1);
      messageQueueService.enqueue('session-1', msg2);
      messageQueueService.enqueue('session-1', msg3);

      const queue = messageQueueService.getQueue('session-1');

      expect(queue).toHaveLength(3);
      expect(queue[0].id).toBe('msg-1');
      expect(queue[1].id).toBe('msg-2');
      expect(queue[2].id).toBe('msg-3');
    });
  });

  // ---------------------------------------------------------------------------
  // clear
  // ---------------------------------------------------------------------------

  describe('clear', () => {
    it('should remove all messages for a session', () => {
      messageQueueService.enqueue('session-1', createTestMessage('msg-1'));
      messageQueueService.enqueue('session-1', createTestMessage('msg-2'));
      messageQueueService.enqueue('session-1', createTestMessage('msg-3'));

      messageQueueService.clear('session-1');

      expect(messageQueueService.hasMessages('session-1')).toBe(false);
      expect(messageQueueService.getQueueLength('session-1')).toBe(0);
      expect(messageQueueService.getQueue('session-1')).toEqual([]);
    });

    it('should not affect other sessions', () => {
      messageQueueService.enqueue('session-1', createTestMessage('msg-1'));
      messageQueueService.enqueue('session-2', createTestMessage('msg-2'));

      messageQueueService.clear('session-1');

      expect(messageQueueService.hasMessages('session-1')).toBe(false);
      expect(messageQueueService.hasMessages('session-2')).toBe(true);
    });

    it('should handle clearing non-existent session gracefully', () => {
      // Should not throw
      expect(() => messageQueueService.clear('non-existent')).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // hasMessages
  // ---------------------------------------------------------------------------

  describe('hasMessages', () => {
    it('should return false for non-existent session', () => {
      expect(messageQueueService.hasMessages('non-existent')).toBe(false);
    });

    it('should return false for empty queue', () => {
      messageQueueService.enqueue('session-1', createTestMessage('msg-1'));
      messageQueueService.dequeue('session-1');

      expect(messageQueueService.hasMessages('session-1')).toBe(false);
    });

    it('should return true when queue has messages', () => {
      messageQueueService.enqueue('session-1', createTestMessage('msg-1'));

      expect(messageQueueService.hasMessages('session-1')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // getQueueLength
  // ---------------------------------------------------------------------------

  describe('getQueueLength', () => {
    it('should return 0 for non-existent session', () => {
      expect(messageQueueService.getQueueLength('non-existent')).toBe(0);
    });

    it('should return correct count as messages are added/removed', () => {
      expect(messageQueueService.getQueueLength('session-1')).toBe(0);

      messageQueueService.enqueue('session-1', createTestMessage('msg-1'));
      expect(messageQueueService.getQueueLength('session-1')).toBe(1);

      messageQueueService.enqueue('session-1', createTestMessage('msg-2'));
      expect(messageQueueService.getQueueLength('session-1')).toBe(2);

      messageQueueService.dequeue('session-1');
      expect(messageQueueService.getQueueLength('session-1')).toBe(1);

      messageQueueService.remove('session-1', 'msg-2');
      expect(messageQueueService.getQueueLength('session-1')).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // In-Flight Tracking
  // ---------------------------------------------------------------------------

  describe('in-flight tracking', () => {
    it('should track in-flight message with markInFlight', () => {
      const msg = createTestMessage('msg-1');

      messageQueueService.markInFlight('session-1', msg);

      const inFlight = messageQueueService.getInFlight('session-1');
      expect(inFlight).toBeDefined();
      expect(inFlight?.id).toBe('msg-1');
    });

    it('should return undefined for session with no in-flight message', () => {
      const inFlight = messageQueueService.getInFlight('non-existent');
      expect(inFlight).toBeUndefined();
    });

    it('should clear in-flight message with clearInFlight', () => {
      const msg = createTestMessage('msg-1');

      messageQueueService.markInFlight('session-1', msg);
      const cleared = messageQueueService.clearInFlight('session-1');

      expect(cleared).toBe(true);
      const inFlight = messageQueueService.getInFlight('session-1');
      expect(inFlight).toBeUndefined();
    });

    it('should return false when clearing non-existent in-flight', () => {
      const cleared = messageQueueService.clearInFlight('non-existent');
      expect(cleared).toBe(false);
    });

    it('should clear in-flight only if messageId matches (compare-and-delete)', () => {
      const msg = createTestMessage('msg-1');
      messageQueueService.markInFlight('session-1', msg);

      // Try to clear with wrong messageId - should fail
      const clearedWrong = messageQueueService.clearInFlight('session-1', 'wrong-id');
      expect(clearedWrong).toBe(false);
      expect(messageQueueService.getInFlight('session-1')?.id).toBe('msg-1');

      // Clear with correct messageId - should succeed
      const clearedCorrect = messageQueueService.clearInFlight('session-1', 'msg-1');
      expect(clearedCorrect).toBe(true);
      expect(messageQueueService.getInFlight('session-1')).toBeUndefined();
    });

    it('should clear in-flight without messageId check when not provided', () => {
      const msg = createTestMessage('msg-1');
      messageQueueService.markInFlight('session-1', msg);

      // Clear without messageId - should always clear
      const cleared = messageQueueService.clearInFlight('session-1');
      expect(cleared).toBe(true);
      expect(messageQueueService.getInFlight('session-1')).toBeUndefined();
    });

    it('should replace previous in-flight message when marking new one', () => {
      const msg1 = createTestMessage('msg-1');
      const msg2 = createTestMessage('msg-2');

      messageQueueService.markInFlight('session-1', msg1);
      messageQueueService.markInFlight('session-1', msg2);

      const inFlight = messageQueueService.getInFlight('session-1');
      expect(inFlight?.id).toBe('msg-2');
    });

    it('should maintain separate in-flight tracking per session', () => {
      const msg1 = createTestMessage('msg-1');
      const msg2 = createTestMessage('msg-2');

      messageQueueService.markInFlight('session-1', msg1);
      messageQueueService.markInFlight('session-2', msg2);

      expect(messageQueueService.getInFlight('session-1')?.id).toBe('msg-1');
      expect(messageQueueService.getInFlight('session-2')?.id).toBe('msg-2');

      // Clear one shouldn't affect other
      messageQueueService.clearInFlight('session-1');
      expect(messageQueueService.getInFlight('session-1')).toBeUndefined();
      expect(messageQueueService.getInFlight('session-2')?.id).toBe('msg-2');
    });
  });

  // ---------------------------------------------------------------------------
  // removeInFlight
  // ---------------------------------------------------------------------------

  describe('removeInFlight', () => {
    it('should remove in-flight message when ID matches', () => {
      const msg = createTestMessage('msg-1');
      messageQueueService.markInFlight('session-1', msg);

      const removed = messageQueueService.removeInFlight('session-1', 'msg-1');

      expect(removed).toBe(true);
      expect(messageQueueService.getInFlight('session-1')).toBeUndefined();
    });

    it('should return false when in-flight message ID does not match', () => {
      const msg = createTestMessage('msg-1');
      messageQueueService.markInFlight('session-1', msg);

      const removed = messageQueueService.removeInFlight('session-1', 'wrong-id');

      expect(removed).toBe(false);
      expect(messageQueueService.getInFlight('session-1')?.id).toBe('msg-1');
    });

    it('should return false when no in-flight message exists', () => {
      const removed = messageQueueService.removeInFlight('session-1', 'msg-1');
      expect(removed).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // requeueInFlight
  // ---------------------------------------------------------------------------

  describe('requeueInFlight', () => {
    it('should requeue in-flight message to front of queue', () => {
      const inFlightMsg = createTestMessage('msg-in-flight');
      const queuedMsg = createTestMessage('msg-queued');

      messageQueueService.enqueue('session-1', queuedMsg);
      messageQueueService.markInFlight('session-1', inFlightMsg);

      const requeued = messageQueueService.requeueInFlight('session-1');

      expect(requeued).toBe(true);
      expect(messageQueueService.getInFlight('session-1')).toBeUndefined();

      const queue = messageQueueService.getQueue('session-1');
      expect(queue).toHaveLength(2);
      expect(queue[0].id).toBe('msg-in-flight');
      expect(queue[1].id).toBe('msg-queued');
    });

    it('should return false when no in-flight message exists', () => {
      const requeued = messageQueueService.requeueInFlight('session-1');
      expect(requeued).toBe(false);
    });

    it('should create queue if it does not exist when requeuing', () => {
      const msg = createTestMessage('msg-1');
      messageQueueService.markInFlight('session-1', msg);

      const requeued = messageQueueService.requeueInFlight('session-1');

      expect(requeued).toBe(true);
      expect(messageQueueService.getQueue('session-1')).toHaveLength(1);
      expect(messageQueueService.getQueue('session-1')[0].id).toBe('msg-1');
    });
  });

  // ---------------------------------------------------------------------------
  // getQueueWithInFlight
  // ---------------------------------------------------------------------------

  describe('getQueueWithInFlight', () => {
    it('should return only queue when no in-flight message', () => {
      const msg = createTestMessage('msg-1');
      messageQueueService.enqueue('session-1', msg);

      const result = messageQueueService.getQueueWithInFlight('session-1');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('msg-1');
    });

    it('should return only in-flight message when queue is empty', () => {
      const msg = createTestMessage('msg-in-flight');
      messageQueueService.markInFlight('session-1', msg);

      const result = messageQueueService.getQueueWithInFlight('session-1');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('msg-in-flight');
    });

    it('should return in-flight message at front followed by queued messages', () => {
      const inFlightMsg = createTestMessage('msg-in-flight');
      const queuedMsg1 = createTestMessage('msg-queued-1');
      const queuedMsg2 = createTestMessage('msg-queued-2');

      messageQueueService.markInFlight('session-1', inFlightMsg);
      messageQueueService.enqueue('session-1', queuedMsg1);
      messageQueueService.enqueue('session-1', queuedMsg2);

      const result = messageQueueService.getQueueWithInFlight('session-1');

      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('msg-in-flight');
      expect(result[1].id).toBe('msg-queued-1');
      expect(result[2].id).toBe('msg-queued-2');
    });

    it('should return empty array when no in-flight and no queue', () => {
      const result = messageQueueService.getQueueWithInFlight('non-existent');
      expect(result).toEqual([]);
    });

    it('should return copy that does not affect internal state', () => {
      const msg = createTestMessage('msg-in-flight');
      messageQueueService.markInFlight('session-1', msg);

      const result = messageQueueService.getQueueWithInFlight('session-1');
      result.push(createTestMessage('msg-mutated'));

      // Internal state should be unchanged
      const result2 = messageQueueService.getQueueWithInFlight('session-1');
      expect(result2).toHaveLength(1);
    });

    it('should de-duplicate when in-flight message ID exists in queue', () => {
      const msg = createTestMessage('msg-1');
      const queuedMsg = createTestMessage('msg-2');

      // Simulate edge case: same message in both in-flight and queue
      messageQueueService.enqueue('session-1', msg);
      messageQueueService.enqueue('session-1', queuedMsg);
      messageQueueService.markInFlight('session-1', msg);

      const result = messageQueueService.getQueueWithInFlight('session-1');

      // Should have 2 messages (in-flight + msg-2), not 3
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('msg-1'); // in-flight
      expect(result[1].id).toBe('msg-2'); // from queue (msg-1 filtered out)
    });
  });

  // ---------------------------------------------------------------------------
  // Session Isolation
  // ---------------------------------------------------------------------------

  describe('session isolation', () => {
    it('should maintain separate queues for different sessions', () => {
      // Enqueue to different sessions
      messageQueueService.enqueue('session-1', createTestMessage('s1-msg-1'));
      messageQueueService.enqueue('session-1', createTestMessage('s1-msg-2'));
      messageQueueService.enqueue('session-2', createTestMessage('s2-msg-1'));
      messageQueueService.enqueue('session-3', createTestMessage('s3-msg-1'));
      messageQueueService.enqueue('session-3', createTestMessage('s3-msg-2'));
      messageQueueService.enqueue('session-3', createTestMessage('s3-msg-3'));

      expect(messageQueueService.getQueueLength('session-1')).toBe(2);
      expect(messageQueueService.getQueueLength('session-2')).toBe(1);
      expect(messageQueueService.getQueueLength('session-3')).toBe(3);

      // Dequeue from one session shouldn't affect others
      messageQueueService.dequeue('session-1');
      expect(messageQueueService.getQueueLength('session-1')).toBe(1);
      expect(messageQueueService.getQueueLength('session-2')).toBe(1);
      expect(messageQueueService.getQueueLength('session-3')).toBe(3);

      // Clear one session shouldn't affect others
      messageQueueService.clear('session-3');
      expect(messageQueueService.getQueueLength('session-1')).toBe(1);
      expect(messageQueueService.getQueueLength('session-2')).toBe(1);
      expect(messageQueueService.getQueueLength('session-3')).toBe(0);
    });
  });
});
