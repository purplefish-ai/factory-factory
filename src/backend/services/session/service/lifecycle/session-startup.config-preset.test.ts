import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { settleConfig } from './session-config-authority.test-helpers';
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
  userSettingsService: {
    get: vi.fn(() =>
      Promise.resolve({ defaultClaudeReasoningEffort: null, defaultCodexReasoningEffort: null })
    ),
  },
}));

function claudeOptions(mode = 'default'): SessionConfigOption[] {
  return startupConfigOptions('first').map((option) =>
    option.id === 'mode' && option.type === 'select'
      ? {
          ...option,
          currentValue: mode,
          options: ['default', 'plan', 'acceptEdits', 'bypassPermissions'].map((value) => ({
            value,
            name: value,
          })),
        }
      : option
  );
}

function setupClaude(saved = false) {
  const h = setupStartupConfig('CLAUDE');
  h.handle.configOptions = claudeOptions();
  if (saved) {
    h.setSession({
      providerMetadata: unsafeCoerce({
        acpConfigSnapshot: {
          provider: 'CLAUDE',
          providerSessionId: 'thread',
          capturedAt: new Date(0).toISOString(),
          configOptions: claudeOptions(),
        },
      }),
    });
  }
  return {
    ...h,
    observe: (mode: string) =>
      h.config.applyConfigOptionsUpdateDelta(h.session.id, h.handle, claudeOptions(mode)),
  };
}

describe('explicit startup planning authorization', () => {
  it.each(['configured', 'saved', 'inherited'] as const)(
    'allows confirmed Claude plan startup after %s STRICT access',
    async (kind) => {
      const h = setupClaude(kind !== 'configured');
      const result = await (
        kind === 'inherited'
          ? h.service.getOrCreateSessionClient(h.session.id, {
              startupModePreset: 'plan',
              resumePolicy: 'require_existing',
            })
          : h.service.startSession(h.session.id, {
              initialPrompt: 'Do work',
              startupModePreset: 'plan',
            })
      ).catch((error) => error);
      expect(h.runtime.setSessionMode).toHaveBeenCalledExactlyOnceWith(h.session.id, 'plan');
      expect(result).toBe(kind === 'inherited' ? h.handle : undefined);
      expect(h.row().providerMetadata).toMatchObject({
        acpConfigSnapshot: {
          configOptions: expect.arrayContaining([
            expect.objectContaining({ id: 'mode', currentValue: 'plan' }),
          ]),
        },
      });
      expect(h.complete).toHaveBeenCalledOnce();
      if (kind === 'inherited') {
        expect(h.sessionConfigService.applyConfiguredPermissionPreset).not.toHaveBeenCalled();
        expect(h.sendSessionMessage).not.toHaveBeenCalled();
      } else {
        expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(h.session.id, 'Do work');
      }
      expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
    }
  );

  it('authorizes an explicit already-confirmed target without another RPC', async () => {
    const h = setupClaude();
    const original = h.config.applyConfiguredPermissionPreset.bind(h.config);
    h.sessionConfigService.applyConfiguredPermissionPreset.mockImplementation(async (...args) => {
      await original(...args);
      h.observe('plan');
    });
    await expect(
      h.service.startSession(h.session.id, { initialPrompt: 'Do work', startupModePreset: 'plan' })
    ).resolves.toBeUndefined();
    expect(h.runtime.setSessionMode).not.toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledOnce();
    expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'rejected-confirmed-target', 'unavailable', 'optional-storage'] as const)(
    'preserves optional preset compatibility: %s',
    async (phase) => {
      const h = setupClaude();
      if (phase === 'rejected-confirmed-target') {
        h.runtime.setSessionMode.mockImplementationOnce(() => {
          h.observe('plan');
          return Promise.reject(new Error('RPC failed after target observation'));
        });
      }
      if (phase === 'rejected') {
        h.runtime.setSessionMode.mockRejectedValueOnce(new Error('plan unavailable'));
      }
      if (phase === 'unavailable') {
        h.handle.configOptions = h.handle.configOptions.map((option) =>
          option.id === 'mode' && option.type === 'select'
            ? { ...option, options: [{ value: 'default', name: 'default' }] }
            : option
        );
      }
      if (phase === 'optional-storage') {
        h.sessionConfigService.persistAcpConfigSnapshot.mockRejectedValueOnce(
          new Error('optional snapshot unavailable')
        );
      }
      await expect(
        h.service.startSession(h.session.id, {
          initialPrompt: 'Do work',
          startupModePreset: 'plan',
        })
      ).resolves.toBeUndefined();
      expect(h.handle.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
        phase === 'optional-storage' || phase === 'rejected-confirmed-target' ? 'plan' : 'default'
      );
      expect(h.complete).toHaveBeenCalledOnce();
      expect(h.sendSessionMessage).toHaveBeenCalledOnce();
      expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
    }
  );

  it.each(['rpc', 'optional-storage', 'final-check', 'rejected-rpc', 'no-preset'] as const)(
    'rejects unexpected Claude access during %s',
    async (phase) => {
      const h = setupClaude();
      if (phase === 'rpc' || phase === 'rejected-rpc') {
        h.runtime.setSessionMode.mockImplementationOnce(async (id, value) => {
          if (phase === 'rpc') {
            await h.controller.setSessionMode(h.handle, value, id);
          }
          h.observe('bypassPermissions');
          if (phase === 'rejected-rpc') {
            throw new Error('plan unavailable');
          }
          return h.handle.configOptions;
        });
      }
      if (phase === 'optional-storage') {
        h.hooks.cas = (number) => {
          if (number === 1) {
            h.observe('bypassPermissions');
          }
          return Promise.resolve();
        };
      }
      let injected = false;
      const result = await h.service
        .startSession(h.session.id, {
          initialPrompt: 'Do work',
          ...(phase === 'no-preset' ? {} : { startupModePreset: 'plan' as const }),
          assertCurrent: () => {
            if (
              (phase === 'final-check' || phase === 'no-preset') &&
              !injected &&
              h.accessor.updateIfProviderIdentity.mock.calls.length > 0 &&
              !h.complete.mock.calls.length
            ) {
              injected = true;
              queueMicrotask(() => h.observe('bypassPermissions'));
            }
            return Promise.resolve();
          },
        })
        .catch((error) => error);
      await settleConfig();
      expect(result).toEqual(
        expect.objectContaining({ message: 'Configured session access mode was not applied' })
      );
      expect(h.complete).not.toHaveBeenCalled();
      expect(h.sendSessionMessage).not.toHaveBeenCalled();
      expect(h.runtimeManager.stopClient).toHaveBeenCalledExactlyOnceWith(h.session.id);
    }
  );

  it('persists Codex planning while keeping independently configured STRICT access', async () => {
    const h = setupStartupConfig();
    await h.service.startSession(h.session.id, {
      initialPrompt: 'Do work',
      startupModePreset: 'plan',
    });
    expect(h.row().providerMetadata).toMatchObject({
      acpConfigSnapshot: {
        configOptions: expect.arrayContaining([
          expect.objectContaining({ id: 'mode', currentValue: 'workspace-write' }),
          expect.objectContaining({ id: 'collaboration_mode', currentValue: 'plan' }),
        ]),
      },
    });
    expect(h.complete).toHaveBeenCalledOnce();
    expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(h.session.id, 'Do work');
    expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
  });

  it('keeps Codex access required when an explicit plan preset changes collaboration only', async () => {
    const h = setupStartupConfig();
    h.runtime.setConfigOption.mockImplementationOnce(async (id, key, value) => {
      const result = await h.controller.setConfigOption(h.handle, key, value, id);
      h.native('second', 'agent-full-access');
      return result;
    });
    await expect(
      h.service.startSession(h.session.id, { initialPrompt: 'Do work', startupModePreset: 'plan' })
    ).rejects.toThrow('Configured session access mode was not applied');
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.runtimeManager.stopClient).toHaveBeenCalledExactlyOnceWith(h.session.id);
  });
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
