import { describe, expect, it, vi } from 'vitest';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  configOptions,
  gate,
  setupAuthority,
  settleConfig,
} from './session-config-authority.test-helpers';
import { SessionConfigCommitAuthority } from './session-config-commit-authority';

const warning = vi.hoisted(() => vi.fn());
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ warn: warning, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/backend/services/settings', () => ({ userSettingsService: {} }));

describe('startup and publication configuration authority', () => {
  it.each(['startup', 'saved-access', 'review-access'] as const)(
    'preserves native options during the final %s RPC continuation',
    async (kind) => {
      const h = setupAuthority();
      const response = gate();
      h.handle.deferPromptReadiness();
      const session = h.row();
      let mode = 'default';
      let collaboration = 'plan';
      if (kind === 'startup') {
        h.runtime.setConfigOption.mockImplementationOnce(async (_id, id, value) => {
          const retained = await h.controller.setConfigOption(h.handle, id, value, 'session');
          await response.wait();
          return retained;
        });
      } else {
        mode = 'read-only';
        collaboration = kind === 'review-access' ? 'plan' : 'default';
        if (kind === 'saved-access') {
          session.providerMetadata = unsafeCoerce({
            acpConfigSnapshot: {
              provider: 'CODEX',
              providerSessionId: 'thread',
              capturedAt: new Date(0).toISOString(),
              configOptions: configOptions('first', mode),
            },
          });
        } else {
          session.workflow = ADVERSARIAL_REVIEW_WORKFLOW;
        }
        h.runtime.setSessionMode.mockImplementationOnce(async (_id, value) => {
          const retained = await h.controller.setSessionMode(h.handle, value, 'session');
          await response.wait();
          return retained;
        });
      }
      const setting =
        kind === 'startup'
          ? h.service.applyStartupModePreset('session', h.handle, 'plan', 'code')
          : h.service.applyConfiguredPermissionPreset('session', session, h.handle, 'STRICT');
      await response.started;
      h.service.applyConfigOptionsUpdateDelta(
        'session',
        h.handle,
        configOptions('third', mode, 'low', collaboration)
      );
      response.release();
      await setting;
      await settleConfig();
      expect(h.handle.configOptions).toEqual(configOptions('third', mode, 'low', collaboration));
      expect(h.row().model).toBe('third');
      expect(h.models()).toEqual(['third', 'third']);
    }
  );

  it.each(['generic', 'reasoning', 'startup'] as const)(
    'checks authority synchronously after the final %s persistence continuation',
    async (kind) => {
      const h = setupAuthority();
      const publication = gate();
      const original = SessionConfigCommitAuthority.prototype.accept;
      let first = true;
      const spy = vi
        .spyOn(SessionConfigCommitAuthority.prototype, 'accept')
        .mockImplementation(function (
          this: SessionConfigCommitAuthority,
          sessionId,
          assertCurrent
        ) {
          const accepted = original.call(this, sessionId, assertCurrent);
          if (first) {
            first = false;
            const persist = accepted.persist;
            accepted.persist = async (operation) => {
              const retained = await persist(operation);
              await publication.wait();
              return retained;
            };
          }
          return accepted;
        });
      try {
        const setting =
          kind === 'generic'
            ? h.service.setSessionModel('session', 'second')
            : kind === 'reasoning'
              ? h.service.setSessionReasoningEffort('session', 'high')
              : h.service.applyStartupModePreset('session', h.handle, 'plan', 'code');
        await publication.started;
        h.native('third');
        await settleConfig();
        publication.release();
        await setting;
        expect(h.models()).toEqual(['third']);
        expect(h.events.filter((event) => event.type === 'chat_capabilities')).toHaveLength(1);
        expect(h.row().model).toBe('third');
      } finally {
        spy.mockRestore();
      }
    }
  );

  it('captures current installed startup options when a caller retained an earlier snapshot', async () => {
    const h = setupAuthority();
    h.handle.deferPromptReadiness();
    const retained = configOptions('second');
    h.native('third');
    await h.service.persistAcpConfigSnapshot('session', {
      provider: 'CODEX',
      providerSessionId: 'thread',
      configOptions: retained,
    });
    await settleConfig();
    expect(h.row().model).toBe('third');
  });

  it('owns fire-and-forget native persistence failures without a late success event', async () => {
    const h = setupAuthority();
    h.hooks.cas = () => {
      h.statusWrite();
      return Promise.resolve();
    };
    h.native('second');
    await settleConfig();
    expect(warning).toHaveBeenCalledWith(
      'Failed persisting native configuration update',
      expect.objectContaining({ sessionId: 'session', error: expect.any(Error) })
    );
    expect(h.row().model).toBe('first');
    expect(h.models()).toEqual(['second']);
  });

  it('reports a real persistence failure after both CAS attempts fail', async () => {
    const h = setupAuthority();
    h.hooks.cas = () => {
      h.statusWrite();
      return Promise.resolve();
    };
    await expect(h.service.setSessionModel('session', 'second')).rejects.toThrow(
      'Stale provider metadata'
    );
    expect(h.casModels).toEqual(['second', 'second']);
    expect(h.row().model).toBe('first');
  });
});
