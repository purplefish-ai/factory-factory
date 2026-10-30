import { describe, expect, it, vi } from 'vitest';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { gate, settleConfig } from './session-config-authority.test-helpers';
import * as permissionPolicy from './session-permission-policy';
import * as savedModes from './session-saved-native-modes';
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

describe('final startup configuration durability and access', () => {
  it.each(['success', 'failure'] as const)(
    'keeps readiness closed until a superseding current snapshot finishes: %s',
    async (outcome) => {
      const h = setupStartupConfig();
      const startupSql = gate();
      const replacementSql = gate();
      h.hooks.cas = async (number) => {
        if (number === 1) {
          await startupSql.wait();
        } else {
          await replacementSql.wait();
          if (outcome === 'failure') {
            throw new Error('replacement unavailable');
          }
        }
      };
      const starting = h.service
        .startSession(h.session.id, { initialPrompt: 'Do work' })
        .catch((error) => error);
      try {
        await startupSql.started;
        h.native();
        await replacementSql.started;
        startupSql.release();
        await settleConfig();
        expect(h.complete).not.toHaveBeenCalled();
        expect(h.sendSessionMessage).not.toHaveBeenCalled();
        expect(h.handle.configurationReady).toBeDefined();
      } finally {
        startupSql.release();
        replacementSql.release();
      }
      const result = await starting;
      await settleConfig();
      if (outcome === 'failure') {
        expect(result).toEqual(expect.objectContaining({ message: 'replacement unavailable' }));
        expect(h.complete).not.toHaveBeenCalled();
        expect(h.fail).toHaveBeenCalled();
        expect(h.runtimeManager.stopClient).toHaveBeenCalledWith(h.session.id);
        expect(h.sendSessionMessage).not.toHaveBeenCalled();
      } else {
        expect(result).toBeUndefined();
        expect(h.row().model).toBe('second');
        expect(h.complete).toHaveBeenCalledOnce();
        expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(h.session.id, 'Do work');
      }
    }
  );

  it('revalidates current authority after the awaited final lifecycle creation check', async () => {
    const h = setupStartupConfig();
    const replacement = gate();
    let stored = false;
    let injected = false;
    h.hooks.cas = async (number) => {
      if (number === 1) {
        stored = true;
      } else {
        await replacement.wait();
      }
    };
    const starting = h.service
      .startSession(h.session.id, {
        initialPrompt: 'Do work',
        assertCurrent: () => {
          if (stored && !injected && h.complete.mock.calls.length === 0) {
            injected = true;
            queueMicrotask(() => h.native());
          }
          return Promise.resolve();
        },
      })
      .catch((error) => error);
    try {
      await replacement.started;
      await settleConfig();
      expect(h.complete).not.toHaveBeenCalled();
      expect(h.sendSessionMessage).not.toHaveBeenCalled();
    } finally {
      replacement.release();
    }
    expect(await starting).toBeUndefined();
    expect(injected).toBe(true);
    expect(h.row().model).toBe('second');
    expect(h.complete).toHaveBeenCalledOnce();
  });

  it('completes readiness in the config-owned commit continuation before returning to lifecycle', async () => {
    const h = setupStartupConfig();
    let readyAtReturn = false;
    h.sessionConfigService.completeStartupConfiguration.mockImplementation(async (id, params) => {
      await h.config.completeStartupConfiguration(id, params);
      readyAtReturn = h.handle.configurationReady === undefined;
      queueMicrotask(() => h.native());
    });
    await h.service.startSession(h.session.id, { initialPrompt: 'Do work' });
    await settleConfig();
    expect(readyAtReturn).toBe(true);
    expect(h.complete).toHaveBeenCalledOnce();
    expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(h.session.id, 'Do work');
    expect(h.row().model).toBe('second');
  });

  it.each(['rpc', 'permission-persistence', 'final-persistence', 'final-check'] as const)(
    'fails closed if STRICT access changes during %s',
    async (phase) => {
      const h = setupStartupConfig();
      if (phase === 'rpc' || phase === 'permission-persistence') {
        h.handle.configOptions = startupConfigOptions('first', 'agent-full-access');
      }
      let injected = false;
      if (phase === 'rpc') {
        h.runtime.setConfigOption.mockImplementationOnce(async (id, key, value) => {
          const retained = await h.controller.setConfigOption(h.handle, key, value, id);
          injected = true;
          h.native('third', 'agent-full-access');
          return retained;
        });
      }
      if (phase === 'permission-persistence' || phase === 'final-persistence') {
        h.hooks.cas = (number) => {
          if (number === 1) {
            injected = true;
            h.native('third', 'agent-full-access');
          }
          return Promise.resolve();
        };
      }
      const result = await h.service
        .startSession(h.session.id, {
          initialPrompt: 'Do work',
          assertCurrent: () => {
            if (
              phase === 'final-check' &&
              h.accessor.updateIfProviderIdentity.mock.calls.length > 0 &&
              !injected &&
              h.complete.mock.calls.length === 0
            ) {
              injected = true;
              queueMicrotask(() => h.native('third', 'agent-full-access'));
            }
            return Promise.resolve();
          },
        })
        .catch((error) => error);
      await settleConfig();
      expect(injected).toBe(true);
      expect(result).toBeInstanceOf(Error);
      expect(h.handle.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
        'agent-full-access'
      );
      expect(h.complete).not.toHaveBeenCalled();
      expect(h.runtimeManager.stopClient).toHaveBeenCalledWith(h.session.id);
      expect(h.sendSessionMessage).not.toHaveBeenCalled();
    }
  );

  it.each(['saved', 'review'] as const)(
    'does not adopt broadened permissions from the %s helper return continuation',
    async (kind) => {
      const h = setupStartupConfig();
      h.handle.configOptions = startupConfigOptions('first', 'read-only');
      if (kind === 'review') {
        h.setSession({ workflow: ADVERSARIAL_REVIEW_WORKFLOW });
        h.handle.configOptions = startupConfigOptions('first', 'read-only').map((option) =>
          option.id === 'collaboration_mode' && option.type === 'select'
            ? { ...option, currentValue: 'plan' }
            : option
        );
      } else {
        h.setSession({
          providerMetadata: unsafeCoerce({
            acpConfigSnapshot: {
              provider: 'CODEX',
              providerSessionId: 'thread',
              capturedAt: new Date(0).toISOString(),
              configOptions: h.handle.configOptions,
            },
          }),
        });
      }
      const originalSaved = savedModes.restoreSavedNativeModes;
      const originalReview = permissionPolicy.applyReadOnlyReviewPermissions;
      const spy =
        kind === 'saved'
          ? vi
              .spyOn(savedModes, 'restoreSavedNativeModes')
              .mockImplementationOnce(async (...args) => {
                const result = await originalSaved(...args);
                h.native('third', 'agent-full-access');
                return result;
              })
          : vi
              .spyOn(permissionPolicy, 'applyReadOnlyReviewPermissions')
              .mockImplementationOnce(async (...args) => {
                const result = await originalReview(...args);
                h.native('third', 'agent-full-access');
                return result;
              });
      try {
        const result = await h.service
          .startSession(h.session.id, { initialPrompt: 'Do work' })
          .catch((error) => error);
        await settleConfig();
        expect(result).toBeInstanceOf(Error);
        expect(h.complete).not.toHaveBeenCalled();
        expect(h.runtimeManager.stopClient).toHaveBeenCalledWith(h.session.id);
        expect(h.sendSessionMessage).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    }
  );

  it('retains saved access at final readiness when strict existing-conversation startup skips current defaults', async () => {
    const h = setupStartupConfig();
    h.setSession({
      providerMetadata: unsafeCoerce({
        acpConfigSnapshot: {
          provider: 'CODEX',
          providerSessionId: 'thread',
          capturedAt: new Date(0).toISOString(),
          configOptions: h.handle.configOptions,
        },
      }),
    });
    let injected = false;
    const result = await h.service
      .getOrCreateSessionClient(h.session.id, {
        resumePolicy: 'require_existing',
        assertCurrent: () => {
          if (
            !injected &&
            h.accessor.updateIfProviderIdentity.mock.calls.length > 0 &&
            h.complete.mock.calls.length === 0
          ) {
            injected = true;
            queueMicrotask(() => h.native('third', 'agent-full-access'));
          }
          return Promise.resolve();
        },
      })
      .catch((error) => error);
    await settleConfig();
    expect(injected).toBe(true);
    expect(h.sessionConfigService.applyConfiguredPermissionPreset).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Error);
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.runtimeManager.stopClient).toHaveBeenCalledExactlyOnceWith(h.session.id);
  });

  it('preserves a newer model observation when its current access still meets STRICT', async () => {
    const h = setupStartupConfig();
    h.handle.configOptions = startupConfigOptions('first', 'agent-full-access');
    h.runtime.setConfigOption.mockImplementationOnce(async (id, key, value) => {
      const retained = await h.controller.setConfigOption(h.handle, key, value, id);
      h.native('third');
      return retained;
    });
    await h.service.startSession(h.session.id, { initialPrompt: 'Do work' });
    await settleConfig();
    expect(h.handle.configOptions).toEqual(startupConfigOptions('third'));
    expect(h.row().model).toBe('third');
    expect(h.complete).toHaveBeenCalledOnce();
    expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(h.session.id, 'Do work');
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
