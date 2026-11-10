import { describe, expect, it, vi } from 'vitest';
import { NATIVE_DEFAULT_CODEX_ACCOUNT_ID } from '@/shared/codex-accounts';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionConfigService } from './session.config.service';

function setup(codexAccountId: string | null) {
  const getModels = vi.fn(async () => [
    {
      id: 'native-model',
      displayName: 'Native model',
      description: '',
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [],
      inputModalities: ['text'],
    },
  ]);
  const updateSession = vi.fn().mockResolvedValue(undefined);
  const config = new SessionConfigService({
    repository: unsafeCoerce({
      getSessionById: vi.fn(async () => ({
        provider: 'CODEX',
        model: 'default',
        codexAccountId,
        providerMetadata: null,
      })),
      updateSession,
    }),
    runtimeManager: unsafeCoerce({
      getClient: vi.fn(() => undefined),
      getPendingClient: vi.fn(() => undefined),
    }),
    codexModelCatalogService: { getModels },
    sessionDomainService: unsafeCoerce({ emitDelta: vi.fn() }),
    launchOptionsService: { getOptions: vi.fn() },
  });
  return { config, getModels, updateSession };
}

describe('stored Codex account catalog identity', () => {
  it.each([null, 'managed'] as const)(
    'uses the saved profile for passive display (binding=%s)',
    async (binding) => {
      const { config, getModels } = setup(binding);
      await config.getChatBarCapabilities('session');
      expect(getModels).toHaveBeenCalledExactlyOnceWith(binding ?? NATIVE_DEFAULT_CODEX_ACCOUNT_ID);
    }
  );
  it.each([null, 'managed'] as const)(
    'validates stopped edits on the saved profile (binding=%s)',
    async (binding) => {
      const { config, getModels, updateSession } = setup(binding);
      await config.setSessionConfigOption('session', 'model', 'native-model');
      expect(getModels).toHaveBeenCalledExactlyOnceWith(binding ?? NATIVE_DEFAULT_CODEX_ACCOUNT_ID);
      expect(updateSession).toHaveBeenCalledWith(
        'session',
        { model: 'native-model' },
        expect.any(Function)
      );
    }
  );
});
