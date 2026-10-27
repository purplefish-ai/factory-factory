import { describe, expect, it, vi } from 'vitest';
import {
  createDeferred,
  createTestProcessHandle,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionConfigService } from './session.config.service';

vi.mock('@/backend/services/settings', () => ({ userSettingsService: {} }));

function fixture(cached = false) {
  const session = {
    id: 'session',
    provider: 'CODEX',
    providerSessionId: null,
    model: 'first',
    workflow: 'code',
    providerMetadata: cached
      ? {
          acpConfigSnapshot: {
            provider: 'CODEX',
            providerSessionId: 'thread',
            configOptions: [
              {
                id: 'model',
                category: 'model',
                name: 'Model',
                type: 'select',
                currentValue: 'first',
                options: ['first', 'second'].map((value) => ({ value, name: value })),
              },
            ],
          },
        }
      : null,
  };
  const repository = {
    getSessionById: vi.fn().mockResolvedValue(session),
    updateSession: vi
      .fn()
      .mockImplementation((_id: string, update: object, _assertCurrent?: () => void) =>
        Promise.resolve(Object.assign(session, update))
      ),
  };
  const runtime = {
    getClient: vi.fn(),
    getPendingClient: vi.fn(),
    isStopInProgress: vi.fn(() => false),
    setSessionModel: vi.fn(),
  };
  const models = [
    { id: 'first', displayName: 'First', isDefault: true },
    { id: 'second', displayName: 'Second' },
  ];
  const catalog = { getModels: vi.fn().mockResolvedValue(models) };
  const domain = { emitDelta: vi.fn() };
  const service = new SessionConfigService({
    repository: unsafeCoerce(repository),
    runtimeManager: unsafeCoerce(runtime),
    codexModelCatalogService: catalog,
    sessionDomainService: unsafeCoerce(domain),
  });
  return { service, session, repository, runtime, models, catalog, domain };
}

describe('inactive Codex model intent before first startup', () => {
  it.each(['generic', 'legacy'] as const)(
    'persists an advertised model via %s without inventing a native snapshot',
    async (endpoint) => {
      const f = fixture();
      const options = await f.service.getSessionConfigOptionsWithFallback('session');
      expect(options.find((option) => option.category === 'model')?.currentValue).toBe('first');
      expect(f.repository.updateSession).not.toHaveBeenCalled();
      if (endpoint === 'generic') {
        await f.service.setSessionConfigOption('session', 'model', 'second');
      } else {
        await f.service.setSessionModel('session', 'second');
      }
      expect(f.session.model).toBe('second');
      expect(f.session.providerSessionId).toBeNull();
      expect(f.session.providerMetadata).toBeNull();
      expect(f.repository.updateSession).toHaveBeenCalledWith(
        'session',
        { model: 'second' },
        expect.any(Function)
      );
      expect(f.domain.emitDelta).toHaveBeenCalledWith(
        'session',
        expect.objectContaining({
          type: 'config_options_update',
          configOptions: expect.arrayContaining([
            expect.objectContaining({ category: 'model', currentValue: 'second' }),
          ]),
        })
      );
      expect(f.domain.emitDelta).toHaveBeenCalledWith(
        'session',
        expect.objectContaining({
          type: 'chat_capabilities',
          capabilities: expect.objectContaining({
            provider: 'CODEX',
            model: expect.objectContaining({ selected: 'second' }),
          }),
        })
      );
    }
  );

  it.each([
    ['model', 'missing'],
    ['mode', 'agent-full-access'],
    ['reasoning_effort', 'high'],
  ])('rejects unavailable %s choices without cached native configuration', async (id, value) => {
    const f = fixture();
    await expect(f.service.setSessionConfigOption('session', id, value)).rejects.toThrow();
    expect(f.repository.updateSession).not.toHaveBeenCalled();
    expect(f.domain.emitDelta).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'keeps an edit after pending startup fails, with cached configuration %s',
    async (cached) => {
      const f = fixture(cached);
      const pending = createDeferred<ReturnType<typeof createTestProcessHandle>>();
      f.runtime.getPendingClient.mockReturnValueOnce(pending.promise);
      const setting = f.service
        .setSessionConfigOption('session', 'model', 'second')
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(f.runtime.getPendingClient).toHaveBeenCalled());
      expect(f.repository.updateSession).not.toHaveBeenCalled();
      pending.reject(new Error('Session startup cancelled'));
      expect(await setting).toBeUndefined();
      expect(f.session.model).toBe('second');
    }
  );

  it('routes a cached edit to a runtime that starts at the persistence guard', async () => {
    const f = fixture(true);
    const handle = createTestProcessHandle({ provider: 'CODEX', providerSessionId: 'thread' });
    handle.configOptions = [
      {
        id: 'model',
        category: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'first',
        options: f.models.map((model) => ({ value: model.id, name: model.displayName })),
      },
    ];
    f.runtime.setSessionModel.mockResolvedValue(
      handle.configOptions.map((option) =>
        option.type === 'select' ? { ...option, currentValue: 'second' } : option
      )
    );
    let guarded = false;
    f.repository.updateSession.mockImplementationOnce(
      (_id, _update, assertCurrent?: () => void) => {
        f.runtime.getClient.mockReturnValue(handle);
        guarded = typeof assertCurrent === 'function';
        assertCurrent?.();
        return Promise.resolve(f.session);
      }
    );
    await f.service.setSessionConfigOption('session', 'model', 'second');
    expect(guarded).toBe(true);
    expect(f.runtime.setSessionModel).toHaveBeenCalledWith('session', 'second');
    expect(f.session.model).toBe('second');
  });

  it('preserves the legacy native-default intent instead of storing the displayed catalog default', async () => {
    const f = fixture();
    f.session.model = 'second';
    await f.service.setSessionModel('session', 'default');
    expect(f.session.model).toBe('default');
    expect(f.session.providerMetadata).toBeNull();
    expect(f.domain.emitDelta).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({
        type: 'chat_capabilities',
        capabilities: expect.objectContaining({
          model: expect.objectContaining({ selected: 'first' }),
        }),
      })
    );
  });

  it('routes a choice through the live runtime if startup completes during discovery', async () => {
    const f = fixture();
    const discovering = createDeferred<typeof f.models>();
    f.catalog.getModels.mockReturnValue(discovering.promise);
    const setting = f.service.setSessionConfigOption('session', 'model', 'second');
    await vi.waitFor(() => expect(f.catalog.getModels).toHaveBeenCalled());
    const handle = createTestProcessHandle({ provider: 'CODEX', providerSessionId: 'thread' });
    handle.configOptions = [
      {
        id: 'model',
        category: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'first',
        options: f.models.map((model) => ({ value: model.id, name: model.displayName })),
      },
    ];
    f.runtime.getClient.mockReturnValue(handle);
    f.runtime.setSessionModel.mockImplementation(() =>
      Promise.resolve(
        handle.configOptions.map((option) =>
          option.type === 'select' ? { ...option, currentValue: 'second' } : option
        )
      )
    );
    discovering.resolve(f.models);
    await setting;
    expect(f.runtime.setSessionModel).toHaveBeenCalledWith('session', 'second');
    expect(f.repository.updateSession).not.toHaveBeenCalledWith(
      'session',
      { model: 'second' },
      expect.any(Function)
    );
  });
});
