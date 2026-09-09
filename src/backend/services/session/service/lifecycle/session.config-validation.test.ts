import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionConfigService } from './session.config.service';

const validModel = {
  id: 'model',
  name: 'Model',
  type: 'select',
  category: 'model',
  currentValue: 'sonnet',
  options: [{ value: 'sonnet', name: 'Sonnet' }],
};

describe('cached ACP configuration validation', () => {
  const repository = { getSessionById: vi.fn(), updateSession: vi.fn() };
  const runtimeManager = { getClient: vi.fn() };
  let service: SessionConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SessionConfigService({
      codexModelCatalogService: { getModels: vi.fn().mockResolvedValue([]) },
      repository: unsafeCoerce(repository),
      runtimeManager: unsafeCoerce(runtimeManager),
      sessionDomainService: unsafeCoerce({ emitDelta: vi.fn() }),
    });
  });

  it('restores inactive Codex model and plan capabilities when categories are omitted', async () => {
    repository.getSessionById.mockResolvedValue({
      id: 'session-1',
      provider: 'CODEX',
      providerMetadata: {
        acpConfigSnapshot: {
          provider: 'CODEX',
          providerSessionId: 'provider-1',
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              type: 'select',
              currentValue: 'custom',
              options: [{ value: 'custom', name: 'Provider model label' }],
            },
            {
              id: 'mode',
              name: 'Mode',
              type: 'select',
              currentValue: 'plan',
              options: [{ value: 'plan', name: 'Plan' }],
            },
          ],
        },
      },
    });

    const capabilities = await service.getChatBarCapabilities('session-1');

    expect(capabilities.model).toEqual({
      enabled: true,
      selected: 'custom',
      options: [{ value: 'custom', label: 'Provider model label' }],
    });
    expect(capabilities.planMode.enabled).toBe(true);
  });

  it.each([
    ['null entry', [null]],
    ['primitive entry', ['model']],
    ['missing options', [{ id: 'model', category: 'model' }]],
    ['invalid current value', [{ ...validModel, currentValue: 42 }]],
    ['invalid nested option', [{ ...validModel, options: [null] }]],
    [
      'invalid group',
      [{ ...validModel, options: [{ group: 'models', name: 'Models', options: [null] }] }],
    ],
    [
      'invalid group options',
      [{ ...validModel, options: [{ group: 'models', name: 'Models', options: 42 }] }],
    ],
    ['invalid entry beside valid option', [validModel, null]],
  ])(
    'ignores a snapshot with %s instead of exposing malformed options',
    async (_name, configOptions) => {
      repository.getSessionById.mockResolvedValue({
        id: 'session-1',
        provider: 'CLAUDE',
        providerMetadata: {
          acpConfigSnapshot: {
            provider: 'CLAUDE',
            providerSessionId: 'provider-1',
            configOptions,
          },
        },
      });
      await expect(service.getSessionConfigOptionsWithFallback('session-1')).resolves.toEqual([]);
      await expect(service.getChatBarCapabilities('session-1')).resolves.toEqual(
        EMPTY_CHAT_BAR_CAPABILITIES
      );
    }
  );
});
