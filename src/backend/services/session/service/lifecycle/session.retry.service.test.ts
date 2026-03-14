import { describe, expect, it, vi } from 'vitest';
import { SessionRetryService } from './session.retry.service';

const mockWarn = vi.fn();

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    warn: (...args: unknown[]) => mockWarn(...args),
  }),
}));

describe('SessionRetryService', () => {
  it('retries failed operations until one succeeds', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValueOnce('ok');
    const service = new SessionRetryService();

    const result = await service.run(operation, {
      attempts: 2,
      operationName: 'load session for stop',
      context: { sessionId: 'session-1' },
    });

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(mockWarn).toHaveBeenCalledWith(
      'Session operation failed; retrying',
      expect.objectContaining({
        operationName: 'load session for stop',
        attempt: 1,
        maxAttempts: 2,
        sessionId: 'session-1',
        error: 'first fail',
      })
    );
  });

  it('throws the final error after exhausting attempts', async () => {
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('always fails'));
    const service = new SessionRetryService();

    await expect(
      service.run(operation, {
        attempts: 2,
        operationName: 'update stopped session state',
        context: { sessionId: 'session-1' },
      })
    ).rejects.toThrow('always fails');

    expect(operation).toHaveBeenCalledTimes(2);
  });
});
