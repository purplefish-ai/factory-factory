import { describe, expect, it, vi } from 'vitest';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { configOptions, setupAuthority } from './session-config-authority.test-helpers';
import { SessionConfigSnapshotPersistence } from './session-config-snapshot-persistence';
import { readSessionLaunchSettings } from './session-launch-settings';

vi.mock('@/backend/services/settings', () => ({ userSettingsService: {} }));

describe('server review configuration contracts', () => {
  it('rejects public storage failure after native confirmation and publishes only the current correction', async () => {
    const h = setupAuthority();
    h.hooks.cas = () => Promise.reject(new Error('database unavailable'));
    await expect(h.service.setSessionModel('session', 'second')).rejects.toThrow(
      'database unavailable'
    );
    expect(h.handle.configOptions.find((option) => option.id === 'model')?.currentValue).toBe(
      'second'
    );
    expect(h.casModels).toEqual(['second', 'second']);
    expect(h.row().model).toBe('first');
    expect(h.models()).toEqual(['second']);
    expect(h.events.filter((event) => event.type === 'chat_capabilities')).toEqual([]);
  });

  it('rejects exhausted storage failure and propagates source guard errors', async () => {
    const h = setupAuthority();
    h.hooks.cas = () => Promise.reject(new Error('database unavailable'));
    const snapshots = new SessionConfigSnapshotPersistence(h.repository);
    const params = {
      provider: 'CODEX' as const,
      providerSessionId: 'thread',
      configOptions: configOptions('second'),
    };
    await expect(snapshots.persist('session', params)).rejects.toThrow('database unavailable');
    expect(h.casModels).toHaveLength(2);
    const sourceError = new Error('runtime replaced');
    await expect(
      snapshots.persist('session', {
        ...params,
        assertCurrent: () => {
          throw sourceError;
        },
      })
    ).rejects.toBe(sourceError);
    expect(h.casModels).toHaveLength(2);
  });

  it('rejects empty required native configuration before any repository I/O', async () => {
    const h = setupAuthority();
    const snapshots = new SessionConfigSnapshotPersistence(h.repository);
    await expect(
      snapshots.persist('session', {
        provider: 'CODEX',
        providerSessionId: 'thread',
        configOptions: [],
        requirePersistence: true,
      })
    ).rejects.toThrow('Cannot finalize startup without native configuration');
    expect(h.accessor.findById).not.toHaveBeenCalled();
    expect(h.accessor.updateIfProviderIdentity).not.toHaveBeenCalled();
    expect(h.accessor.update).not.toHaveBeenCalled();
  });

  it('does not issue an optional preset RPC against a replacement runtime', async () => {
    const h = setupAuthority();
    const replacement = createTestProcessHandle({ provider: 'CODEX', providerSessionId: 'thread' });
    replacement.configOptions = configOptions('third');
    h.runtime.getClient.mockReturnValue(replacement);
    await expect(
      h.service.applyStartupModePreset('session', h.handle, 'plan', 'code')
    ).rejects.toThrow('Session runtime changed');
    expect(h.runtime.setConfigOption).not.toHaveBeenCalled();
    expect(h.runtime.setSessionMode).not.toHaveBeenCalled();
    expect(
      replacement.configOptions.find((option) => option.id === 'collaboration_mode')?.currentValue
    ).toBe('default');
    expect(h.models()).toEqual([]);
  });

  it('persists an applied-history stopped edit in the snapshot without rewriting consumed launch history', async () => {
    const h = setupAuthority();
    await h.accessor.update('session', {
      providerMetadata: unsafeCoerce({
        launchSettings: { reasoningEffort: 'low', planModeEnabled: false, applied: true },
        acpConfigSnapshot: {
          provider: 'CODEX',
          providerSessionId: 'thread',
          capturedAt: new Date(0).toISOString(),
          configOptions: configOptions('first'),
        },
      }),
    });
    h.runtime.getClient.mockReturnValue(undefined);
    await h.service.setSessionConfigOption('session', 'reasoning_effort', 'high');
    expect(readSessionLaunchSettings(h.row().providerMetadata)).toEqual({
      reasoningEffort: 'low',
      planModeEnabled: false,
      applied: true,
    });
    expect(h.row().providerMetadata).toMatchObject({
      acpConfigSnapshot: {
        configOptions: expect.arrayContaining([
          expect.objectContaining({ id: 'reasoning_effort', currentValue: 'high' }),
        ]),
      },
    });
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'config_options_update',
        configOptions: expect.arrayContaining([
          expect.objectContaining({ id: 'reasoning_effort', currentValue: 'high' }),
        ]),
      })
    );
  });
});
