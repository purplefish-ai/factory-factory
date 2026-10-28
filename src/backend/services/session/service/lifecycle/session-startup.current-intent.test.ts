import { describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { gate, settleConfig } from './session-config-authority.test-helpers';
import { readSessionLaunchSettings } from './session-launch-settings';
import { SessionStartupCancelledError } from './session-lifecycle-gate';
import { setupStartupConfig } from './session-startup-config.test-helpers';

vi.mock('@/backend/services/settings', () => ({
  userSettingsService: { get: vi.fn(async () => ({})) },
}));

function pendingLaunch() {
  const h = setupStartupConfig();
  h.setSession({
    model: 'first',
    providerMetadata: unsafeCoerce({
      launchSettings: { reasoningEffort: 'high', planModeEnabled: true, applied: false },
      acpConfigSnapshot: {
        provider: 'CODEX',
        providerSessionId: 'thread',
        capturedAt: new Date(0).toISOString(),
        configOptions: h.handle.configOptions,
      },
    }),
  });
  return h;
}

describe('current startup intent and surviving shared caller', () => {
  it.each(['final-write', 'reasoning'] as const)(
    'completes real shared readiness after its request owner cancels during %s',
    async (phase) => {
      const h = pendingLaunch();
      const held = gate();
      if (phase === 'final-write') {
        h.hooks.cas = async (number) => {
          if (number === 1) {
            await held.wait();
          }
        };
      } else {
        const original = h.config.applyConfiguredReasoningEffort.bind(h.config);
        h.sessionConfigService.applyConfiguredReasoningEffort.mockImplementationOnce(
          async (...args) => {
            await original(...args);
            await held.wait();
          }
        );
      }
      let cancelled = false;
      const cancellation = new SessionStartupCancelledError();
      const readiness = h.handle.configurationReady;
      const ready = readiness?.then(
        () => 'ready',
        (error) => error
      );
      const starting = h.service
        .startSession(h.session.id, {
          initialPrompt: 'Cancelled request prompt',
          assertCurrent: () => (cancelled ? Promise.reject(cancellation) : Promise.resolve()),
        })
        .catch((error) => error);
      await held.started;
      expect(await h.service.getOrCreateSessionClient(h.session.id)).toBe(h.handle);
      const borrowerEdit = h.config.setSessionModel(h.session.id, 'third').then(
        () => 'usable',
        (error) => error
      );
      cancelled = true;
      held.release();
      expect(await starting).toBe(cancellation);
      expect(await ready).toBe('ready');
      expect(await borrowerEdit).toBe('usable');
      expect(h.row().model).toBe('third');
      expect(h.complete).toHaveBeenCalledOnce();
      expect(h.fail).not.toHaveBeenCalled();
      expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
      expect(h.sendSessionMessage).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    'checks request cancellation after the final durable read (shared: %s)',
    async (shared) => {
      const h = pendingLaunch();
      // Match real supervisor retirement so outer request cleanup cannot see
      // the same stopped handle still installed in this focused harness.
      h.runtimeManager.stopClient.mockImplementation(() => {
        h.runtimeManager.getClient.mockReturnValue(undefined);
        return Promise.resolve();
      });
      const held = gate();
      const read = h.accessor.findById.getMockImplementation();
      if (!read) {
        throw new Error('Expected real row reader');
      }
      let acknowledgedReads = 0;
      h.accessor.findById.mockImplementation(async () => {
        if (readSessionLaunchSettings(h.row().providerMetadata)?.applied) {
          // The repository first reads back its successful CAS; the next read is
          // the finalizer's last asynchronous desired-intent validation.
          if (++acknowledgedReads === 2) {
            await held.wait();
          }
        }
        return read();
      });
      let cancelled = false;
      const cancellation = new SessionStartupCancelledError();
      const ready = h.handle.configurationReady?.then(
        () => 'ready',
        (error) => error
      );
      const starting = h.service
        .startSession(h.session.id, {
          initialPrompt: 'Cancelled prompt',
          assertCurrent: () => (cancelled ? Promise.reject(cancellation) : Promise.resolve()),
        })
        .catch((error) => error);
      await held.started;
      let borrower: Promise<unknown> | undefined;
      if (shared) {
        expect(await h.service.getOrCreateSessionClient(h.session.id)).toBe(h.handle);
        borrower = h.config.setSessionModel(h.session.id, 'third').then(() => 'usable');
      }
      cancelled = true;
      held.release();
      expect(await starting).toBe(cancellation);
      expect(h.sendSessionMessage).not.toHaveBeenCalled();
      if (shared) {
        expect(await ready).toBe('ready');
        expect(await borrower).toBe('usable');
        expect(h.complete).toHaveBeenCalledOnce();
        expect(h.fail).not.toHaveBeenCalled();
        expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
      } else {
        expect(await ready).toBe(cancellation);
        expect(h.complete).not.toHaveBeenCalled();
        expect(h.fail).toHaveBeenCalledOnce();
        expect(h.runtimeManager.stopClient).toHaveBeenCalledExactlyOnceWith(h.session.id);
      }
    }
  );

  it('hands a shared acquisition candidate to a surviving caller when its first acquisition request cancels', async () => {
    const h = pendingLaunch();
    const held = gate();
    h.hooks.cas = async (number) => {
      if (number === 1) {
        await held.wait();
      }
    };
    let cancelled = false;
    const cancellation = new SessionStartupCancelledError();
    const ready = h.handle.configurationReady?.then(
      () => 'ready',
      (error) => error
    );
    const acquiring = h.service
      .getOrCreateSessionClient(h.session.id, {
        assertCurrent: () => (cancelled ? Promise.reject(cancellation) : Promise.resolve()),
      })
      .catch((error) => error);
    await held.started;
    expect(await h.service.getOrCreateSessionClient(h.session.id)).toBe(h.handle);
    const borrower = h.config.setSessionModel(h.session.id, 'third').then(
      () => 'usable',
      (error) => error
    );
    cancelled = true;
    held.release();
    expect(await acquiring).toBe(cancellation);
    expect(await ready).toBe('ready');
    expect(await borrower).toBe('usable');
    expect(h.fail).not.toHaveBeenCalled();
    expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
  });

  it.each(['model', 'reasoning_effort', 'collaboration_mode'] as const)(
    'uses a completed inactive %s edit made during context loading',
    async (field) => {
      const h = pendingLaunch();
      const held = gate();
      const load = h.contextService.load.bind(h.contextService);
      vi.spyOn(h.contextService, 'load').mockImplementationOnce(async (...args) => {
        await held.wait();
        return load(...args);
      });
      const starting = h.service.startSession(h.session.id, { initialPrompt: 'Do work' });
      await held.started;
      const value = field === 'model' ? 'second' : field === 'reasoning_effort' ? 'low' : 'default';
      await h.config.setSessionConfigOption(h.session.id, field, value);
      held.release();
      await starting;
      expect(h.repository.getWorkspaceById).toHaveBeenCalledOnce();
      const snapshot = h.row().providerMetadata;
      expect(h.handle.configOptions.find((option) => option.id === field)?.currentValue).toBe(
        value
      );
      expect(snapshot).toMatchObject({
        acpConfigSnapshot: {
          configOptions: expect.arrayContaining([
            expect.objectContaining({ id: field, currentValue: value }),
          ]),
        },
      });
      expect(readSessionLaunchSettings(snapshot)).toMatchObject({
        applied: true,
        ...(field === 'reasoning_effort'
          ? { reasoningEffort: 'low' }
          : field === 'collaboration_mode'
            ? { planModeEnabled: false }
            : {}),
      });
      expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(h.session.id, 'Do work');
    }
  );

  it.each([
    {
      kind: 'reasoning',
      patch: { reasoningEffort: 'low' },
      model: undefined,
      effort: 'low',
      plan: true,
      expectedModel: 'first',
      aba: false,
    },
    {
      kind: 'plan',
      patch: { planModeEnabled: false },
      model: undefined,
      effort: 'high',
      plan: false,
      expectedModel: 'first',
      aba: false,
    },
    {
      kind: 'model',
      patch: {},
      model: 'second',
      effort: 'high',
      plan: true,
      expectedModel: 'second',
      aba: false,
    },
    {
      kind: 'aba',
      patch: { reasoningEffort: 'high' },
      model: undefined,
      effort: 'high',
      plan: true,
      expectedModel: 'first',
      aba: true,
    },
  ])(
    'refreshes changed desired $kind at actual final repository CAS retry without overwriting it',
    async ({ kind, patch, model, effort, plan, expectedModel, aba }) => {
      const h = pendingLaunch();
      let changed = false;
      h.hooks.cas = async (_number, data) => {
        if (!readSessionLaunchSettings(data.providerMetadata)?.applied || changed) {
          return;
        }
        changed = true;
        if (aba) {
          await h.repository.updatePendingLaunchConfiguration(
            h.session.id,
            { providerMetadata: h.row().providerMetadata },
            { reasoningEffort: 'low' }
          );
        }
        await h.repository.updatePendingLaunchConfiguration(
          h.session.id,
          {
            ...(model ? { model } : {}),
            providerMetadata: h.row().providerMetadata,
          },
          patch
        );
      };
      await h.service.startSession(h.session.id, { initialPrompt: 'Do work' });
      await settleConfig();
      expect(changed).toBe(true);
      expect(readSessionLaunchSettings(h.row().providerMetadata)).toMatchObject({
        applied: true,
        reasoningEffort: effort,
        planModeEnabled: plan,
      });
      expect(
        h.handle.configOptions.find((option) => option.id === 'reasoning_effort')?.currentValue
      ).toBe(effort);
      expect(
        h.handle.configOptions.find((option) => option.id === 'collaboration_mode')?.currentValue
      ).toBe(plan ? 'plan' : 'default');
      expect(h.row().model).toBe(expectedModel);
      expect(h.complete).toHaveBeenCalledOnce();
      expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(h.session.id, 'Do work');
      if (kind === 'aba') {
        expect(h.accessor.updateIfProviderIdentity.mock.calls.length).toBeGreaterThanOrEqual(4);
      }
    }
  );

  it('keeps shared terminal current storage failure fatal even when its caller also cancels', async () => {
    const h = pendingLaunch();
    const held = gate();
    h.hooks.cas = async () => {
      await held.wait();
      throw new Error('terminal storage failure');
    };
    let cancelled = false;
    const starting = h.service
      .startSession(h.session.id, {
        initialPrompt: 'No prompt',
        assertCurrent: () =>
          cancelled ? Promise.reject(new SessionStartupCancelledError()) : Promise.resolve(),
      })
      .catch((error) => error);
    await held.started;
    await h.service.getOrCreateSessionClient(h.session.id);
    cancelled = true;
    held.release();
    expect(await starting).toEqual(
      expect.objectContaining({ message: 'terminal storage failure' })
    );
    expect(h.fail).toHaveBeenCalledOnce();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.runtimeManager.stopClient).toHaveBeenCalledExactlyOnceWith(h.session.id);
    expect(h.sendSessionMessage).not.toHaveBeenCalled();
  });
});

it.each([
  {
    name: 'thinking null',
    options: { reasoningEffort: null },
    effort: 'low',
    plan: 'plan',
    applied: false,
    model: 'first',
  },
  {
    name: 'thinking low',
    options: { reasoningEffort: 'low' },
    effort: 'low',
    plan: 'plan',
    applied: false,
    model: 'first',
  },
  {
    name: 'Plan false',
    options: { planModeEnabled: false },
    effort: 'high',
    plan: 'default',
    applied: false,
    model: 'first',
  },
  {
    name: 'matching explicit targets',
    options: { reasoningEffort: 'high', planModeEnabled: true },
    effort: 'high',
    plan: 'plan',
    applied: true,
    model: 'first',
  },
  {
    name: 'explicit model',
    options: { model: 'second' },
    effort: 'high',
    plan: 'plan',
    applied: true,
    model: 'second',
  },
])(
  'preserves $name precedence without falsely consuming a masked stored choice',
  async ({ options, effort, plan, applied, model }) => {
    const h = pendingLaunch();
    await expect(h.service.getOrCreateSessionClient(h.session.id, options)).resolves.toBe(h.handle);
    expect(
      h.handle.configOptions.find((option) => option.id === 'reasoning_effort')?.currentValue
    ).toBe(effort);
    expect(
      h.handle.configOptions.find((option) => option.id === 'collaboration_mode')?.currentValue
    ).toBe(plan);
    expect(readSessionLaunchSettings(h.row().providerMetadata)).toEqual({
      reasoningEffort: 'high',
      planModeEnabled: true,
      applied,
    });
    expect(h.row().model).toBe(model);
    expect(h.complete).toHaveBeenCalledOnce();
    expect(h.accessor.updateIfProviderIdentity.mock.calls.length).toBeLessThan(8);
    expect(h.sendSessionMessage).not.toHaveBeenCalled();
  }
);

it('keeps a new desired tuple pending when acknowledgment of the reapplied intent cannot persist', async () => {
  const h = pendingLaunch();
  let changed = false;
  h.hooks.cas = async (_number, data) => {
    if (!readSessionLaunchSettings(data.providerMetadata)?.applied) {
      return;
    }
    if (!changed) {
      changed = true;
      await h.repository.updatePendingLaunchConfiguration(
        h.session.id,
        { providerMetadata: h.row().providerMetadata },
        { reasoningEffort: 'low' }
      );
      return;
    }
    throw new Error('current acknowledgment storage unavailable');
  };
  await expect(
    h.service.startSession(h.session.id, { initialPrompt: 'No prompt' })
  ).rejects.toThrow('current acknowledgment storage unavailable');
  expect(readSessionLaunchSettings(h.row().providerMetadata)).toEqual({
    reasoningEffort: 'low',
    planModeEnabled: true,
    applied: false,
  });
  expect(
    h.handle.configOptions.find((option) => option.id === 'reasoning_effort')?.currentValue
  ).toBe('low');
  expect(h.complete).not.toHaveBeenCalled();
  expect(h.fail).toHaveBeenCalledOnce();
  expect(h.sendSessionMessage).not.toHaveBeenCalled();
});

it('refreshes an unmasked Plan change while preserving a masked thinking override and current pending metadata', async () => {
  const h = pendingLaunch();
  let changed = false;
  h.hooks.cas = async (_number, data) => {
    if (changed || !data.providerMetadata) {
      return;
    }
    changed = true;
    await h.repository.updatePendingLaunchConfiguration(
      h.session.id,
      { providerMetadata: h.row().providerMetadata },
      { reasoningEffort: null, planModeEnabled: false }
    );
  };
  await h.service.getOrCreateSessionClient(h.session.id, { reasoningEffort: 'low' });
  expect(readSessionLaunchSettings(h.row().providerMetadata)).toEqual({
    reasoningEffort: null,
    planModeEnabled: false,
    applied: false,
  });
  expect(
    h.handle.configOptions.find((option) => option.id === 'reasoning_effort')?.currentValue
  ).toBe('low');
  expect(
    h.handle.configOptions.find((option) => option.id === 'collaboration_mode')?.currentValue
  ).toBe('default');
  expect(h.complete).toHaveBeenCalledOnce();
  expect(h.accessor.updateIfProviderIdentity.mock.calls.length).toBeLessThan(10);
});

it('preserves Claude alias-to-canonical confirmation when refreshing startup model intent', async () => {
  const h = setupStartupConfig('CLAUDE');
  h.setSession({ model: 'sonnet' });
  h.handle.configOptions = h.handle.configOptions.map((option) => {
    if (option.type !== 'select') {
      return option;
    }
    if (option.id === 'model') {
      return { ...option, currentValue: 'old', options: [{ value: 'sonnet', name: 'Sonnet 4.5' }] };
    }
    if (option.id === 'mode') {
      return {
        ...option,
        currentValue: 'default',
        options: ['default', 'plan'].map((value) => ({ value, name: value })),
      };
    }
    return option;
  });
  h.handle.connection.setSessionConfigOption = ({ configId, value }) => {
    if (typeof value !== 'string') {
      throw new Error('Expected select value');
    }
    return Promise.resolve({
      configOptions: h.handle.configOptions.map((option) =>
        option.type === 'select' && option.id === configId
          ? { ...option, currentValue: configId === 'model' ? 'claude-sonnet-4-5' : value }
          : option
      ),
    });
  };
  await h.service.getOrCreateSessionClient(h.session.id);
  expect(h.row().model).toBe('claude-sonnet-4-5');
  expect(h.complete).toHaveBeenCalledOnce();
  expect(readSessionLaunchSettings(h.row().providerMetadata)).toBeUndefined();
});

it('confirms Codex native default without a redundant model RPC and persists the observed identity only at startup', async () => {
  const h = setupStartupConfig();
  h.setSession({ model: 'default' });
  expect(h.row().model).toBe('default');
  await h.service.getOrCreateSessionClient(h.session.id);
  expect(h.runtime.setSessionModel).not.toHaveBeenCalled();
  expect(h.row().model).toBe('first');
  expect(h.row().providerMetadata).toMatchObject({
    acpConfigSnapshot: { observedModelId: 'first' },
  });
  expect(h.complete).toHaveBeenCalledOnce();
  expect(readSessionLaunchSettings(h.row().providerMetadata)).toBeUndefined();
});
