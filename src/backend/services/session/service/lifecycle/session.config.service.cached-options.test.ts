import { describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionConfigService } from './session.config.service';

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/backend/services/settings', () => ({ userSettingsService: {} }));
vi.mock('@/backend/services/session/service/acp', () => ({
  fetchCodexModelCatalogFromAppServer: vi.fn(),
}));

describe('inactive session config errors', () => {
  it.each([
    ['fast', 'Cannot set config option "fast" on an inactive session: unsupported type "boolean"'],
    ['missing', 'Unknown config option: missing'],
  ])(
    'reports the reason for rejecting %s without changing the cached snapshot',
    async (configId, message) => {
      const option = { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false };
      const repository = {
        getSessionById: vi.fn().mockResolvedValue({
          id: 'session-1',
          provider: 'CODEX',
          providerMetadata: {
            acpConfigSnapshot: {
              provider: 'CODEX',
              providerSessionId: 'thread-1',
              configOptions: [option],
            },
          },
        }),
        updateSession: vi.fn(),
      };
      const sessionDomainService = { emitDelta: vi.fn() };
      const service = new SessionConfigService({
        repository: unsafeCoerce(repository),
        runtimeManager: unsafeCoerce({ getClient: vi.fn().mockReturnValue(undefined) }),
        sessionDomainService: unsafeCoerce(sessionDomainService),
      });

      await expect(service.setSessionConfigOption('session-1', configId, 'true')).rejects.toThrow(
        message
      );
      expect(option.currentValue).toBe(false);
      expect(repository.updateSession).not.toHaveBeenCalled();
      expect(sessionDomainService.emitDelta).not.toHaveBeenCalled();
    }
  );
});
