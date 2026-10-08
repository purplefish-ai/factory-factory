import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { beforeEach, expect, it, vi } from 'vitest';
import { workspaceNotificationService } from '@/backend/services/workspace';
import { createLifecycleHarness, type LifecycleHarness } from './session-lifecycle.test-helpers';
import {
  SessionStartupCoordinator,
  type SessionStartupCoordinatorDependencies,
} from './session-startup.coordinator';
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getCurrentProcessEnv: () => ({ NODE_ENV: 'test' }),
}));
vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: { findById: vi.fn() },
  workspaceNotificationService: { listPendingForDelivery: vi.fn(), markDelivered: vi.fn() },
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([]);
  vi.mocked(workspaceNotificationService.markDelivered).mockResolvedValue();
});
function createStartupCoordinator(harness: LifecycleHarness): SessionStartupCoordinator {
  const dependencies = {
    repository: harness.repository,
    contextService: harness.contextService,
    acpEnvironment: harness.acpEnvironment,
    runtimeManager: harness.runtimeManager,
    sessionDomainService: harness.sessionDomainService,
    sessionConfigService: harness.sessionConfigService,
    acpEventProcessor: harness.acpEventProcessor,
    runtimeExitCoordinator: { createHandlers: vi.fn(() => ({})) },
    lifecycleGate: harness.lifecycleGate,
    notificationDelivery: harness.notificationDeliveryService,
    sendSessionMessage: harness.sendSessionMessage,
    stopSession: (sessionId, options) => harness.service.stopSession(sessionId, options),
  } satisfies SessionStartupCoordinatorDependencies;
  const coordinator = new SessionStartupCoordinator(dependencies);
  coordinator.configure({ messageQueue: harness.messageQueueBridge });
  return coordinator;
}

it.each(['CLAUDE', 'CODEX'] as const)(
  'restores the existing %s config without applying current defaults',
  async (provider) => {
    const mode = {
      id: 'mode',
      name: 'Mode',
      type: 'select' as const,
      currentValue: 'plan',
      options: [
        { value: 'plan', name: 'Plan' },
        { value: 'code', name: 'Code' },
      ],
    };
    const thinking = {
      id: 'thinking',
      name: 'Thinking',
      type: 'boolean' as const,
      currentValue: true,
    };
    const options: SessionConfigOption[] = [mode, thinking];
    const harness = createLifecycleHarness({
      provider,
      session: {
        providerSessionId: 'existing',
        providerMetadata: {
          acpConfigSnapshot: {
            provider,
            providerSessionId: 'existing',
            configOptions: [mode, thinking],
          },
        },
      },
    });
    harness.handle.configOptions = [
      { ...mode, currentValue: 'code' },
      { ...thinking, currentValue: false },
    ];
    Object.defineProperty(harness.handle, 'connection', {
      value: {
        setSessionMode: vi.fn().mockResolvedValue({}),
        setSessionConfigOption: vi.fn().mockResolvedValue({ configOptions: options }),
      },
      configurable: true,
    });
    await createStartupCoordinator(harness).getOrCreateSessionClient('session-1', {
      resumePolicy: 'require_existing',
    });
    expect(harness.runtimeManager.getOrCreateClient).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        provider,
        resumeProviderSessionId: 'existing',
        resumePolicy: 'require_existing',
      }),
      expect.anything(),
      expect.anything()
    );
    expect(harness.handle.configOptions).toEqual(options);
    expect(harness.sessionConfigService.applyConfiguredReasoningEffort).not.toHaveBeenCalled();
    expect(harness.sessionConfigService.applyConfiguredPermissionPreset).not.toHaveBeenCalled();
  }
);
it('rejects an unavailable existing configuration before any background turn', async () => {
  const harness = createLifecycleHarness({ session: { providerSessionId: 'existing' } });
  await expect(
    createStartupCoordinator(harness).getOrCreateSessionClient('session-1', {
      resumePolicy: 'require_existing',
    })
  ).rejects.toThrow('Missing existing ACP configuration');
  expect(harness.sendSessionMessage).not.toHaveBeenCalled();
  expect(harness.runtimeManager.stopClient).toHaveBeenCalled();
});

it.each(['start', 'restart', 'getOrCreate'] as const)(
  'rejects retained ratchet workflow through %s',
  async (action) => {
    const harness = createLifecycleHarness({ session: { workflow: 'ratchet' } });
    const coordinator = createStartupCoordinator(harness);
    const operation =
      action === 'start'
        ? coordinator.startSession('session-1')
        : action === 'restart'
          ? coordinator.restartSession('session-1')
          : coordinator.getOrCreateSessionClient('session-1');
    await expect(operation).rejects.toThrow('Legacy ratchet sessions cannot be started');
    expect(harness.runtimeManager.getOrCreateClient).not.toHaveBeenCalled();
  }
);
it('rejects an already-installed fallback handle during strict startup', async () => {
  const harness = createLifecycleHarness({
    providerSessionId: 'existing',
    sessionCreationOutcome: {
      kind: 'resume_fallback',
      previousProviderSessionId: 'existing',
      reason: 'load_failed',
    },
  });
  harness.runtimeManager.getClient.mockReturnValue(harness.handle);
  await expect(
    createStartupCoordinator(harness).getOrCreateSessionClient('session-1', {
      resumePolicy: 'require_existing',
    })
  ).rejects.toThrow('Required existing conversation');
});
it('rejects a joined fallback creation during strict startup', async () => {
  const harness = createLifecycleHarness({
    providerSessionId: 'existing',
    sessionCreationOutcome: {
      kind: 'resume_fallback',
      previousProviderSessionId: 'existing',
      reason: 'load_failed',
    },
    session: {
      providerMetadata: {
        acpConfigSnapshot: { provider: 'CLAUDE', providerSessionId: 'existing', configOptions: [] },
      },
    },
  });
  await expect(
    createStartupCoordinator(harness).getOrCreateSessionClient('session-1', {
      resumePolicy: 'require_existing',
    })
  ).rejects.toThrow('Required existing conversation');
});
it('does not recover notifications ahead of the source token during strict startup', async () => {
  const harness = createLifecycleHarness({
    providerSessionId: 'existing',
    session: {
      providerMetadata: {
        acpConfigSnapshot: { provider: 'CLAUDE', providerSessionId: 'existing', configOptions: [] },
      },
    },
  });
  const recover = vi.spyOn(harness.notificationDeliveryService, 'recoverPending');
  await createStartupCoordinator(harness).getOrCreateSessionClient('session-1', {
    resumePolicy: 'require_existing',
  });
  expect(recover).not.toHaveBeenCalled();
});
it('restores mode with the ACP session mode method and updates cached config', async () => {
  const mode = {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select' as const,
    currentValue: 'plan',
    options: [
      { value: 'plan', name: 'Plan' },
      { value: 'code', name: 'Code' },
    ],
  };
  const harness = createLifecycleHarness({
    providerSessionId: 'existing',
    session: {
      providerMetadata: {
        acpConfigSnapshot: {
          provider: 'CLAUDE',
          providerSessionId: 'existing',
          configOptions: [mode],
        },
      },
    },
  });
  harness.handle.configOptions = [{ ...mode, currentValue: 'code' }];
  const setSessionMode = vi.fn().mockResolvedValue({});
  const setSessionConfigOption = vi
    .fn()
    .mockRejectedValue(new Error('Mode is not a config option'));
  Object.defineProperty(harness.handle, 'connection', {
    value: { setSessionMode, setSessionConfigOption },
    configurable: true,
  });
  await createStartupCoordinator(harness).getOrCreateSessionClient('session-1', {
    resumePolicy: 'require_existing',
  });
  expect(setSessionMode).toHaveBeenCalledWith({ sessionId: 'existing', modeId: 'plan' });
  expect(harness.handle.configOptions[0]?.currentValue).toBe('plan');
  expect(setSessionConfigOption).not.toHaveBeenCalled();
});

it('rejects a retained legacy restart before touching its active runtime', async () => {
  const harness = createLifecycleHarness({ session: { workflow: 'ratchet' } });
  harness.runtimeManager.isSessionRunning.mockReturnValue(true);
  const coordinator = createStartupCoordinator(harness);
  await expect(coordinator.restartSession('session-1')).rejects.toThrow(
    'Legacy ratchet sessions cannot be started'
  );
  expect(harness.runtimeManager.stopAndQuiesce).not.toHaveBeenCalled();
});
it('accepts the original live conversation created for a bound session', async () => {
  const harness = createLifecycleHarness({
    providerSessionId: 'existing',
    sessionCreationOutcome: { kind: 'new' },
  });
  harness.runtimeManager.getClient.mockReturnValue(harness.handle);
  await expect(
    createStartupCoordinator(harness).getOrCreateSessionClient('session-1', {
      resumePolicy: 'require_existing',
    })
  ).resolves.toBe(harness.handle);
  expect(harness.runtimeManager.getOrCreateClient).not.toHaveBeenCalled();
});
it('rejects a warm provider identity that no longer matches the persisted conversation', async () => {
  const harness = createLifecycleHarness({ providerSessionId: 'existing' });
  harness.runtimeManager.getClient.mockReturnValue({
    ...harness.handle,
    providerSessionId: 'replacement',
  } as never);
  await expect(
    createStartupCoordinator(harness).getOrCreateSessionClient('session-1', {
      resumePolicy: 'require_existing',
    })
  ).rejects.toThrow('Required existing conversation');
});
