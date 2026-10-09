import { afterEach, expect, it, vi } from 'vitest';
import { recipientCanDispatch } from './pr-delivery-readiness';
afterEach(() => vi.useRealTimers());
it('fails closed within five seconds when the recipient lookup stalls', async () => {
  vi.useFakeTimers();
  const services = {
    acpRuntimeManager: { isSessionWorking: vi.fn(() => false) },
    sessionDataService: {
      findAgentSessionsByWorkspaceId: vi.fn(
        () =>
          new Promise<never>(() => {
            /* Simulate a stalled query. */
          })
      ),
    },
  };
  const pending = recipientCanDispatch('w', 'main', services);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it('fails closed on query failure and blocks another working session', async () => {
  const query = vi
    .fn()
    .mockRejectedValueOnce(new Error('database unavailable'))
    .mockResolvedValueOnce([{ id: 'other' }]);
  const services = {
    sessionDataService: {
      findAgentSessionsByWorkspaceId: query,
    },
    acpRuntimeManager: {
      isSessionWorking: vi.fn(() => true),
    },
  };
  expect(await recipientCanDispatch('w', 'main', services)).toBe(false);
  expect(await recipientCanDispatch('w', 'main', services)).toBe(false);
});
