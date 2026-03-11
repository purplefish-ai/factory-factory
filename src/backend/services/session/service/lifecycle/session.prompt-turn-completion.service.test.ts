import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPromptTurnCompletionService } from './session.prompt-turn-completion.service';

const mockWarn = vi.fn();

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    warn: (...args: unknown[]) => mockWarn(...args),
  }),
}));

describe('SessionPromptTurnCompletionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('schedules completion callback asynchronously', async () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn().mockResolvedValue(undefined);
      const service = new SessionPromptTurnCompletionService();
      service.setHandler(handler);

      service.schedule('session-1');

      expect(handler).not.toHaveBeenCalled();
      await vi.runOnlyPendingTimersAsync();
      expect(handler).toHaveBeenCalledWith('session-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending callback for a session', async () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn().mockResolvedValue(undefined);
      const service = new SessionPromptTurnCompletionService();
      service.setHandler(handler);

      service.schedule('session-1');
      service.clearSession('session-1');

      await vi.runOnlyPendingTimersAsync();
      expect(handler).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears all scheduled callbacks when handler is removed', async () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn().mockResolvedValue(undefined);
      const service = new SessionPromptTurnCompletionService();
      service.setHandler(handler);

      service.schedule('session-1');
      service.schedule('session-2');
      service.setHandler(null);

      await vi.runOnlyPendingTimersAsync();
      expect(handler).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('swallows callback failures and logs warning', async () => {
    vi.useFakeTimers();
    try {
      const service = new SessionPromptTurnCompletionService();
      service.setHandler(vi.fn().mockRejectedValue(new Error('dispatch failed')));

      service.schedule('session-1');
      await vi.runOnlyPendingTimersAsync();

      expect(mockWarn).toHaveBeenCalledWith(
        'Prompt turn completion handler failed',
        expect.objectContaining({
          sessionId: 'session-1',
          error: 'dispatch failed',
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
