import { expect, it, vi } from 'vitest';
import { setupStartupConfig } from './session-startup-config.test-helpers';

vi.mock('@/backend/services/settings', () => ({ userSettingsService: {} }));

it('finishes two current finalizers for the same shared handle within a bounded write budget', async () => {
  const h = setupStartupConfig();
  h.runtimeManager.getClient.mockReturnValue(h.handle);
  h.hooks.cas = (number) => {
    if (number > 12) {
      h.runtimeManager.getClient.mockImplementation(() => {
        throw new Error('current finalizers keep superseding each other');
      });
      return Promise.reject(new Error('current finalizers keep superseding each other'));
    }
    return Promise.resolve();
  };
  const completed = [vi.fn(), vi.fn()];
  const outcomes = await Promise.all(
    completed.map((complete) =>
      h.config
        .completeStartupConfiguration(h.session.id, {
          handle: h.handle,
          assertCurrent: () => {
            if (h.runtimeManager.getClient(h.session.id) !== h.handle) {
              throw new Error('Session runtime changed during configuration');
            }
          },
          beforeComplete: () => Promise.resolve(),
          complete,
        })
        .catch((error) => error)
    )
  );
  expect(outcomes).toEqual([undefined, undefined]);
  expect(completed[0]).toHaveBeenCalledOnce();
  expect(completed[1]).toHaveBeenCalledOnce();
  expect(h.accessor.updateIfProviderIdentity.mock.calls.length).toBeLessThanOrEqual(4);
  expect(h.row().model).toBe('first');
});
