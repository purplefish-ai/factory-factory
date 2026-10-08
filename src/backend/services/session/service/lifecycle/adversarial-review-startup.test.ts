import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionStartupCancelledError } from './session-lifecycle-gate';
import { createDeferred, createLifecycleHarness } from './session-lifecycle.test-helpers';
import { assertReadOnlyReviewConfigOption } from './session-permission-policy';
import { SessionConfigService } from './session.config.service';

vi.mock('@/backend/services/logger.service', () => ({
  getCurrentProcessEnv: () => ({ NODE_ENV: 'test' }),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/backend/services/settings', () => ({
  userSettingsService: {
    get: vi.fn(() => Promise.reject(new Error('settings unavailable'))),
  },
}));
vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: { findById: vi.fn() },
  workspaceNotificationService: {
    listPendingForDelivery: vi.fn(() => Promise.resolve([])),
    markDelivered: vi.fn(),
  },
}));

function createHarness(provider: 'CLAUDE' | 'CODEX', workflow = ADVERSARIAL_REVIEW_WORKFLOW) {
  const harness = createLifecycleHarness({
    provider,
    providerSessionId: 'existing-provider-session',
    session: { workflow },
    getPermissionPreset: () => Promise.reject(new Error('settings unavailable')),
  });
  harness.handle.configOptions = [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
      ],
    },
    ...(provider === 'CODEX'
      ? [
          {
            id: 'execution_mode',
            name: 'Execution Mode',
            category: 'permission',
            type: 'select',
            currentValue: '["never","danger-full-access"]',
            options: [
              '["never","danger-full-access"]',
              '["on-request","workspace-write"]',
              '["never","read-only"]',
            ].map((value) => ({ value, name: value })),
          } as SessionConfigOption,
        ]
      : []),
  ];
  const updateOption = (id: string, value: string) => {
    harness.handle.configOptions = harness.handle.configOptions.map((option) =>
      option.id === id && option.type === 'select' ? { ...option, currentValue: value } : option
    );
    return Promise.resolve(harness.handle.configOptions);
  };
  const runtime = {
    ...harness.runtimeManager,
    setSessionMode: vi.fn(async (_id: string, value: string) => updateOption('mode', value)),
    setConfigOption: vi.fn(async (_id: string, configId: string, value: string) =>
      updateOption(configId, value)
    ),
  };
  const config = new SessionConfigService({
    repository: unsafeCoerce(harness.repository),
    runtimeManager: unsafeCoerce(runtime),
    sessionDomainService: unsafeCoerce(harness.sessionDomainService),
    codexModelCatalogService: { getModels: vi.fn(() => Promise.resolve([])) },
  });
  harness.sessionConfigService.applyConfiguredPermissionPreset.mockImplementation(
    config.applyConfiguredPermissionPreset.bind(config)
  );
  harness.sessionConfigService.applyStartupModePreset.mockImplementation(
    config.applyStartupModePreset.bind(config)
  );
  return { ...harness, runtime, config };
}

const paths = ['start', 'restart', 'chat auto-start', 'preloaded auto-start'] as const;
type StartupPath = (typeof paths)[number];
function start(harness: ReturnType<typeof createHarness>, path: StartupPath) {
  switch (path) {
    case 'start':
      return harness.service.startSession(harness.session.id);
    case 'restart':
      return harness.service.restartSession(harness.session.id);
    case 'chat auto-start':
      return harness.service.getOrCreateSessionClient(harness.session.id);
    case 'preloaded auto-start':
      return harness.service.getOrCreateSessionClientFromRecord(harness.session);
  }
}

describe('adversarial review startup permissions', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(
    paths.flatMap((path) => (['CLAUDE', 'CODEX'] as const).map((provider) => ({ path, provider })))
  )(
    'restricts $provider $path before notifications and prompts despite settings failure',
    async ({ path, provider }) => {
      const harness = createHarness(provider);
      const assertRestricted = () => {
        expect(
          harness.handle.configOptions.find((option) => option.id === 'mode')?.currentValue
        ).toBe('plan');
        if (provider === 'CODEX') {
          expect(
            harness.handle.configOptions.find((option) => option.id === 'execution_mode')
              ?.currentValue
          ).toBe('["never","read-only"]');
        }
      };
      harness.sendSessionMessage.mockImplementation(() => {
        assertRestricted();
        return Promise.resolve();
      });
      harness.notificationDeliveryService.recoverPending = vi.fn(() => {
        assertRestricted();
        return Promise.resolve({ dispatchableCount: 0 });
      });
      await start(harness, path);
      assertRestricted();
      expect(harness.acpEventProcessor.registerSessionContext).toHaveBeenCalledWith(
        harness.session.id,
        expect.objectContaining({ workflow: ADVERSARIAL_REVIEW_WORKFLOW })
      );
      expect(harness.runtimeManager.getOrCreateClient).toHaveBeenCalledWith(
        harness.session.id,
        expect.objectContaining({ permissionPreset: 'STRICT' }),
        expect.any(Object),
        expect.any(Object)
      );
    }
  );

  it.each([
    'unsupported plan',
    'mode rejected',
    'unsupported sandbox',
    'sandbox rejected',
    'unchanged response',
  ])('aborts review startup and stops the client on %s', async (failure) => {
    const harness = createHarness('CODEX');
    if (failure === 'unsupported plan') {
      harness.handle.configOptions = harness.handle.configOptions.filter(
        (option) => option.id !== 'mode'
      );
    }
    if (failure === 'unsupported sandbox') {
      harness.handle.configOptions = harness.handle.configOptions.filter(
        (option) => option.id !== 'execution_mode'
      );
    }
    if (failure === 'mode rejected') {
      harness.runtime.setSessionMode.mockRejectedValue(new Error('mode rejected'));
    }
    if (failure === 'sandbox rejected') {
      harness.runtime.setConfigOption.mockRejectedValue(new Error('sandbox rejected'));
    }
    if (failure === 'unchanged response') {
      harness.runtime.setSessionMode.mockResolvedValue(harness.handle.configOptions);
    }
    await expect(start(harness, 'start')).rejects.toThrow();
    expect(harness.runtimeManager.stopClient).toHaveBeenCalledExactlyOnceWith(harness.session.id);
    expect(harness.sendSessionMessage).not.toHaveBeenCalled();
    expect(harness.tryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it('clears newly created review state when restriction failure cleanup rejects', async () => {
    const harness = createHarness('CODEX');
    harness.runtime.setConfigOption.mockRejectedValue(new Error('sandbox rejected'));
    harness.runtimeManager.stopClient.mockRejectedValue(new Error('stop rejected'));
    await expect(start(harness, 'chat auto-start')).rejects.toThrow('stop rejected');
    expect(harness.acpEventProcessor.clearSessionState).toHaveBeenCalledWith(harness.session.id);
    expect(harness.lifecycleGate.isStopReserved(harness.session.id)).toBe(false);
    expect(harness.tryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it('preserves normal session workspace-write permissions and default collaboration mode', async () => {
    const harness = createHarness('CODEX', 'code');
    await start(harness, 'start');
    expect(harness.handle.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
      'default'
    );
    expect(
      harness.handle.configOptions.find((option) => option.id === 'execution_mode')?.currentValue
    ).toBe('["on-request","workspace-write"]');
  });

  it.each(['STRICT', 'RELAXED', 'YOLO'] as const)(
    'keeps review execution read-only with configured %s permissions',
    async (preset) => {
      const harness = createHarness('CODEX');
      const configured = new SessionConfigService({
        repository: unsafeCoerce(harness.repository),
        runtimeManager: unsafeCoerce(harness.runtime),
        sessionDomainService: unsafeCoerce(harness.sessionDomainService),
        codexModelCatalogService: { getModels: vi.fn(() => Promise.resolve([])) },
      });
      await configured.applyConfiguredPermissionPreset(
        harness.session.id,
        harness.session,
        harness.handle,
        preset
      );
      expect(
        harness.handle.configOptions.find((option) => option.id === 'execution_mode')?.currentValue
      ).toBe('["never","read-only"]');
    }
  );

  it('restores restrictions on an existing review client before returning it to chat', async () => {
    const harness = createHarness('CODEX');
    harness.runtimeManager.getClient.mockReturnValue(harness.handle);
    await start(harness, 'chat auto-start');
    expect(harness.handle.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
      'plan'
    );
    expect(
      harness.handle.configOptions.find((option) => option.id === 'execution_mode')?.currentValue
    ).toBe('["never","read-only"]');
    expect(harness.runtimeManager.getOrCreateClient).not.toHaveBeenCalled();
  });

  it.each(['chat auto-start', 'preloaded auto-start'] as const)(
    'stops an existing review client when read-only execution fails during %s',
    async (path) => {
      const harness = createHarness('CODEX');
      harness.runtimeManager.getClient.mockReturnValue(harness.handle);
      harness.runtime.setConfigOption.mockRejectedValue(new Error('sandbox rejected'));
      await expect(start(harness, path)).rejects.toThrow('sandbox rejected');
      expect(harness.runtimeManager.stopClient).toHaveBeenCalledWith(harness.session.id);
      expect(harness.acpEventProcessor.clearSessionState).toHaveBeenCalledWith(harness.session.id);
      expect(harness.sessionDomainService.setRuntimeSnapshot).toHaveBeenCalledWith(
        harness.session.id,
        expect.objectContaining({
          phase: 'error',
          processState: 'stopped',
          activity: 'IDLE',
          errorMessage: 'Failed to start agent: sandbox rejected',
        })
      );
      expect(harness.tryDispatchNextMessage).not.toHaveBeenCalled();
    }
  );

  it('cancels concurrent starts when an existing review client loses read-only permissions', async () => {
    const harness = createHarness('CODEX');
    let stopped = false;
    harness.runtimeManager.getClient.mockImplementation(() =>
      stopped ? undefined : harness.handle
    );
    harness.runtimeManager.stopClient.mockImplementation(() => {
      stopped = true;
      return Promise.resolve();
    });
    const secondPreset = createDeferred<void>();
    const bothStarted = createDeferred<void>();
    harness.sessionConfigService.applyConfiguredPermissionPreset
      .mockImplementationOnce(async () => {
        await bothStarted.promise;
        throw new Error('sandbox rejected');
      })
      .mockImplementationOnce(async () => {
        bothStarted.resolve();
        await secondPreset.promise;
      });

    const first = start(harness, 'chat auto-start');
    const second = start(harness, 'chat auto-start');
    const secondOutcome = second.then(
      (value) => value,
      (error) => error
    );
    await expect(first).rejects.toThrow('sandbox rejected');
    expect(harness.runtimeManager.getClient(harness.session.id)).toBeUndefined();
    expect(harness.lifecycleGate.isStopReserved(harness.session.id)).toBe(false);

    secondPreset.resolve();
    expect(await secondOutcome).toBeInstanceOf(SessionStartupCancelledError);
    expect(harness.sessionDomainService.setRuntimeSnapshot).toHaveBeenLastCalledWith(
      harness.session.id,
      expect.objectContaining({ processState: 'stopped' })
    );
  });

  it('clears failed review startup state even when stopping the client rejects', async () => {
    const harness = createHarness('CODEX');
    harness.runtimeManager.getClient.mockReturnValue(harness.handle);
    harness.runtime.setConfigOption.mockRejectedValue(new Error('sandbox rejected'));
    harness.runtimeManager.stopClient.mockRejectedValue(new Error('stop rejected'));
    await expect(start(harness, 'chat auto-start')).rejects.toThrow('stop rejected');
    expect(harness.acpEventProcessor.clearSessionState).toHaveBeenCalledWith(harness.session.id);
    expect(harness.lifecycleGate.isStopReserved(harness.session.id)).toBe(false);
    expect(harness.sessionDomainService.setRuntimeSnapshot).not.toHaveBeenCalledWith(
      harness.session.id,
      expect.objectContaining({ processState: 'stopped' })
    );
  });

  it.each([false, true])(
    'releases the stop fence when review cleanup throws after stop failure=%s',
    async (stopFails) => {
      const harness = createHarness('CODEX');
      harness.runtimeManager.getClient.mockReturnValue(harness.handle);
      harness.runtime.setConfigOption.mockRejectedValue(new Error('sandbox rejected'));
      if (stopFails) {
        harness.runtimeManager.stopClient.mockRejectedValue(new Error('stop rejected'));
      }
      harness.acpEventProcessor.clearSessionState.mockImplementation(() => {
        throw new Error('cleanup rejected');
      });

      await expect(start(harness, 'chat auto-start')).rejects.toThrow('cleanup rejected');
      expect(harness.lifecycleGate.isStopReserved(harness.session.id)).toBe(false);
      expect(harness.lifecycleGate.isSessionStopping(harness.session.id)).toBe(false);
    }
  );

  it('persists and emits repaired permissions on an existing review client', async () => {
    const harness = createHarness('CODEX');
    harness.runtimeManager.getClient.mockReturnValue(harness.handle);
    const persist = vi.spyOn(harness.config, 'persistAcpConfigSnapshot').mockResolvedValue();
    await start(harness, 'chat auto-start');
    expect(persist).toHaveBeenCalledWith(
      harness.session.id,
      expect.objectContaining({
        configOptions: harness.handle.configOptions,
      })
    );
    expect(harness.sessionDomainService.emitDelta).toHaveBeenCalledWith(harness.session.id, {
      type: 'config_options_update',
      configOptions: harness.handle.configOptions,
    });
    expect(harness.sessionDomainService.emitDelta).toHaveBeenCalledWith(
      harness.session.id,
      expect.objectContaining({ type: 'chat_capabilities' })
    );
    persist.mockClear();
    harness.sessionDomainService.emitDelta.mockClear();
    await start(harness, 'chat auto-start');
    expect(persist).not.toHaveBeenCalled();
    expect(harness.sessionDomainService.emitDelta).not.toHaveBeenCalledWith(
      harness.session.id,
      expect.objectContaining({ type: 'config_options_update' })
    );
  });

  it.each([
    ['mode', 'PLAN'],
    ['execution_mode', '[ "never", "read-only" ]'],
  ])('accepts equivalent safe provider values for %s', (configId, value) => {
    expect(() =>
      assertReadOnlyReviewConfigOption(ADVERSARIAL_REVIEW_WORKFLOW, configId, value, undefined)
    ).not.toThrow();
  });

  it('keeps review restrictions when a caller requests non-interactive startup', async () => {
    const harness = createHarness('CODEX');
    await harness.service.startSession(harness.session.id, {
      startupModePreset: 'non_interactive',
    });
    expect(harness.handle.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
      'plan'
    );
    expect(
      harness.handle.configOptions.find((option) => option.id === 'execution_mode')?.currentValue
    ).toBe('["never","read-only"]');
  });

  it.each(['CLAUDE', 'CODEX'] as const)(
    'rejects mode/permission changes on a live %s review',
    async (provider) => {
      const harness = createHarness(provider);
      harness.runtime.getClient.mockReturnValue(harness.handle);
      const config = new SessionConfigService({
        repository: unsafeCoerce(harness.repository),
        runtimeManager: unsafeCoerce(harness.runtime),
        sessionDomainService: unsafeCoerce(harness.sessionDomainService),
        codexModelCatalogService: { getModels: vi.fn(() => Promise.resolve([])) },
      });
      await expect(
        config.setSessionConfigOption(harness.session.id, 'mode', 'default')
      ).rejects.toThrow('read-only');
      await expect(
        config.setSessionConfigOption(
          harness.session.id,
          'execution_mode',
          '["never","danger-full-access"]'
        )
      ).rejects.toThrow('read-only');
      expect(harness.runtime.setConfigOption).not.toHaveBeenCalled();
      expect(harness.runtime.setSessionMode).not.toHaveBeenCalled();
    }
  );

  it.each(['mode', 'execution_mode'])(
    'rejects %s permission broadening on a stopped review',
    async (configId) => {
      const harness = createHarness('CODEX');
      harness.session.providerMetadata = unsafeCoerce({
        acpConfigSnapshot: {
          provider: 'CODEX',
          providerSessionId: 'existing-provider-session',
          capturedAt: new Date().toISOString(),
          configOptions: harness.handle.configOptions,
        },
      });
      await expect(
        harness.config.setSessionConfigOption(
          harness.session.id,
          configId,
          configId === 'mode' ? 'default' : '["never","danger-full-access"]'
        )
      ).rejects.toThrow('read-only');
      expect(harness.repository.updateSession).not.toHaveBeenCalled();
    }
  );
});
