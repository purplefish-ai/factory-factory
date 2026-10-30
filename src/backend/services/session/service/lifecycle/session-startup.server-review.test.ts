import { describe, expect, it, vi } from 'vitest';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { gate, settleConfig } from './session-config-authority.test-helpers';
import { createLifecycleHarness } from './session-lifecycle.test-helpers';
import { setupStartupConfig } from './session-startup-config.test-helpers';

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: { findById: vi.fn() },
  workspaceNotificationService: {
    listPendingForDelivery: vi.fn(() => Promise.resolve([])),
    findForDelivery: vi.fn(() => Promise.resolve(null)),
    markDelivered: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('@/backend/services/settings', () => ({
  userSettingsService: {
    get: vi.fn(() =>
      Promise.resolve({ defaultClaudeReasoningEffort: null, defaultCodexReasoningEffort: null })
    ),
  },
}));

describe('server review startup ownership contracts', () => {
  it.each([false, true])(
    'publishes failed acquisition state only without a replacement (replacement: %s)',
    async (replaced) => {
      const h = createLifecycleHarness();
      const replacement = createTestProcessHandle();
      const failReplacement = vi.spyOn(replacement, 'failConfiguration');
      const error = new Error('creation failed');
      h.runtimeManager.getOrCreateClient.mockImplementation(() => {
        if (replaced) {
          h.runtimeManager.getClient.mockReturnValue(replacement);
        }
        return Promise.reject(error);
      });
      await expect(h.service.getOrCreateSessionClient(h.session.id)).rejects.toBe(error);
      const failed = h.sessionDomainService.setRuntimeSnapshot.mock.calls.filter(
        ([, state]) => state.phase === 'error'
      );
      expect(failed).toHaveLength(replaced ? 0 : 1);
      if (!replaced) {
        expect(failed[0]?.[1]).toMatchObject({
          phase: 'error',
          processState: 'stopped',
          errorMessage: 'Failed to start agent: creation failed',
        });
      }
      expect(failReplacement).not.toHaveBeenCalled();
      expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
    }
  );

  it.each(['desired-read', 'required-restore'] as const)(
    'rejects real shared readiness and stops its matching candidate after mandatory %s fails',
    async (phase) => {
      const h = setupStartupConfig();
      const held = gate();
      const error = new Error(`mandatory ${phase} unavailable`);
      if (phase === 'desired-read') {
        const read = h.accessor.findById.getMockImplementation();
        if (!read) {
          throw new Error('Expected real accessor');
        }
        let failed = false;
        h.accessor.findById.mockImplementation(async () => {
          if (!failed && h.runtimeManager.getClient(h.session.id) === h.handle) {
            failed = true;
            await held.wait();
            throw error;
          }
          return read();
        });
      } else {
        h.setSession({
          providerMetadata: unsafeCoerce({
            acpConfigSnapshot: {
              provider: 'CODEX',
              providerSessionId: 'thread',
              capturedAt: new Date(0).toISOString(),
              configOptions: h.handle.configOptions.map((option) =>
                option.id === 'reasoning_effort' ? { ...option, currentValue: 'high' } : option
              ),
            },
          }),
        });
        vi.spyOn(h.handle.connection, 'setSessionConfigOption').mockImplementationOnce(async () => {
          await held.wait();
          throw error;
        });
      }
      const readiness = h.handle.configurationReady?.catch((failure) => failure);
      const starting = h.service
        .getOrCreateSessionClient(
          h.session.id,
          phase === 'required-restore' ? { resumePolicy: 'require_existing' } : {}
        )
        .catch((failure) => failure);
      await held.started;
      expect(await h.service.getOrCreateSessionClient(h.session.id)).toBe(h.handle);
      const borrower = h.config.setSessionModel(h.session.id, 'third').catch((failure) => failure);
      held.release();
      expect(await starting).toEqual(expect.objectContaining({ message: error.message }));
      expect(await readiness).toEqual(expect.objectContaining({ message: error.message }));
      expect(await borrower).toEqual(expect.objectContaining({ message: error.message }));
      expect(h.complete).not.toHaveBeenCalled();
      expect(h.fail).toHaveBeenCalledOnce();
      expect(h.runtimeManager.stopClient).toHaveBeenCalledExactlyOnceWith(h.session.id);
      expect(h.sendSessionMessage).not.toHaveBeenCalled();
    }
  );

  it.each(['oldest-first', 'newest-first'] as const)(
    'finishes current startup through three issued snapshot CAS writes (%s)',
    async (order) => {
      const h = setupStartupConfig();
      const issued = [gate(), gate(), gate()];
      h.hooks.cas = async (number) => {
        if (number > 16) {
          throw new Error('configuration CAS write budget exhausted');
        }
        await issued[number - 1]?.wait();
      };
      const starting = h.service.startSession(h.session.id, { initialPrompt: 'Current prompt' });
      await issued[0]?.started;
      h.native('second');
      await issued[1]?.started;
      h.native('third');
      await issued[2]?.started;
      for (const index of order === 'oldest-first' ? [0, 1, 2] : [2, 1, 0]) {
        issued[index]?.release();
        await settleConfig();
      }
      await starting;
      await settleConfig();
      expect(h.row().model).toBe('third');
      expect(h.row().providerMetadata).toMatchObject({
        acpConfigSnapshot: { observedModelId: 'third' },
      });
      expect(h.accessor.updateIfProviderIdentity.mock.calls.length).toBeLessThanOrEqual(16);
      expect(h.complete).toHaveBeenCalledOnce();
      expect(h.fail).not.toHaveBeenCalled();
      expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
      expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(h.session.id, 'Current prompt');
    }
  );
});

vi.mock('@/backend/services/codex-accounts', () => ({
  NATIVE_DEFAULT_CODEX_ACCOUNT_ID: 'codex-native-default',
  codexAccountService: {
    getRuntimeContext: vi.fn(async (accountId = 'codex-native-default') => ({
      accountId,
      homeDir: '/test/codex',
      sessionsDir: '/test/codex/sessions',
      env: { CODEX_HOME: '/test/codex' },
    })),
    getPreviewRuntimeContext: vi.fn(async ({ accountId = 'codex-native-default' } = {}) => ({
      accountId,
      homeDir: '/test/codex',
      sessionsDir: '/test/codex/sessions',
      env: { CODEX_HOME: '/test/codex' },
    })),
    withAccountReservation: vi.fn(async (input, create) =>
      create(input.accountId ?? 'codex-native-default')
    ),
    getUsage: vi.fn(),
  },
}));
