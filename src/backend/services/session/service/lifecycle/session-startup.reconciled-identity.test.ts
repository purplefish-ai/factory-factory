import { describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { parseAcpConfigSnapshot } from './acp-config-snapshot';
import { setupStartupConfig } from './session-startup-config.test-helpers';

vi.mock('@/backend/services/codex-accounts', () => ({
  NATIVE_DEFAULT_CODEX_ACCOUNT_ID: 'codex-native-default',
  codexAccountService: {
    getRuntimeContext: vi.fn(async (accountId = 'codex-native-default') => ({
      accountId,
      homeDir: '/test/codex',
      sessionsDir: '/test/codex/sessions',
      env: { CODEX_HOME: '/test/codex' },
    })),
  },
}));

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

describe('startup after durable provider identity reconciliation', () => {
  it.each([false, true])(
    'completes fallback readiness (applied launch settings present: %s)',
    async (appliedLaunch) => {
      const h = setupStartupConfig('CODEX', {
        kind: 'resume_fallback',
        previousProviderSessionId: 'thread',
        reason: 'load_failed',
      });
      h.handle.providerSessionId = 'replacement';
      // The supervisor commits both the replacement identity and snapshot before handoff.
      h.setSession({
        providerSessionId: 'replacement',
        providerMetadata: unsafeCoerce({
          ...(appliedLaunch ? { launchSettings: { reasoningEffort: 'high', applied: true } } : {}),
          acpConfigSnapshot: {
            provider: 'CODEX',
            providerSessionId: 'replacement',
            configOptions: h.handle.configOptions,
          },
        }),
      });

      await expect(h.service.getOrCreateSessionClient(h.session.id)).resolves.toBe(h.handle);

      expect(h.complete).toHaveBeenCalledOnce();
      expect(h.fail).not.toHaveBeenCalled();
      expect(h.row().status).toBe('RUNNING');
      expect(parseAcpConfigSnapshot(h.row().providerMetadata)?.providerSessionId).toBe(
        'replacement'
      );
    }
  );
});
