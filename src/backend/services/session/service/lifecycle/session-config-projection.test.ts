import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it, vi } from 'vitest';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { SessionLoadService } from '@/backend/services/session/service/chat/session-load.service';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { CodexModelCatalogService } from './codex-model-catalog.service';
import type { ResolvedSessionConfigProjection } from './session-config-projection';
import { SessionConfigService } from './session.config.service';

type ModelCatalog = Awaited<ReturnType<CodexModelCatalogService['getModels']>>;
const catalogModel: ModelCatalog[number] = {
  id: 'catalog',
  displayName: 'Catalog',
  description: '',
  defaultReasoningEffort: null,
  supportedReasoningEfforts: [],
  inputModalities: ['text'],
  isDefault: true,
};

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/backend/services/settings', () => ({ userSettingsService: {} }));

function ready(resolved: ResolvedSessionConfigProjection) {
  const current = resolved.currentProjection();
  if ('retry' in current) {
    throw new Error('Expected a current projection');
  }
  return current;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function options(model = 'stored'): SessionConfigOption[] {
  return [
    {
      id: 'model',
      category: 'model',
      name: 'Model',
      type: 'select',
      currentValue: model,
      options: [{ value: model, name: model }],
    },
  ];
}
function row(
  provider: 'CLAUDE' | 'CODEX' = 'CODEX',
  configOptions: SessionConfigOption[] = options()
) {
  return {
    provider,
    model: 'stored',
    providerMetadata: {
      acpConfigSnapshot: {
        provider,
        providerSessionId: 'native-id',
        configOptions,
        observedModelId: 'stored',
      },
    },
  };
}
function setup() {
  const fetchModels = vi.fn<() => Promise<ModelCatalog>>(async () => []);
  const repository = { getSessionById: vi.fn(async () => row()), updateSession: vi.fn() };
  let handle: AcpProcessHandle | undefined;
  let pending = false;
  const forbidden = () => {
    throw new Error('Passive projection must not enter startup or native discovery');
  };
  const runtime = {
    getClient: () => (pending ? undefined : handle),
    getPendingClient: vi.fn(forbidden),
    getInstalledHandle: vi.fn(forbidden),
  };
  const launchOptions = { getOptions: vi.fn(forbidden) };
  const domain = {
    finishLoad: vi.fn(),
    emitDelta: vi.fn(),
    consumeInitialMessage: vi.fn(() => null),
  };
  const config = new SessionConfigService({
    repository: unsafeCoerce(repository),
    runtimeManager: unsafeCoerce(runtime),
    launchOptionsService: launchOptions,
    codexModelCatalogService: new CodexModelCatalogService({ fetchModels }),
    sessionDomainService: unsafeCoerce(domain),
  });
  const load = new SessionLoadService(
    unsafeCoerce({ config, domain, getCachedCommands: async () => [] })
  );
  return {
    config,
    load,
    repository,
    fetchModels,
    domain,
    runtime,
    launchOptions,
    beginPending() {
      pending = true;
      handle = unsafeCoerce<AcpProcessHandle>({
        provider: 'CODEX',
        configOptions: options('live'),
      });
      return {
        confirm: () => {
          pending = false;
        },
        reject: () => {
          pending = false;
          handle = undefined;
        },
      };
    },
    retireHandle() {
      handle = undefined;
    },
    setHandle(configOptions = options('live')) {
      handle = unsafeCoerce<AcpProcessHandle>({ provider: 'CODEX', configOptions });
      return handle;
    },
  };
}
function prepareCatalogAtPhase(test: ReturnType<typeof setup>, stage: string, fails: boolean) {
  const catalog = stage === 'catalog' ? deferred<ModelCatalog>() : null;
  if (fails) {
    test.fetchModels.mockRejectedValue(new Error('catalog unavailable'));
  } else {
    test.fetchModels.mockResolvedValue([catalogModel]);
  }
  if (catalog) {
    test.fetchModels.mockReturnValueOnce(catalog.promise);
  }
  return () => {
    if (fails) {
      catalog?.reject(new Error('catalog unavailable'));
    } else {
      catalog?.resolve([catalogModel]);
    }
  };
}
const prepared = {
  status: 'ready',
  sessionId: 'session',
  provider: 'CODEX',
  worktreePath: null,
} as const;

// Removing the combined resolver restores two failed subprocess discoveries/four row reads.
describe('load configuration projection', () => {
  it.each(
    ['fast live', 'live after initial read', 'empty replacement'].flatMap((origin) =>
      [false, true].map((catalogFails) => ({ origin, catalogFails }))
    )
  )(
    'publishes durable controls after $origin retires (catalog failure=$catalogFails)',
    async ({ origin, catalogFails }) => {
      const test = setup();
      const controls = (model: string, effort: string, plan: string): SessionConfigOption[] => [
        ...options(model),
        {
          id: 'thought_level',
          name: 'Effort',
          type: 'select',
          currentValue: effort,
          options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
          ],
        },
        {
          id: 'collaboration_mode',
          category: 'collaboration_mode',
          name: 'Plan',
          type: 'select',
          currentValue: plan,
          options: [
            { value: 'default', name: 'Default' },
            { value: 'plan', name: 'Plan' },
          ],
        },
      ];
      if (origin === 'live after initial read') {
        test.repository.getSessionById.mockImplementationOnce(() => {
          test.setHandle(controls('retired', 'high', 'plan'));
          return Promise.resolve(row());
        });
      } else {
        test.setHandle(controls('retired', 'high', 'plan'));
      }
      const durable = row('CODEX', controls('durable', 'low', 'default'));
      durable.model = 'durable';
      const resolve = test.config.getSessionConfigProjection.bind(test.config);
      vi.spyOn(test.config, 'getSessionConfigProjection').mockImplementation(async (id) => {
        const result = await resolve(id);
        queueMicrotask(() => {
          if (origin === 'empty replacement') {
            test.setHandle([]);
          } else {
            test.retireHandle();
          }
          test.repository.getSessionById.mockResolvedValue(durable);
        });
        return result;
      });
      if (catalogFails) {
        test.fetchModels.mockRejectedValue(new Error('catalog unavailable'));
      } else {
        test.fetchModels.mockResolvedValue([
          {
            ...catalogModel,
            id: 'durable',
            defaultReasoningEffort: 'high',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: undefined },
              { reasoningEffort: 'high', description: undefined },
            ],
          },
        ]);
      }
      const calls: string[] = [];
      const domain = {
        ...test.domain,
        finishLoad: () => {
          calls.push('runtime');
        },
        emitDelta: (_id: string, event: unknown) => {
          calls.push('publish');
          test.domain.emitDelta(_id, event);
        },
        consumeInitialMessage: () => {
          calls.push('consume');
          return 'Initial text';
        },
        enqueue: () => ({ position: 0 }),
      };
      const load = new SessionLoadService(
        unsafeCoerce({
          config: test.config,
          domain,
          getCachedCommands: () => {
            calls.push('commands');
            return Promise.resolve([]);
          },
          tryDispatchNextMessage: () => {
            calls.push('dispatch');
            return Promise.resolve();
          },
        })
      );
      await load.completeLoad(prepared);
      expect(test.domain.emitDelta.mock.calls.map((call) => call[1])).toMatchObject([
        {
          type: 'chat_capabilities',
          capabilities:
            origin === 'empty replacement'
              ? { model: { enabled: false }, reasoning: { enabled: false } }
              : { model: { selected: 'durable' }, reasoning: { selected: 'low' } },
        },
        {
          type: 'config_options_update',
          configOptions: expect.arrayContaining([
            expect.objectContaining({ id: 'model', currentValue: 'durable' }),
            expect.objectContaining({ id: 'thought_level', currentValue: 'low' }),
            expect.objectContaining({ id: 'collaboration_mode', currentValue: 'default' }),
          ]),
        },
        { type: 'slash_commands' },
        { type: 'message_state_changed' },
      ]);
      expect(calls).toEqual([
        'runtime',
        'publish',
        'publish',
        'commands',
        'publish',
        'consume',
        'publish',
        'dispatch',
      ]);
      expect(test.fetchModels).toHaveBeenCalledTimes(1);
      expect(test.repository.getSessionById).toHaveBeenCalledTimes(
        origin === 'live after initial read' ? 3 : 2
      );
      expect(test.repository.updateSession).not.toHaveBeenCalled();
    }
  );

  it.each(['options', 'capabilities'])(
    'refreshes retired live state for the %s convenience reader',
    async (reader) => {
      const test = setup();
      test.setHandle(options('retired'));
      test.repository.getSessionById.mockResolvedValue(row('CODEX', options('durable')));
      const resolve = test.config.getSessionConfigProjection.bind(test.config);
      vi.spyOn(test.config, 'getSessionConfigProjection').mockImplementation(async (id) => {
        const resolved = await resolve(id);
        queueMicrotask(test.retireHandle);
        return resolved;
      });
      if (reader === 'options') {
        expect(await test.config.getSessionConfigOptionsWithFallback('session')).toEqual(
          options('durable')
        );
      } else {
        expect((await test.config.getChatBarCapabilities('session')).model.selected).toBe(
          'durable'
        );
      }
      expect(test.repository.updateSession).not.toHaveBeenCalled();
    }
  );

  it('rechecks retirement again after a retry result resolves and reuses the failed catalog', async () => {
    const test = setup();
    test.setHandle(options('retired'));
    test.repository.getSessionById.mockResolvedValue(row('CODEX', options('durable')));
    test.fetchModels.mockImplementation(() => {
      test.setHandle(options('intermediate'));
      return Promise.reject(new Error('catalog unavailable'));
    });
    const resolve = test.config.getSessionConfigProjection.bind(test.config);
    let retried = false;
    const watch = (resolved: ResolvedSessionConfigProjection): ResolvedSessionConfigProjection => ({
      currentProjection: () => {
        const current = resolved.currentProjection();
        if (!('retry' in current) || retried) {
          return current;
        }
        retried = true;
        return {
          retry: current.retry.then((next) => {
            queueMicrotask(() => {
              test.retireHandle();
              test.repository.getSessionById.mockResolvedValue(row('CODEX', options('latest')));
            });
            return next;
          }),
        };
      },
    });
    vi.spyOn(test.config, 'getSessionConfigProjection').mockImplementation(async (id) => {
      const resolved = await resolve(id);
      queueMicrotask(test.retireHandle);
      return watch(resolved);
    });
    await test.load.completeLoad(prepared);
    expect(test.domain.emitDelta.mock.calls[0]?.[1]).toMatchObject({
      capabilities: { model: { selected: 'latest' } },
    });
    expect(test.domain.emitDelta.mock.calls[1]?.[1]).toMatchObject({
      configOptions: options('latest'),
    });
    expect(test.fetchModels).toHaveBeenCalledTimes(1);
    expect(test.repository.getSessionById).toHaveBeenCalledTimes(4);
    expect(test.repository.updateSession).not.toHaveBeenCalled();
  });

  it('bounds repeated retirement without config publication or consuming initial text', async () => {
    const test = setup();
    test.setHandle();
    test.repository.getSessionById.mockImplementation(() => {
      test.setHandle(options('unstable'));
      return Promise.resolve(row());
    });
    const resolve = test.config.getSessionConfigProjection.bind(test.config);
    const watch = (resolved: ResolvedSessionConfigProjection): ResolvedSessionConfigProjection => ({
      currentProjection: () => {
        const current = resolved.currentProjection();
        return 'retry' in current
          ? {
              retry: current.retry.then((next) => {
                queueMicrotask(test.retireHandle);
                return watch(next);
              }),
            }
          : current;
      },
    });
    vi.spyOn(test.config, 'getSessionConfigProjection').mockImplementation(async (id) => {
      const resolved = await resolve(id);
      queueMicrotask(test.retireHandle);
      return watch(resolved);
    });
    await expect(test.load.completeLoad(prepared)).rejects.toThrow('retired repeatedly');
    expect(test.domain.emitDelta).not.toHaveBeenCalled();
    expect(test.domain.consumeInitialMessage).not.toHaveBeenCalled();
    expect(test.repository.getSessionById).toHaveBeenCalledTimes(3);
    expect(test.repository.updateSession).not.toHaveBeenCalled();
  });

  it.each(['initial', 'latest'])(
    'propagates %s database errors during retirement refresh',
    async (stage) => {
      const test = setup();
      test.setHandle();
      if (stage === 'latest') {
        test.repository.getSessionById
          .mockResolvedValueOnce(row())
          .mockRejectedValueOnce(new Error('storage unavailable'));
      } else {
        test.repository.getSessionById.mockRejectedValueOnce(new Error('storage unavailable'));
      }
      test.fetchModels.mockRejectedValue(new Error('catalog unavailable'));
      const resolve = test.config.getSessionConfigProjection.bind(test.config);
      vi.spyOn(test.config, 'getSessionConfigProjection').mockImplementation(async (id) => {
        const resolved = await resolve(id);
        queueMicrotask(test.retireHandle);
        return resolved;
      });
      await expect(test.load.completeLoad(prepared)).rejects.toThrow('storage unavailable');
      expect(test.fetchModels).toHaveBeenCalledTimes(stage === 'latest' ? 1 : 0);
      expect(test.domain.emitDelta).not.toHaveBeenCalled();
      expect(test.domain.consumeInitialMessage).not.toHaveBeenCalled();
      expect(test.repository.updateSession).not.toHaveBeenCalled();
    }
  );

  it('attempts a failed model catalog once per load completion', async () => {
    const test = setup();
    test.fetchModels.mockRejectedValue(new Error('app-server unavailable'));
    await test.load.completeLoad(prepared);
    expect(test.fetchModels).toHaveBeenCalledTimes(1);
    expect(test.repository.getSessionById).toHaveBeenCalledTimes(2);
    expect(test.domain.emitDelta.mock.calls.map((call) => call[1])).toMatchObject([
      { type: 'chat_capabilities', capabilities: { model: { selected: 'stored' } } },
      { type: 'config_options_update', configOptions: options() },
      { type: 'slash_commands' },
    ]);
    expect(test.repository.updateSession).not.toHaveBeenCalled();
  });

  it.each(
    (['initial read', 'catalog', 'latest read'] as const).flatMap((stage) =>
      [false, true].flatMap((catalogFails) =>
        [false, true].map((confirmed) => ({ stage, catalogFails, confirmed }))
      )
    )
  )(
    'handles pending creation at $stage (catalogFails=$catalogFails, confirmed=$confirmed)',
    async ({ stage, catalogFails, confirmed }) => {
      const test = setup();
      const pending = test.beginPending();
      const session = {
        ...row(),
        providerMetadata: {
          ...row().providerMetadata,
          launchSettings: { reasoningEffort: null, planModeEnabled: true, applied: false },
        },
      };
      const metadataBefore = JSON.stringify(session.providerMetadata);
      test.repository.getSessionById.mockResolvedValue(session);
      const blocked = deferred<typeof session>();
      const finishCatalog = prepareCatalogAtPhase(test, stage, catalogFails);
      if (stage === 'initial read') {
        test.repository.getSessionById.mockReturnValueOnce(blocked.promise);
      }
      if (stage === 'latest read') {
        test.repository.getSessionById
          .mockResolvedValueOnce(session)
          .mockReturnValueOnce(blocked.promise);
      }
      const reading = test.config.getSessionConfigProjection('session');
      await vi.waitFor(() =>
        expect(
          stage === 'catalog'
            ? test.fetchModels.mock.calls.length
            : test.repository.getSessionById.mock.calls.length
        ).toBe(stage === 'latest read' ? 2 : 1)
      );
      if (confirmed) {
        pending.confirm();
      } else {
        pending.reject();
      }
      blocked.resolve(session);
      finishCatalog();
      const projection = ready(await reading);
      expect(projection.capabilities.model.selected).toBe(confirmed ? 'live' : 'stored');
      if (confirmed) {
        expect(projection.configOptions).toEqual(options('live'));
      } else {
        expect(projection.configOptions.find((option) => option.id === 'model')?.currentValue).toBe(
          'stored'
        );
      }
      expect(test.fetchModels).toHaveBeenCalledTimes(confirmed && stage === 'initial read' ? 0 : 1);
      expect(test.runtime.getPendingClient).not.toHaveBeenCalled();
      expect(test.runtime.getInstalledHandle).not.toHaveBeenCalled();
      expect(test.launchOptions.getOptions).not.toHaveBeenCalled();
      expect(JSON.stringify(session.providerMetadata)).toBe(metadataBefore);
      expect(test.repository.updateSession).not.toHaveBeenCalled();
    }
  );

  it('uses the latest stored options and observed model after catalog lookup', async () => {
    const test = setup();
    const catalog = deferred<[]>();
    test.fetchModels.mockReturnValueOnce(catalog.promise);
    const reading = test.config.getSessionConfigProjection('session');
    await vi.waitFor(() => expect(test.fetchModels).toHaveBeenCalledTimes(1));
    const newer = row('CODEX', [
      { id: 'other', name: 'Other', type: 'boolean', currentValue: true },
    ]);
    newer.providerMetadata.acpConfigSnapshot.observedModelId = 'newer';
    test.repository.getSessionById.mockResolvedValue(newer);
    catalog.resolve([]);
    const projection = ready(await reading);
    expect(projection.configOptions).toEqual(
      newer.providerMetadata.acpConfigSnapshot.configOptions
    );
    expect(projection.capabilities.model.selected).toBe('newer');
    expect(test.repository.updateSession).not.toHaveBeenCalled();
  });

  it('rechecks a newer handle and same-handle edits after async resolution before publishing', async () => {
    const test = setup();
    const resolve = test.config.getSessionConfigProjection.bind(test.config);
    vi.spyOn(test.config, 'getSessionConfigProjection').mockImplementation(async (id) => {
      const result = await resolve(id);
      queueMicrotask(() => {
        test.setHandle(options('newer'));
      });
      return result;
    });
    await test.load.completeLoad(prepared);
    expect(test.domain.emitDelta.mock.calls[0]?.[1]).toMatchObject({
      capabilities: { model: { selected: 'newer' } },
    });
    expect(test.domain.emitDelta.mock.calls[1]?.[1]).toMatchObject({
      configOptions: options('newer'),
    });
    const handle = test.setHandle();
    const resolved = await resolve('session');
    handle.configOptions = options('edited');
    expect(ready(resolved)).toMatchObject({
      capabilities: { model: { selected: 'edited' } },
      configOptions: options('edited'),
    });
  });

  it('keeps empty live capabilities authoritative while options retain stored fallback', async () => {
    const test = setup();
    test.setHandle([]);
    const projection = ready(await test.config.getSessionConfigProjection('session'));
    expect(projection.capabilities.model.enabled).toBe(false);
    expect(projection.configOptions).toEqual(options());
  });

  it('uses live nonempty options without stored reads or discovery', async () => {
    const test = setup();
    test.setHandle();
    expect(ready(await test.config.getSessionConfigProjection('session')).configOptions).toEqual(
      options('live')
    );
    expect(test.repository.getSessionById).not.toHaveBeenCalled();
    expect(test.fetchModels).not.toHaveBeenCalled();
  });

  it.each(['CLAUDE', 'CODEX'] as const)(
    'preserves %s stored fallback without persistence',
    async (provider) => {
      const test = setup();
      test.repository.getSessionById.mockResolvedValue(row(provider));
      const result = ready(await test.config.getSessionConfigProjection('session'));
      expect(result.configOptions).toEqual(options());
      expect(result.capabilities.model.selected).toBe('stored');
      expect(test.fetchModels).toHaveBeenCalledTimes(provider === 'CODEX' ? 1 : 0);
      expect(test.repository.updateSession).not.toHaveBeenCalled();
    }
  );

  it.each([
    null,
    { acpConfigSnapshot: { configOptions: 'invalid' } },
    row('CLAUDE').providerMetadata,
  ])('rejects invalid or mismatched snapshots: %j', async (providerMetadata) => {
    const test = setup();
    test.repository.getSessionById.mockResolvedValue(
      unsafeCoerce({ provider: 'CODEX', providerMetadata })
    );
    const result = ready(await test.config.getSessionConfigProjection('session'));
    expect(result.configOptions).toEqual([]);
    expect(result.capabilities.model.enabled).toBe(false);
  });

  it('coalesces concurrent successful catalog discovery and keeps cached reads passive', async () => {
    const test = setup();
    const discovery = deferred<ModelCatalog>();
    test.fetchModels.mockReturnValueOnce(discovery.promise);
    const reads = [
      test.config.getSessionConfigProjection('session'),
      test.config.getSessionConfigProjection('session'),
    ];
    await vi.waitFor(() => expect(test.fetchModels).toHaveBeenCalledTimes(1));
    discovery.resolve([catalogModel]);
    await Promise.all(reads);
    await test.config.getSessionConfigProjection('session');
    expect(test.fetchModels).toHaveBeenCalledTimes(1);
    expect(test.repository.getSessionById).toHaveBeenCalledTimes(6);
    expect(test.repository.updateSession).not.toHaveBeenCalled();
  });

  it('maps Codex default and normalizes reasoning with the same catalog in both outputs', async () => {
    const test = setup();
    test.repository.getSessionById.mockResolvedValue(
      row('CODEX', [
        ...options('default'),
        {
          id: 'reasoning_effort',
          category: 'thought_level',
          name: 'Reasoning',
          type: 'select',
          currentValue: 'unsupported',
          options: [{ value: 'unsupported', name: 'Unsupported' }],
        },
      ])
    );
    test.fetchModels.mockResolvedValue([
      {
        ...catalogModel,
        id: 'native-default',
        displayName: 'Native',
        isDefault: true,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: [{ reasoningEffort: 'high', description: undefined }],
      },
    ]);
    const result = ready(await test.config.getSessionConfigProjection('session'));
    expect(result.capabilities.model.selected).toBe('native-default');
    expect(result.configOptions[0]?.currentValue).toBe('native-default');
    expect(result.capabilities.reasoning.selected).toBe('high');
    expect(result.configOptions[1]?.currentValue).toBe('high');
    expect(test.repository.updateSession).not.toHaveBeenCalled();
  });

  it('normalizes a legacy Codex collaboration snapshot before projecting it', async () => {
    const test = setup();
    test.repository.getSessionById.mockResolvedValue(
      row('CODEX', [
        ...options(),
        {
          id: 'execution_mode',
          name: 'Access',
          type: 'select',
          currentValue: '["on-request","workspace-write"]',
          options: [],
        },
        {
          id: 'mode',
          category: 'mode',
          name: 'Mode',
          type: 'select',
          currentValue: 'plan',
          options: [
            { value: 'plan', name: 'Plan' },
            { value: 'code', name: 'Code' },
          ],
        },
      ])
    );
    const result = ready(await test.config.getSessionConfigProjection('session'));
    expect(result.capabilities.planMode.enabled).toBe(true);
    expect(result.configOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'collaboration_mode', currentValue: 'plan' }),
      ])
    );
  });

  it.each([null, 'xhigh'])(
    'preserves latest native display options without consuming launch effort %j',
    async (reasoningEffort) => {
      const test = setup();
      const catalog = deferred<ModelCatalog>();
      test.fetchModels.mockReturnValueOnce(catalog.promise);
      const reading = test.config.getSessionConfigProjection('session');
      await vi.waitFor(() => expect(test.fetchModels).toHaveBeenCalledTimes(1));
      const nativeOptions: SessionConfigOption[] = [
        ...options('newer'),
        {
          id: 'thought_level',
          name: 'Effort',
          type: 'select',
          currentValue: 'high',
          options: [
            { value: 'high', name: 'High' },
            { value: 'xhigh', name: 'Extra high' },
          ],
        },
        {
          id: 'native_plan',
          category: 'collaboration_mode',
          name: 'Planning',
          type: 'select',
          currentValue: 'plan',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'plan', name: 'Plan' },
          ],
        },
      ];
      const latest = {
        ...row('CODEX', nativeOptions),
        model: 'newer',
        providerMetadata: {
          ...row('CODEX', nativeOptions).providerMetadata,
          launchSettings: { reasoningEffort, planModeEnabled: false, applied: false },
        },
      };
      const before = JSON.stringify(latest);
      test.repository.getSessionById.mockResolvedValue(latest);
      catalog.resolve([
        {
          ...catalogModel,
          id: 'newer',
          defaultReasoningEffort: 'xhigh',
          supportedReasoningEfforts: [
            { reasoningEffort: 'high', description: undefined },
            { reasoningEffort: 'xhigh', description: undefined },
          ],
        },
      ]);
      const result = ready(await reading);
      expect(result.capabilities).toMatchObject({
        model: { selected: 'newer' },
        reasoning: { selected: 'high' },
        planMode: { enabled: true },
      });
      expect(result.configOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'thought_level', currentValue: 'high' }),
          expect.objectContaining({ id: 'native_plan', currentValue: 'plan' }),
        ])
      );
      expect(JSON.stringify(latest)).toBe(before);
      expect(test.repository.updateSession).not.toHaveBeenCalled();
      expect(test.launchOptions.getOptions).not.toHaveBeenCalled();
    }
  );

  it.each(['CLAUDE', 'CODEX'] as const)(
    'retains confirmed %s native thinking and Plan identities',
    async (provider) => {
      const test = setup();
      const configOptions: SessionConfigOption[] = [
        ...options(),
        {
          id: 'thought_level',
          name: 'Thinking',
          type: 'select',
          currentValue: 'high',
          options: [{ value: 'high', name: 'High' }],
        },
        {
          id: provider === 'CLAUDE' ? 'mode' : 'collaboration_mode',
          category: provider === 'CLAUDE' ? 'mode' : 'collaboration_mode',
          name: 'Planning',
          type: 'select',
          currentValue: 'plan',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'plan', name: 'Plan' },
          ],
        },
      ];
      test.repository.getSessionById.mockResolvedValue(row(provider, configOptions));
      const result = ready(await test.config.getSessionConfigProjection('session'));
      expect(result.configOptions).toEqual(configOptions);
      expect(result.capabilities.planMode.enabled).toBe(true);
      if (provider === 'CLAUDE') {
        expect(result.capabilities.thinking.enabled).toBe(true);
      } else {
        expect(result.capabilities.reasoning.selected).toBe('high');
      }
      expect(test.repository.updateSession).not.toHaveBeenCalled();
    }
  );

  it.each(['default', 'chosen'])(
    'displays pre-start Codex model %s without synthesizing a snapshot',
    async (model) => {
      const test = setup();
      const session = {
        provider: 'CODEX',
        model,
        providerMetadata: {
          launchSettings: { reasoningEffort: null, planModeEnabled: true, applied: false },
        },
      };
      const before = JSON.stringify(session);
      test.repository.getSessionById.mockResolvedValue(unsafeCoerce(session));
      test.fetchModels.mockResolvedValue([catalogModel]);
      const result = ready(await test.config.getSessionConfigProjection('session'));
      expect(result.capabilities.model.selected).toBe(model === 'default' ? 'catalog' : 'chosen');
      expect(result.configOptions).toHaveLength(1);
      expect(JSON.stringify(session)).toBe(before);
      expect(test.repository.updateSession).not.toHaveBeenCalled();
      expect(test.launchOptions.getOptions).not.toHaveBeenCalled();
    }
  );

  it('does not resurrect a snapshot when the latest stored row is gone', async () => {
    const test = setup();
    test.repository.getSessionById
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(unsafeCoerce(null));
    const result = ready(await test.config.getSessionConfigProjection('session'));
    expect(result.configOptions).toEqual([]);
    expect(result.capabilities.model.enabled).toBe(false);
    expect(test.repository.updateSession).not.toHaveBeenCalled();
  });

  it.each(['initial', 'latest'])(
    'propagates a failed %s repository read without config publication or activation',
    async (stage) => {
      const test = setup();
      if (stage === 'latest') {
        test.repository.getSessionById
          .mockResolvedValueOnce(row())
          .mockRejectedValueOnce(new Error('storage unavailable'));
      } else {
        test.repository.getSessionById.mockRejectedValueOnce(new Error('storage unavailable'));
      }
      await expect(test.load.completeLoad(prepared)).rejects.toThrow('storage unavailable');
      expect(test.domain.emitDelta).not.toHaveBeenCalled();
      expect(test.domain.consumeInitialMessage).not.toHaveBeenCalled();
      expect(test.repository.updateSession).not.toHaveBeenCalled();
    }
  );

  it('returns empty projection for a missing session', async () => {
    const test = setup();
    test.repository.getSessionById.mockResolvedValue(unsafeCoerce(null));
    const result = ready(await test.config.getSessionConfigProjection('session'));
    expect(result.configOptions).toEqual([]);
    expect(result.capabilities.model.enabled).toBe(false);
    expect(test.fetchModels).not.toHaveBeenCalled();
  });
});
