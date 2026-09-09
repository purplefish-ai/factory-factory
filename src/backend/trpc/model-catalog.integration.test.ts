import { describe, expect, it, vi } from 'vitest';
import { CodexModelCatalogService, SessionConfigService } from '@/backend/services/session';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { userSettingsRouter } from './user-settings.trpc';

function createConsumers(
  fetchModels: ConstructorParameters<typeof CodexModelCatalogService>[0]['fetchModels']
) {
  const codexModelCatalogService = new CodexModelCatalogService({ fetchModels });
  const sessionConfig = new SessionConfigService({
    codexModelCatalogService,
    repository: unsafeCoerce({
      getSessionById: vi.fn(async () => ({
        id: 'session-codex',
        provider: 'CODEX',
        model: 'default',
        providerMetadata: null,
      })),
    }),
    runtimeManager: unsafeCoerce({ getClient: vi.fn(() => undefined) }),
    sessionDomainService: unsafeCoerce({ emitDelta: vi.fn() }),
  });
  const admin = userSettingsRouter.createCaller(
    unsafeCoerce({
      appContext: {
        services: {
          codexModelCatalogService,
          fetchClaudeModelCatalogFromAcp: vi.fn(async () => []),
        },
      },
    })
  );
  return { sessionConfig, admin };
}

const models = [
  {
    id: 'codex-test',
    displayName: 'Codex Test',
    description: 'Test model',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
    inputModalities: ['text'],
    isDefault: true,
  },
];

describe('shared Codex catalog consumers', () => {
  it('discovers once for concurrent Admin options and inactive chat capabilities', async () => {
    let resolveDiscovery!: (value: typeof models) => void;
    const fetchModels = vi.fn(
      () =>
        new Promise<typeof models>((resolve) => {
          resolveDiscovery = resolve;
        })
    );
    const { sessionConfig, admin } = createConsumers(fetchModels);
    const chatResult = sessionConfig.getChatBarCapabilities('session-codex');
    const adminResult = admin.getProviderOptions();
    await vi.waitFor(() => expect(fetchModels).toHaveBeenCalledOnce());
    resolveDiscovery(models);
    const [chat, options] = await Promise.all([chatResult, adminResult]);

    expect(chat.model).toMatchObject({
      enabled: true,
      selected: 'codex-test',
      options: [{ value: 'codex-test', label: 'Codex Test' }],
    });
    expect(options.CODEX).toMatchObject({
      source: 'cli',
      models: [{ value: 'codex-test', label: 'Codex Test' }],
    });
    await admin.getProviderOptions();
    await sessionConfig.getChatBarCapabilities('session-codex');
    expect(fetchModels).toHaveBeenCalledOnce();
  });

  it('preserves the Admin fallback on failure and shares a successful chat retry', async () => {
    const fetchModels = vi
      .fn()
      .mockRejectedValueOnce(new Error('Codex unavailable'))
      .mockResolvedValue(models);
    const { sessionConfig, admin } = createConsumers(fetchModels);

    const fallback = await admin.getProviderOptions();
    expect(fallback.CODEX).toMatchObject({ source: 'fallback', error: 'Codex unavailable' });
    expect(fallback.CODEX.models).toEqual([
      { value: 'default', label: 'Default' },
      { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
    ]);
    const chat = await sessionConfig.getChatBarCapabilities('session-codex');
    expect(chat.model.selected).toBe('codex-test');
    await expect(admin.getProviderOptions()).resolves.toMatchObject({ CODEX: { source: 'cli' } });
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });

  it('keeps inactive chat capabilities available when catalog discovery fails', async () => {
    const { sessionConfig } = createConsumers(
      vi.fn().mockRejectedValue(new Error('Codex unavailable'))
    );

    await expect(sessionConfig.getChatBarCapabilities('session-codex')).resolves.toMatchObject({
      provider: 'CODEX',
      model: { enabled: false, options: [] },
    });
  });
});
