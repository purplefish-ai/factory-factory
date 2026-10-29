import { describe, expect, it, vi } from 'vitest';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { gate, settleConfig } from './session-config-authority.test-helpers';
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

describe('final startup failure ownership', () => {
  it.each(['registration', 'owner-reuse'] as const)(
    'stops a shared current normal candidate when required access changes at the final gate: %s',
    async (sharing) => {
      const h = setupStartupConfig();
      h.runtimeManager.runClientCreationOperation.mockImplementation((_id, _purpose, operation) =>
        operation({ isOnlyOperation: () => false })
      );
      const writing = gate();
      h.hooks.cas = async (number) => {
        if (number === 1) {
          await writing.wait();
        }
      };
      let injected = false;
      const starting = h.service
        .startSession(h.session.id, {
          initialPrompt: 'Do work',
          assertCurrent: () => {
            if (!injected && h.accessor.updateIfProviderIdentity.mock.calls.length > 0) {
              injected = true;
              queueMicrotask(() => h.native('third', 'agent-full-access'));
            }
            return Promise.resolve();
          },
        })
        .catch((error) => error);
      await writing.started;
      if (sharing === 'owner-reuse') {
        expect(await h.service.getOrCreateSessionClient(h.session.id)).toBe(h.handle);
      }
      writing.release();
      const result = await starting;
      await settleConfig();
      expect(result).toBeInstanceOf(Error);
      expect(h.complete).not.toHaveBeenCalled();
      expect(h.fail).toHaveBeenCalledOnce();
      expect(h.runtimeManager.stopClient).toHaveBeenCalledExactlyOnceWith(h.session.id);
      expect(h.sendSessionMessage).not.toHaveBeenCalled();
    }
  );

  it('does not stop or fail a replacement installed while the old candidate fails its final check', async () => {
    const h = setupStartupConfig();
    const replacement = createTestProcessHandle({ providerSessionId: 'thread' });
    const replacementFailure = vi.spyOn(replacement, 'failConfiguration');
    let injected = false;
    const result = await h.service
      .startSession(h.session.id, {
        initialPrompt: 'Do work',
        assertCurrent: () => {
          if (!injected && h.accessor.updateIfProviderIdentity.mock.calls.length > 0) {
            injected = true;
            h.native('third', 'agent-full-access');
            h.runtimeManager.getClient.mockReturnValue(replacement);
          }
          return Promise.resolve();
        },
      })
      .catch((error) => error);
    await settleConfig();
    expect(result).toBeInstanceOf(Error);
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
    expect(replacementFailure).not.toHaveBeenCalled();
    expect(h.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('retains shared cleanup protections for caller cancellation in the final async check', async () => {
    const h = setupStartupConfig();
    const writing = gate();
    h.hooks.cas = async (number) => {
      if (number === 1) {
        await writing.wait();
      }
    };
    let cancelled = false;
    const cancellation = new Error('request no longer current');
    const starting = h.service
      .startSession(h.session.id, {
        initialPrompt: 'Do work',
        assertCurrent: () => (cancelled ? Promise.reject(cancellation) : Promise.resolve()),
      })
      .catch((error) => error);
    await writing.started;
    expect(await h.service.getOrCreateSessionClient(h.session.id)).toBe(h.handle);
    cancelled = true;
    const snapshots = h.sessionDomainService.setRuntimeSnapshot.mock.calls.length;
    const clearing = h.acpEventProcessor.clearSessionState.mock.calls.length;
    writing.release();
    expect(await starting).toBe(cancellation);
    expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
    expect(h.runtimeManager.stopAndQuiesce).not.toHaveBeenCalled();
    expect(h.sessionDomainService.setRuntimeSnapshot.mock.calls).toHaveLength(snapshots);
    expect(h.acpEventProcessor.clearSessionState.mock.calls).toHaveLength(clearing);
    expect(h.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('preserves a replacement when final snapshot I/O rejects after replacement', async () => {
    const h = setupStartupConfig();
    const writing = gate();
    const replacement = createTestProcessHandle({ providerSessionId: 'thread' });
    const failure = vi.spyOn(replacement, 'failConfiguration');
    h.hooks.cas = async () => {
      await writing.wait();
      throw new Error('storage unavailable');
    };
    const starting = h.service
      .startSession(h.session.id, { initialPrompt: 'Do work' })
      .catch((error) => error);
    await writing.started;
    h.runtimeManager.getClient.mockReturnValue(replacement);
    const snapshots = h.sessionDomainService.setRuntimeSnapshot.mock.calls.length;
    writing.release();
    expect(await starting).toBeInstanceOf(Error);
    expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(h.sessionDomainService.setRuntimeSnapshot.mock.calls).toHaveLength(snapshots);
    expect(h.acpEventProcessor.clearSessionState).not.toHaveBeenCalled();
  });

  it('leaves a newer completed user stop authoritative when final snapshot I/O fails late', async () => {
    const h = setupStartupConfig();
    const writing = gate();
    h.hooks.cas = async () => {
      await writing.wait();
      throw new Error('storage unavailable');
    };
    const starting = h.service
      .startSession(h.session.id, { initialPrompt: 'Do work' })
      .catch((error) => error);
    await writing.started;
    await h.service.stopSession(h.session.id, { reason: 'USER_STOP' });
    const snapshots = h.sessionDomainService.setRuntimeSnapshot.mock.calls.length;
    const clearing = h.acpEventProcessor.clearSessionState.mock.calls.length;
    writing.release();
    expect(await starting).toBeInstanceOf(Error);
    expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
    expect(h.sessionDomainService.setRuntimeSnapshot.mock.calls).toHaveLength(snapshots);
    expect(h.acpEventProcessor.clearSessionState.mock.calls).toHaveLength(clearing);
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('keeps native post-ready persistence failure best effort without stopping the healthy runtime', async () => {
    const h = setupStartupConfig();
    await h.service.startSession(h.session.id, { initialPrompt: 'Do work' });
    h.hooks.cas = () => Promise.reject(new Error('native storage unavailable'));
    h.native('third');
    await settleConfig();
    expect(h.handle.configurationReady).toBeUndefined();
    expect(h.fail).not.toHaveBeenCalled();
    expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
    expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(h.session.id, 'Do work');
  });

  it('preserves the terminal config error and poisoned readiness if stopping the failed shared child rejects', async () => {
    const h = setupStartupConfig();
    h.runtimeManager.runClientCreationOperation.mockImplementation((_id, _purpose, operation) =>
      operation({ isOnlyOperation: () => false })
    );
    h.runtimeManager.stopClient.mockRejectedValueOnce(new Error('stop unavailable'));
    const writing = gate();
    h.hooks.cas = async (number) => {
      if (number === 1) {
        await writing.wait();
      }
      throw new Error('storage unavailable');
    };
    const starting = h.service
      .startSession(h.session.id, { initialPrompt: 'Do work' })
      .catch((error) => error);
    await writing.started;
    const readiness = h.handle.configurationReady;
    if (!readiness) {
      throw new Error('Expected pending startup readiness at the final snapshot write');
    }
    const waiting = readiness.catch((error: unknown) => error);
    writing.release();
    const result = await starting;
    expect(await waiting).toEqual(expect.objectContaining({ message: 'storage unavailable' }));
    expect(result).toEqual(expect.objectContaining({ message: 'storage unavailable' }));
    expect(h.runtimeManager.stopClient).toHaveBeenCalledExactlyOnceWith(h.session.id);
    expect(h.lifecycleGate.isSessionStopping(h.session.id)).toBe(false);
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.sendSessionMessage).not.toHaveBeenCalled();
  });

  it.each(['registration', 'owner-reuse'] as const)(
    'stops the same shared candidate after terminal final persistence failure: %s',
    async (sharing) => {
      const h = setupStartupConfig();
      h.runtimeManager.runClientCreationOperation.mockImplementation((_id, _purpose, operation) =>
        operation({ isOnlyOperation: () => false })
      );
      const writing = gate();
      h.hooks.cas = async (number) => {
        if (number === 1) {
          await writing.wait();
        }
        throw new Error('storage unavailable');
      };
      const readiness = h.handle.configurationReady;
      if (!readiness) {
        throw new Error('Expected pending startup readiness');
      }
      const waiting = readiness.catch((error) => error);
      const starting = h.service
        .startSession(h.session.id, { initialPrompt: 'Do work' })
        .catch((error) => error);
      await writing.started;
      if (sharing === 'owner-reuse') {
        expect(await h.service.getOrCreateSessionClient(h.session.id)).toBe(h.handle);
      }
      writing.release();
      const result = await starting;
      expect(result).toEqual(expect.objectContaining({ message: 'storage unavailable' }));
      expect(await waiting).toBeInstanceOf(Error);
      expect(h.complete).not.toHaveBeenCalled();
      expect(h.fail).toHaveBeenCalledOnce();
      expect(h.runtimeManager.stopClient).toHaveBeenCalledExactlyOnceWith(h.session.id);
      expect(h.sendSessionMessage).not.toHaveBeenCalled();
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
