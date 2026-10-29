import { describe, expect, it, vi } from 'vitest';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { gate, settleConfig } from './session-config-authority.test-helpers';
import { createSessionLaunchMetadata, readSessionLaunchSettings } from './session-launch-settings';
import { setupStartupConfig, startupConfigOptions } from './session-startup-config.test-helpers';

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: { findById: vi.fn() },
  workspaceNotificationService: {
    listPendingForDelivery: vi.fn(() => Promise.resolve([])),
    findForDelivery: vi.fn(() => Promise.resolve(null)),
    markDelivered: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('@/backend/services/settings', () => ({
  userSettingsService: { get: vi.fn(async () => ({})) },
}));

function setupLaunch(provider: 'CLAUDE' | 'CODEX' = 'CODEX', enabled = true) {
  const h = setupStartupConfig(provider);
  if (provider === 'CLAUDE') {
    h.handle.configOptions = startupConfigOptions('first')
      .filter((option) => option.id !== 'collaboration_mode')
      .map((option) =>
        option.id === 'mode' && option.type === 'select'
          ? {
              ...option,
              currentValue: 'default',
              options: ['default', 'plan', 'acceptEdits', 'bypassPermissions'].map((value) => ({
                value,
                name: value,
              })),
            }
          : option
      );
  }
  h.setSession({
    providerMetadata: unsafeCoerce(
      createSessionLaunchMetadata({ reasoningEffort: 'high', planModeEnabled: enabled })
    ),
  });
  const observe = (patch: {
    mode?: string;
    planning?: string;
    effort?: string;
    model?: string;
  }) => {
    const values: Record<string, string | undefined> = {
      mode: patch.mode,
      collaboration_mode: patch.planning,
      reasoning_effort: patch.effort,
      model: patch.model,
    };
    h.config.applyConfigOptionsUpdateDelta(
      h.session.id,
      h.handle,
      h.handle.configOptions.map((option) =>
        option.type === 'select'
          ? { ...option, currentValue: values[option.id] ?? option.currentValue }
          : option
      )
    );
  };
  return { ...h, observe };
}

describe('integrated mandatory native launch authority', () => {
  it.each(['CLAUDE', 'CODEX'] as const)(
    'persists exact %s thinking and Plan with consumed intent before first prompt',
    async (provider) => {
      const h = setupLaunch(provider);
      await h.service.startSession(h.session.id, { initialPrompt: 'Do work' });
      expect(readSessionLaunchSettings(h.row().providerMetadata)).toEqual({
        reasoningEffort: 'high',
        planModeEnabled: true,
        applied: true,
      });
      expect(h.row().providerMetadata).toMatchObject({
        acpConfigSnapshot: {
          configOptions: expect.arrayContaining([
            expect.objectContaining({ id: 'reasoning_effort', currentValue: 'high' }),
            expect.objectContaining({
              id: provider === 'CLAUDE' ? 'mode' : 'collaboration_mode',
              currentValue: 'plan',
            }),
          ]),
        },
      });
      expect(h.complete).toHaveBeenCalledOnce();
      expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(h.session.id, 'Do work');
      expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
    }
  );

  it.each(['on', 'off'] as const)(
    'authorizes mandatory Claude Plan %s over saved access in strict existing acquisition',
    async (direction) => {
      const h = setupLaunch('CLAUDE', direction === 'on');
      if (direction === 'off') {
        h.observe({ mode: 'plan' });
      }
      h.setSession({
        providerMetadata: unsafeCoerce({
          ...createSessionLaunchMetadata({ planModeEnabled: direction === 'on' }),
          acpConfigSnapshot: {
            provider: 'CLAUDE',
            providerSessionId: 'thread',
            capturedAt: new Date(0).toISOString(),
            configOptions: h.handle.configOptions,
          },
        }),
      });
      await expect(
        h.service.getOrCreateSessionClient(h.session.id, { resumePolicy: 'require_existing' })
      ).resolves.toBe(h.handle);
      expect(h.handle.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
        direction === 'on' ? 'plan' : 'default'
      );
      expect(h.complete).toHaveBeenCalledOnce();
      expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
      expect(readSessionLaunchSettings(h.row().providerMetadata)?.applied).toBe(true);
    }
  );

  it.each(['plan-model', 'effort-model', 'plan-mismatch', 'effort-mismatch'] as const)(
    'uses the installed current handle after the %s RPC continuation',
    async (phase) => {
      const h = setupLaunch(phase.startsWith('plan') ? 'CLAUDE' : 'CODEX');
      if (phase.startsWith('plan')) {
        h.runtime.setSessionMode.mockImplementationOnce(async (id, value) => {
          const retained = await h.controller.setSessionMode(h.handle, value, id);
          h.observe(phase === 'plan-model' ? { model: 'third' } : { mode: 'bypassPermissions' });
          return retained;
        });
      } else {
        h.runtime.setConfigOption.mockImplementationOnce(async (id, key, value) => {
          const retained = await h.controller.setConfigOption(h.handle, key, value, id);
          h.observe(phase === 'effort-model' ? { model: 'third' } : { effort: 'low' });
          return retained;
        });
      }
      const result = await h.service
        .startSession(h.session.id, { initialPrompt: 'Do work' })
        .catch((error) => error);
      await settleConfig();
      if (phase.endsWith('model')) {
        expect(result).toBeUndefined();
        expect(h.row().model).toBe('third');
        expect(h.handle.configOptions.find((option) => option.id === 'model')?.currentValue).toBe(
          'third'
        );
        expect(h.complete).toHaveBeenCalledOnce();
      } else {
        expect(result).toBeInstanceOf(Error);
        expect(h.complete).not.toHaveBeenCalled();
        expect(h.sendSessionMessage).not.toHaveBeenCalled();
        expect(h.runtimeManager.stopClient).toHaveBeenCalledExactlyOnceWith(h.session.id);
      }
    }
  );

  it.each(['plan', 'effort'] as const)(
    'fails a shared candidate if mandatory %s changes during the final async check',
    async (target) => {
      const h = setupLaunch();
      h.runtimeManager.runClientCreationOperation.mockImplementation((_id, _purpose, operation) =>
        operation({ isOnlyOperation: () => false })
      );
      let injected = false;
      const result = await h.service
        .startSession(h.session.id, {
          initialPrompt: 'Do work',
          assertCurrent: () => {
            if (
              !injected &&
              h.accessor.updateIfProviderIdentity.mock.calls.length &&
              !h.complete.mock.calls.length
            ) {
              injected = true;
              queueMicrotask(() =>
                h.observe(target === 'plan' ? { planning: 'default' } : { effort: 'low' })
              );
            }
            return Promise.resolve();
          },
        })
        .catch((error) => error);
      await settleConfig();
      expect(injected).toBe(true);
      expect(result).toBeInstanceOf(Error);
      expect(h.complete).not.toHaveBeenCalled();
      expect(h.fail).toHaveBeenCalledOnce();
      expect(h.sendSessionMessage).not.toHaveBeenCalled();
      expect(h.runtimeManager.stopClient).toHaveBeenCalledExactlyOnceWith(h.session.id);
    }
  );

  it.each(['plan', 'effort'] as const)(
    'stops a shared candidate on mandatory %s RPC failure, even after target confirmation',
    async (target) => {
      const h = setupLaunch('CLAUDE');
      h.runtimeManager.runClientCreationOperation.mockImplementation((_id, _purpose, operation) =>
        operation({ isOnlyOperation: () => false })
      );
      if (target === 'plan') {
        h.runtime.setSessionMode.mockImplementationOnce(async (id, value) => {
          await h.controller.setSessionMode(h.handle, value, id);
          throw new Error('mandatory plan rejected');
        });
      } else {
        h.runtime.setConfigOption.mockImplementationOnce(async (id, key, value) => {
          await h.controller.setConfigOption(h.handle, key, value, id);
          throw new Error('mandatory effort rejected');
        });
      }
      const result = await h.service
        .startSession(h.session.id, { initialPrompt: 'Do work' })
        .catch((error) => error);
      expect(result).toBeInstanceOf(Error);
      expect(h.complete).not.toHaveBeenCalled();
      expect(h.fail).toHaveBeenCalledOnce();
      expect(h.runtimeManager.stopClient).toHaveBeenCalledExactlyOnceWith(h.session.id);
      expect(readSessionLaunchSettings(h.row().providerMetadata)?.applied).toBe(false);
    }
  );

  it('retains mandatory consumed launch intent through current-state recapture and a final retry', async () => {
    const h = setupLaunch();
    const first = gate();
    let failed = false;
    h.hooks.cas = async (number) => {
      if (number === 1) {
        await first.wait();
      } else if (!failed) {
        failed = true;
        throw new Error('transient final write');
      }
    };
    const starting = h.service.startSession(h.session.id, { initialPrompt: 'Do work' });
    await first.started;
    h.observe({ model: 'third' });
    first.release();
    await starting;
    await settleConfig();
    expect(h.row().model).toBe('third');
    expect(readSessionLaunchSettings(h.row().providerMetadata)).toEqual({
      reasoningEffort: 'high',
      planModeEnabled: true,
      applied: true,
    });
    expect(h.complete).toHaveBeenCalledOnce();
  });

  it('rejects mandatory Plan-off for reviewers', async () => {
    const h = setupLaunch('CLAUDE', false);
    h.setSession({ workflow: ADVERSARIAL_REVIEW_WORKFLOW });
    await expect(
      h.service.startSession(h.session.id, { initialPrompt: 'Do work' })
    ).rejects.toThrow('read-only');
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.sendSessionMessage).not.toHaveBeenCalled();
  });
});

it.each([
  { provider: 'CODEX' as const, mode: 'read-only' },
  { provider: 'CODEX' as const, mode: 'agent-full-access' },
  { provider: 'CLAUDE' as const, mode: 'acceptEdits' },
])(
  'applies explicit $provider launch access $mode before first prompt and restores it on resume',
  async ({ provider, mode }) => {
    const h = setupLaunch(provider, false);
    h.setSession({
      providerMetadata: unsafeCoerce(
        createSessionLaunchMetadata({ accessMode: mode, planModeEnabled: false })
      ),
    });
    const accessConfirmation = gate();
    h.runtime.setSessionMode.mockImplementationOnce(async (id, value) => {
      await accessConfirmation.wait();
      return h.controller.setSessionMode(h.handle, value, id);
    });
    const starting = h.service.startSession(h.session.id, { initialPrompt: 'Do work' });
    await accessConfirmation.started;
    expect(h.sendSessionMessage).not.toHaveBeenCalled();
    accessConfirmation.release();
    await starting;
    expect(h.runtime.setSessionMode.mock.invocationCallOrder[0]).toBeLessThan(
      h.sendSessionMessage.mock.invocationCallOrder[0]!
    );
    expect(h.handle.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(mode);
    expect(readSessionLaunchSettings(h.row().providerMetadata)).toMatchObject({
      accessMode: mode,
      applied: true,
    });
    expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(h.session.id, 'Do work');
    h.runtimeManager.isSessionRunning.mockReturnValue(true);
    h.runtimeManager.stopAndQuiesce.mockImplementation(() => {
      h.runtimeManager.getClient.mockReturnValue(undefined);
      return Promise.resolve();
    });
    h.repository.updateSessionIfStatus.mockImplementation((_id, data, allowed) => {
      if (!allowed.includes(h.row().status)) {
        return Promise.resolve(0);
      }
      h.setSession(data);
      return Promise.resolve(1);
    });
    await h.service.stopSession(h.session.id, { reason: 'USER_STOP' });
    expect(h.row().status).toBe('IDLE');
    expect(h.runtimeManager.getClient(h.session.id)).toBeUndefined();
    // A fresh lifecycle graph/runtime resumes only from the durable session row.
    const resumed = setupLaunch(provider, false);
    resumed.setSession(h.row());
    await resumed.service.startSession(h.session.id, { initialPrompt: 'Continue work' });
    expect(resumed.handle).not.toBe(h.handle);
    expect(resumed.handle.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
      mode
    );
    expect(resumed.complete).toHaveBeenCalledOnce();
    expect(resumed.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(
      h.session.id,
      'Continue work'
    );
  }
);

it('rejects unsupported explicit launch access before sending a prompt', async () => {
  const h = setupLaunch();
  h.setSession({
    providerMetadata: unsafeCoerce({ launchSettings: { accessMode: 'missing', applied: false } }),
  });
  await expect(h.service.startSession(h.session.id, { initialPrompt: 'Do work' })).rejects.toThrow(
    'access mode'
  );
  expect(h.sendSessionMessage).not.toHaveBeenCalled();
  expect(h.complete).not.toHaveBeenCalled();
});

it('keeps Claude Plan read-only when launch access grants full permissions', async () => {
  const h = setupLaunch('CLAUDE');
  h.setSession({
    providerMetadata: unsafeCoerce(
      createSessionLaunchMetadata({ accessMode: 'bypassPermissions', planModeEnabled: true })
    ),
  });
  await h.service.startSession(h.session.id, { initialPrompt: 'Plan work' });
  expect(h.handle.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe('plan');
  expect(readSessionLaunchSettings(h.row().providerMetadata)?.applied).toBe(true);
  expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(h.session.id, 'Plan work');
  expect(h.runtime.setSessionMode).not.toHaveBeenCalledWith(h.session.id, 'bypassPermissions');
});

it('does not dispatch when the provider fails to confirm launch access', async () => {
  const h = setupLaunch('CODEX', false);
  h.setSession({
    providerMetadata: unsafeCoerce(createSessionLaunchMetadata({ accessMode: 'read-only' })),
  });
  h.runtime.setSessionMode.mockResolvedValueOnce(h.handle.configOptions);
  await expect(h.service.startSession(h.session.id, { initialPrompt: 'Do work' })).rejects.toThrow(
    'access mode was not applied'
  );
  expect(h.sendSessionMessage).not.toHaveBeenCalled();
  expect(h.complete).not.toHaveBeenCalled();
});

it('reapplies a concurrent access edit instead of acknowledging stale launch intent', async () => {
  const h = setupLaunch('CODEX', false);
  h.setSession({
    providerMetadata: unsafeCoerce(
      createSessionLaunchMetadata({ accessMode: 'agent-full-access' })
    ),
  });
  let edited = false;
  h.hooks.cas = (_number, data) => {
    if (!edited && readSessionLaunchSettings(data.providerMetadata)?.applied) {
      edited = true;
      const metadata = h.row().providerMetadata;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('Expected session metadata');
      }
      h.setSession({
        providerMetadata: unsafeCoerce({
          ...metadata,
          ...createSessionLaunchMetadata({ accessMode: 'read-only' }),
        }),
      });
    }
    return Promise.resolve();
  };
  await h.service.startSession(h.session.id, { initialPrompt: 'Do work' });
  expect(edited).toBe(true);
  expect(h.handle.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
    'read-only'
  );
  expect(readSessionLaunchSettings(h.row().providerMetadata)).toMatchObject({
    accessMode: 'read-only',
    applied: true,
  });
  expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(h.session.id, 'Do work');
});

it('preserves an explicit Claude startup Plan preset when launch only selects access', async () => {
  const h = setupLaunch('CLAUDE', false);
  h.setSession({
    providerMetadata: unsafeCoerce(
      createSessionLaunchMetadata({ accessMode: 'bypassPermissions' })
    ),
  });
  await h.service.startSession(h.session.id, {
    initialPrompt: 'Plan work',
    startupModePreset: 'plan',
  });
  expect(h.handle.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe('plan');
  expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(h.session.id, 'Plan work');
});
