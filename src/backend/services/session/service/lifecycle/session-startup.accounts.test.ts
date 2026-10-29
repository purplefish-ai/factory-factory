import { describe, expect, it, vi } from 'vitest';
import type { CodexRuntimeContext } from '@/backend/services/codex-accounts';
import { createLifecycleHarness } from './session-lifecycle.test-helpers';
import { SessionStartupCoordinator } from './session-startup.coordinator';

function harness(codexAccountId: string | null) {
  const h = createLifecycleHarness({
    provider: 'CODEX',
    session: { codexAccountId },
    providerSessionId: 'saved-rollout',
  });
  const context: CodexRuntimeContext = {
    accountId: codexAccountId ?? 'codex-native-default',
    homeDir: '/saved/profile',
    sessionsDir: '/saved/profile/sessions',
    env: { CODEX_HOME: '/saved/profile' },
  };
  const accounts = { getRuntimeContext: vi.fn(async () => context) };
  const hydrateProviderHistory = vi.fn(async () => undefined);
  const coordinator = new SessionStartupCoordinator({
    accounts,
    hydrateProviderHistory,
    repository: h.repository,
    contextService: h.contextService,
    acpEnvironment: h.acpEnvironment,
    runtimeManager: h.runtimeManager,
    sessionDomainService: h.sessionDomainService,
    sessionConfigService: h.sessionConfigService,
    acpEventProcessor: h.acpEventProcessor,
    runtimeExitCoordinator: { createHandlers: vi.fn(() => ({})) },
    lifecycleGate: h.lifecycleGate,
    notificationDelivery: h.notificationDeliveryService,
    sendSessionMessage: h.sendSessionMessage,
    stopSession: (id, options) => h.service.stopSession(id, options),
  });
  coordinator.configure({ messageQueue: h.messageQueueBridge });
  return { ...h, coordinator, accounts, context, hydrateProviderHistory };
}

describe('saved Codex account runtime ownership', () => {
  it.each(['active', 'browse'] as const)(
    'uses one persisted context for %s history and spawn',
    async (purpose) => {
      const h = harness('saved-account');
      h.runtimeManager.getSubagentBrowseCapability
        .mockReturnValueOnce(null)
        .mockReturnValue({ version: 1, list: true, read: true, notifications: true });
      if (purpose === 'active') {
        await h.coordinator.getOrCreateSessionClient('session-1');
      } else {
        await h.coordinator.ensureSubagentBrowseSession('session-1');
      }
      expect(h.accounts.getRuntimeContext).toHaveBeenCalledExactlyOnceWith('saved-account');
      expect(h.hydrateProviderHistory).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ codexAccountId: 'saved-account', codexAccountContext: h.context })
      );
      expect(h.runtimeManager.getOrCreateClient).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ codexAccountContext: h.context }),
        expect.any(Object),
        expect.any(Object)
      );
    }
  );
  it('maps a legacy null binding to native-default instead of Auto', async () => {
    const h = harness(null);
    await h.coordinator.getOrCreateSessionClient('session-1');
    expect(h.accounts.getRuntimeContext).toHaveBeenCalledExactlyOnceWith('codex-native-default');
  });
  it('does not spawn or read other history if the bound profile fails validation', async () => {
    const h = harness('missing-account');
    h.accounts.getRuntimeContext.mockRejectedValue(new Error('Account identity changed'));
    await expect(h.coordinator.getOrCreateSessionClient('session-1')).rejects.toThrow(
      'Account identity changed'
    );
    expect(h.runtimeManager.getOrCreateClient).not.toHaveBeenCalled();
    expect(h.hydrateProviderHistory).not.toHaveBeenCalled();
  });
});
