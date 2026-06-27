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
  evaluateLoadSessionRetry,
  parseHydrationBatch,
  scheduleConnectLoadingStart,
  shouldScheduleConnectLoading,
} from './use-chat-websocket-hydration';

// Helper type to simulate the guard state
interface GuardState {
  currentLoadRequestId: string | null;
  exhaustedLoadRequestId?: string | null;
  clearLoadTimeoutCalled: boolean;
  messageProcessed: boolean;
}

// Helper function that simulates the handleMessage logic from the hook
function createHandleMessage(guardState: GuardState) {
  return (data: unknown) => {
    const batch = parseHydrationBatch(data);
    if (batch) {
      const decision = evaluateHydrationBatch(
        batch,
        guardState.currentLoadRequestId,
        guardState.exhaustedLoadRequestId ?? null
      );
      if (decision === 'drop') {
        return;
      }
      if (decision === 'match') {
        guardState.currentLoadRequestId = null;
        guardState.exhaustedLoadRequestId = null;
        guardState.clearLoadTimeoutCalled = true;
      } else {
        guardState.exhaustedLoadRequestId = null;
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

    it('should accept a late matching hydration response after retry exhaustion', () => {
      const guardState: GuardState = {
        currentLoadRequestId: null,
        exhaustedLoadRequestId: 'load-123',
        clearLoadTimeoutCalled: false,
        messageProcessed: false,
      };
      const handleMessage = createHandleMessage(guardState);

      handleMessage({ type: 'session_snapshot', loadRequestId: 'load-123' });

      expect(guardState.currentLoadRequestId).toBe(null);
      expect(guardState.exhaustedLoadRequestId).toBe(null);
      expect(guardState.clearLoadTimeoutCalled).toBe(true);
      expect(guardState.messageProcessed).toBe(true);
    });

    it('should reject unrelated load responses after retry exhaustion', () => {
      const guardState: GuardState = {
        currentLoadRequestId: null,
        exhaustedLoadRequestId: 'load-123',
        clearLoadTimeoutCalled: false,
        messageProcessed: false,
      };
      const handleMessage = createHandleMessage(guardState);

      handleMessage({ type: 'session_snapshot', loadRequestId: 'load-999' });

      expect(guardState.currentLoadRequestId).toBe(null);
      expect(guardState.exhaustedLoadRequestId).toBe('load-123');
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

    it('should close exhausted-load acceptance after an untagged hydration batch passes', () => {
      const guardState: GuardState = {
        currentLoadRequestId: null,
        exhaustedLoadRequestId: 'load-123',
        clearLoadTimeoutCalled: false,
        messageProcessed: false,
      };
      const handleMessage = createHandleMessage(guardState);

      handleMessage({ type: 'session_snapshot' });

      expect(guardState.exhaustedLoadRequestId).toBe(null);
      expect(guardState.messageProcessed).toBe(true);

      guardState.messageProcessed = false;
      handleMessage({ type: 'session_replay_batch', loadRequestId: 'load-123' });

      expect(guardState.messageProcessed).toBe(false);
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

  describe('load_session retry strategy', () => {
    it('keeps retrying the active hydration request while attempts remain', () => {
      expect(
        evaluateLoadSessionRetry({
          loadGeneration: 2,
          currentLoadGeneration: 2,
          loadRequestId: 'load-123',
          currentLoadRequestId: 'load-123',
          retryAttempt: 1,
          maxRetryAttempts: 3,
        })
      ).toBe('retry');
    });

    it('stops retrying when a newer load generation starts', () => {
      expect(
        evaluateLoadSessionRetry({
          loadGeneration: 2,
          currentLoadGeneration: 3,
          loadRequestId: 'load-123',
          currentLoadRequestId: 'load-123',
          retryAttempt: 1,
          maxRetryAttempts: 3,
        })
      ).toBe('stale');
    });

    it('stops retrying when the active request has already completed', () => {
      expect(
        evaluateLoadSessionRetry({
          loadGeneration: 2,
          currentLoadGeneration: 2,
          loadRequestId: 'load-123',
          currentLoadRequestId: null,
          retryAttempt: 1,
          maxRetryAttempts: 3,
        })
      ).toBe('stale');
    });

    it('stops retrying after the configured retry limit', () => {
      expect(
        evaluateLoadSessionRetry({
          loadGeneration: 2,
          currentLoadGeneration: 2,
          loadRequestId: 'load-123',
          currentLoadRequestId: 'load-123',
          retryAttempt: 4,
          maxRetryAttempts: 3,
        })
      ).toBe('exhausted');
    });

    it('ends loading on retry exhaustion and clears the guard for routine snapshots', () => {
      const guardState: GuardState = {
        currentLoadRequestId: 'load-123',
        clearLoadTimeoutCalled: false,
        messageProcessed: false,
      };
      let loadingEnded = false;

      const retryDecision = evaluateLoadSessionRetry({
        loadGeneration: 2,
        currentLoadGeneration: 2,
        loadRequestId: 'load-123',
        currentLoadRequestId: guardState.currentLoadRequestId,
        retryAttempt: 4,
        maxRetryAttempts: 3,
      });
      if (retryDecision === 'exhausted') {
        loadingEnded = true;
        guardState.exhaustedLoadRequestId = guardState.currentLoadRequestId;
        guardState.currentLoadRequestId = null;
      }

      createHandleMessage(guardState)({ type: 'session_snapshot' });

      expect(loadingEnded).toBe(true);
      expect(guardState.currentLoadRequestId).toBe(null);
      expect(guardState.messageProcessed).toBe(true);
    });
  });
});
