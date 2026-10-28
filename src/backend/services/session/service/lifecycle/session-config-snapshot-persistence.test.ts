import { expect, it, vi } from 'vitest';
import { configOptions, setupAuthority } from './session-config-authority.test-helpers';
import { SessionConfigSnapshotPersistence } from './session-config-snapshot-persistence';

vi.mock('@/backend/services/settings', () => ({ userSettingsService: {} }));

it('stores the supplied accepted snapshot independently of pending runtime configuration', async () => {
  const h = setupAuthority();
  h.handle.deferPromptReadiness();
  const ready = h.handle.configurationReady;
  h.handle.configOptions = configOptions('third');
  const complete = vi.spyOn(h.handle, 'completeConfiguration');
  const snapshots = new SessionConfigSnapshotPersistence(h.repository);
  await snapshots.persist('session', {
    provider: 'CODEX',
    providerSessionId: 'thread',
    configOptions: configOptions('first'),
  });
  expect(h.row().model).toBe('first');
  expect(h.handle.configOptions.find((option) => option.id === 'model')?.currentValue).toBe(
    'third'
  );
  expect(h.handle.configurationReady).toBe(ready);
  expect(complete).not.toHaveBeenCalled();
});
