import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionConfigService } from './session.config.service';

vi.mock('@/backend/services/session/service/acp', () => ({
  fetchCodexModelCatalogFromAppServer: vi.fn().mockResolvedValue([]),
}));

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
      repository: unsafeCoerce(repository),
      runtimeManager: unsafeCoerce(runtimeManager),
      sessionDomainService: unsafeCoerce({ emitDelta: vi.fn() }),
    });
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
