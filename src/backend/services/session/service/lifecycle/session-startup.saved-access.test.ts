import { expect, it, vi } from 'vitest';
import { createLifecycleHarness } from './session-lifecycle.test-helpers';

it('keeps Claude native access authoritative over the legacy non-interactive bypass preset', async () => {
  const h = createLifecycleHarness({ provider: 'CLAUDE' });
  await h.service.startSession(h.session.id, {
    initialPrompt: '',
    startupModePreset: 'non_interactive',
  });
  expect(h.sessionConfigService.applyStartupModePreset).not.toHaveBeenCalled();
  expect(h.sessionConfigService.applyConfiguredPermissionPreset).toHaveBeenCalledOnce();
});

it.each(['start', 'acquire'] as const)(
  'enforces native access before %s snapshot persistence and notification recovery',
  async (path) => {
    const h = createLifecycleHarness();
    let applied = false;
    h.sessionConfigService.applyConfiguredPermissionPreset.mockImplementation(() => {
      applied = true;
      return Promise.resolve();
    });
    h.sessionConfigService.persistAcpConfigSnapshot.mockImplementation(() => {
      expect(applied).toBe(true);
      return Promise.resolve();
    });
    h.notificationDeliveryService.recoverPending = vi.fn(() => {
      expect(applied).toBe(true);
      return Promise.resolve({ dispatchableCount: 0 });
    });
    if (path === 'start') {
      await h.service.startSession(h.session.id, { initialPrompt: '' });
    } else {
      await h.service.getOrCreateSessionClient(h.session.id);
    }
    expect(h.sessionConfigService.applyConfiguredPermissionPreset).toHaveBeenCalledOnce();
  }
);
