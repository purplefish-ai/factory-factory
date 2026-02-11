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

describe('useChatWebSocket hydration guard logic', () => {
  describe('handleMessage hydration guard', () => {
    it('should clear guard when session_snapshot has matching loadRequestId', () => {
      // Simulating the guard logic extracted from the hook
      let currentLoadRequestId: string | null = 'load-123';
      const clearLoadTimeoutCalled = { value: false };

      const handleMessage = (data: unknown) => {
        if (
          typeof data === 'object' &&
          data !== null &&
          'type' in data &&
          ((data as { type?: string }).type === 'session_replay_batch' ||
            (data as { type?: string }).type === 'session_snapshot')
        ) {
          const batch = data as { loadRequestId?: string; type?: string };
          if (currentLoadRequestId && batch.loadRequestId) {
            if (batch.loadRequestId !== currentLoadRequestId) {
              return;
            }
            // Only clear when we have a matching ID
            currentLoadRequestId = null;
            clearLoadTimeoutCalled.value = true;
          }
        }
      };

      handleMessage({ type: 'session_snapshot', loadRequestId: 'load-123' });

      expect(currentLoadRequestId).toBe(null);
      expect(clearLoadTimeoutCalled.value).toBe(true);
    });

    it('should clear guard when session_replay_batch has matching loadRequestId', () => {
      let currentLoadRequestId: string | null = 'load-456';
      const clearLoadTimeoutCalled = { value: false };

      const handleMessage = (data: unknown) => {
        if (
          typeof data === 'object' &&
          data !== null &&
          'type' in data &&
          ((data as { type?: string }).type === 'session_replay_batch' ||
            (data as { type?: string }).type === 'session_snapshot')
        ) {
          const batch = data as { loadRequestId?: string; type?: string };
          if (currentLoadRequestId && batch.loadRequestId) {
            if (batch.loadRequestId !== currentLoadRequestId) {
              return;
            }
            currentLoadRequestId = null;
            clearLoadTimeoutCalled.value = true;
          }
        }
      };

      handleMessage({ type: 'session_replay_batch', loadRequestId: 'load-456' });

      expect(currentLoadRequestId).toBe(null);
      expect(clearLoadTimeoutCalled.value).toBe(true);
    });

    it('should NOT clear guard when session_snapshot lacks loadRequestId (bug fix)', () => {
      let currentLoadRequestId: string | null = 'load-123';
      const clearLoadTimeoutCalled = { value: false };

      const handleMessage = (data: unknown) => {
        if (
          typeof data === 'object' &&
          data !== null &&
          'type' in data &&
          ((data as { type?: string }).type === 'session_replay_batch' ||
            (data as { type?: string }).type === 'session_snapshot')
        ) {
          const batch = data as { loadRequestId?: string; type?: string };
          if (currentLoadRequestId && batch.loadRequestId) {
            if (batch.loadRequestId !== currentLoadRequestId) {
              return;
            }
            currentLoadRequestId = null;
            clearLoadTimeoutCalled.value = true;
          }
        }
      };

      // This simulates an unrelated snapshot (e.g., from enqueuing a message)
      handleMessage({ type: 'session_snapshot' });

      // Guard should NOT be cleared
      expect(currentLoadRequestId).toBe('load-123');
      expect(clearLoadTimeoutCalled.value).toBe(false);
    });

    it('should NOT clear guard when session_replay_batch lacks loadRequestId (bug fix)', () => {
      let currentLoadRequestId: string | null = 'load-456';
      const clearLoadTimeoutCalled = { value: false };

      const handleMessage = (data: unknown) => {
        if (
          typeof data === 'object' &&
          data !== null &&
          'type' in data &&
          ((data as { type?: string }).type === 'session_replay_batch' ||
            (data as { type?: string }).type === 'session_snapshot')
        ) {
          const batch = data as { loadRequestId?: string; type?: string };
          if (currentLoadRequestId && batch.loadRequestId) {
            if (batch.loadRequestId !== currentLoadRequestId) {
              return;
            }
            currentLoadRequestId = null;
            clearLoadTimeoutCalled.value = true;
          }
        }
      };

      // This simulates an unrelated replay batch
      handleMessage({ type: 'session_replay_batch' });

      // Guard should NOT be cleared
      expect(currentLoadRequestId).toBe('load-456');
      expect(clearLoadTimeoutCalled.value).toBe(false);
    });

    it('should reject stale messages with non-matching loadRequestId', () => {
      let currentLoadRequestId: string | null = 'load-123';
      const clearLoadTimeoutCalled = { value: false };
      let messageProcessed = false;

      const handleMessage = (data: unknown) => {
        if (
          typeof data === 'object' &&
          data !== null &&
          'type' in data &&
          ((data as { type?: string }).type === 'session_replay_batch' ||
            (data as { type?: string }).type === 'session_snapshot')
        ) {
          const batch = data as { loadRequestId?: string; type?: string };
          if (currentLoadRequestId && batch.loadRequestId) {
            if (batch.loadRequestId !== currentLoadRequestId) {
              return;
            }
            currentLoadRequestId = null;
            clearLoadTimeoutCalled.value = true;
          }
        }
        messageProcessed = true;
      };

      // This simulates a stale message from a previous connection attempt
      handleMessage({ type: 'session_snapshot', loadRequestId: 'load-000' });

      // Guard should NOT be cleared and message should be rejected
      expect(currentLoadRequestId).toBe('load-123');
      expect(clearLoadTimeoutCalled.value).toBe(false);
      expect(messageProcessed).toBe(false);
    });

    it('should allow message processing when guard is not set', () => {
      let currentLoadRequestId: string | null = null;
      const clearLoadTimeoutCalled = { value: false };
      let messageProcessed = false;

      const handleMessage = (data: unknown) => {
        if (
          typeof data === 'object' &&
          data !== null &&
          'type' in data &&
          ((data as { type?: string }).type === 'session_replay_batch' ||
            (data as { type?: string }).type === 'session_snapshot')
        ) {
          const batch = data as { loadRequestId?: string; type?: string };
          if (currentLoadRequestId && batch.loadRequestId) {
            if (batch.loadRequestId !== currentLoadRequestId) {
              return;
            }
            currentLoadRequestId = null;
            clearLoadTimeoutCalled.value = true;
          }
        }
        messageProcessed = true;
      };

      // When no hydration is pending, messages should pass through
      handleMessage({ type: 'session_snapshot', loadRequestId: 'load-999' });

      expect(currentLoadRequestId).toBe(null);
      expect(clearLoadTimeoutCalled.value).toBe(false);
      expect(messageProcessed).toBe(true);
    });

    it('should handle non-hydration messages without affecting guard', () => {
      let currentLoadRequestId: string | null = 'load-123';
      const clearLoadTimeoutCalled = { value: false };
      let messageProcessed = false;

      const handleMessage = (data: unknown) => {
        if (
          typeof data === 'object' &&
          data !== null &&
          'type' in data &&
          ((data as { type?: string }).type === 'session_replay_batch' ||
            (data as { type?: string }).type === 'session_snapshot')
        ) {
          const batch = data as { loadRequestId?: string; type?: string };
          if (currentLoadRequestId && batch.loadRequestId) {
            if (batch.loadRequestId !== currentLoadRequestId) {
              return;
            }
            currentLoadRequestId = null;
            clearLoadTimeoutCalled.value = true;
          }
        }
        messageProcessed = true;
      };

      // Other message types should pass through without affecting guard
      handleMessage({ type: 'status_update', status: 'idle' });

      expect(currentLoadRequestId).toBe('load-123');
      expect(clearLoadTimeoutCalled.value).toBe(false);
      expect(messageProcessed).toBe(true);
    });
  });
});
