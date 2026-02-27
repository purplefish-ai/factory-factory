/**
 * Tests for the useChatWebSocket hook.
 *
 * These tests verify the hydration guard logic that prevents:
 * 1. Stale hydration messages from previous connection attempts being processed
 * 2. Chat getting stuck in loading state when unrelated messages clear retry timers
 *
 * The hook uses a loadRequestId to track the current hydration request and only
 * clears the guard when a matching response is received.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateHydrationBatch,
  parseHydrationBatch,
  scheduleConnectLoadingStart,
  shouldScheduleConnectLoading,
} from './use-chat-websocket-hydration';

// Helper type to simulate the guard state
interface GuardState {
  currentLoadRequestId: string | null;
  clearLoadTimeoutCalled: boolean;
  messageProcessed: boolean;
}

// Helper function that simulates the handleMessage logic from the hook
function createHandleMessage(guardState: GuardState) {
  return (data: unknown) => {
    const batch = parseHydrationBatch(data);
    if (batch) {
      const decision = evaluateHydrationBatch(batch, guardState.currentLoadRequestId);
      if (decision === 'drop') {
        return;
      }
      if (decision === 'match') {
        guardState.currentLoadRequestId = null;
        guardState.clearLoadTimeoutCalled = true;
      }
    }
    guardState.messageProcessed = true;
  };
}

describe('useChatWebSocket hydration guard logic', () => {
  describe('connect loading strategy', () => {
    it('schedules loading when session has not hydrated yet', () => {
      expect(shouldScheduleConnectLoading(false)).toBe(true);
    });

    it('does not schedule loading when session already hydrated', () => {
      expect(shouldScheduleConnectLoading(true)).toBe(false);
    });

    it('debounces loading start and allows cancellation', () => {
      let startCount = 0;
      const cancel = scheduleConnectLoadingStart({
        hasHydratedSession: false,
        onLoadingStart: () => {
          startCount += 1;
        },
        debounceMs: 25,
      });

      expect(startCount).toBe(0);
      cancel();

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(startCount).toBe(0);
          resolve();
        }, 35);
      });
    });
  });

  describe('handleMessage hydration guard', () => {
    it('should clear guard when session_snapshot has matching loadRequestId', () => {
      const guardState: GuardState = {
        currentLoadRequestId: 'load-123',
        clearLoadTimeoutCalled: false,
        messageProcessed: false,
      };
      const handleMessage = createHandleMessage(guardState);

      handleMessage({ type: 'session_snapshot', loadRequestId: 'load-123' });

      expect(guardState.currentLoadRequestId).toBe(null);
      expect(guardState.clearLoadTimeoutCalled).toBe(true);
    });

    it('should clear guard when session_replay_batch has matching loadRequestId', () => {
      const guardState: GuardState = {
        currentLoadRequestId: 'load-456',
        clearLoadTimeoutCalled: false,
        messageProcessed: false,
      };
      const handleMessage = createHandleMessage(guardState);

      handleMessage({ type: 'session_replay_batch', loadRequestId: 'load-456' });

      expect(guardState.currentLoadRequestId).toBe(null);
      expect(guardState.clearLoadTimeoutCalled).toBe(true);
    });

    it('should NOT clear guard when session_snapshot lacks loadRequestId (bug fix)', () => {
      const guardState: GuardState = {
        currentLoadRequestId: 'load-123',
        clearLoadTimeoutCalled: false,
        messageProcessed: false,
      };
      const handleMessage = createHandleMessage(guardState);

      // This simulates an unrelated snapshot (e.g., from enqueuing a message)
      handleMessage({ type: 'session_snapshot' });

      // Guard should NOT be cleared
      expect(guardState.currentLoadRequestId).toBe('load-123');
      expect(guardState.clearLoadTimeoutCalled).toBe(false);
    });

    it('should NOT clear guard when session_replay_batch lacks loadRequestId (bug fix)', () => {
      const guardState: GuardState = {
        currentLoadRequestId: 'load-456',
        clearLoadTimeoutCalled: false,
        messageProcessed: false,
      };
      const handleMessage = createHandleMessage(guardState);

      // This simulates an unrelated replay batch
      handleMessage({ type: 'session_replay_batch' });

      // Guard should NOT be cleared
      expect(guardState.currentLoadRequestId).toBe('load-456');
      expect(guardState.clearLoadTimeoutCalled).toBe(false);
    });

    it('should reject stale messages with non-matching loadRequestId', () => {
      const guardState: GuardState = {
        currentLoadRequestId: 'load-123',
        clearLoadTimeoutCalled: false,
        messageProcessed: false,
      };
      const handleMessage = createHandleMessage(guardState);

      // This simulates a stale message from a previous connection attempt
      handleMessage({ type: 'session_snapshot', loadRequestId: 'load-000' });

      // Guard should NOT be cleared and message should be rejected
      expect(guardState.currentLoadRequestId).toBe('load-123');
      expect(guardState.clearLoadTimeoutCalled).toBe(false);
      expect(guardState.messageProcessed).toBe(false);
    });

    it('should reject hydration responses with loadRequestId when guard is not set', () => {
      const guardState: GuardState = {
        currentLoadRequestId: null,
        clearLoadTimeoutCalled: false,
        messageProcessed: false,
      };
      const handleMessage = createHandleMessage(guardState);

      // Late load responses should be ignored once hydration has completed
      handleMessage({ type: 'session_snapshot', loadRequestId: 'load-999' });

      expect(guardState.currentLoadRequestId).toBe(null);
      expect(guardState.clearLoadTimeoutCalled).toBe(false);
      expect(guardState.messageProcessed).toBe(false);
    });

    it('should allow non-hydration snapshots when guard is not set', () => {
      const guardState: GuardState = {
        currentLoadRequestId: null,
        clearLoadTimeoutCalled: false,
        messageProcessed: false,
      };
      const handleMessage = createHandleMessage(guardState);

      handleMessage({ type: 'session_snapshot' });

      expect(guardState.currentLoadRequestId).toBe(null);
      expect(guardState.clearLoadTimeoutCalled).toBe(false);
      expect(guardState.messageProcessed).toBe(true);
    });

    it('should handle non-hydration messages without affecting guard', () => {
      const guardState: GuardState = {
        currentLoadRequestId: 'load-123',
        clearLoadTimeoutCalled: false,
        messageProcessed: false,
      };
      const handleMessage = createHandleMessage(guardState);

      // Other message types should pass through without affecting guard
      handleMessage({ type: 'status_update', status: 'idle' });

      expect(guardState.currentLoadRequestId).toBe('load-123');
      expect(guardState.clearLoadTimeoutCalled).toBe(false);
      expect(guardState.messageProcessed).toBe(true);
    });
  });
});
