import { describe, expect, it, vi } from 'vitest';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionConfigService } from './session.config.service';

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/backend/services/settings', () => ({ userSettingsService: {} }));

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
        codexModelCatalogService: { getModels: vi.fn().mockResolvedValue([]) },
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

describe('native access setup failures', () => {
  it.each(['rejected', 'unchanged'])(
    'fails closed when native access restrictions are %s',
    async (failure) => {
      const access = {
        id: 'mode',
        name: 'Access',
        type: 'select',
        category: 'mode',
        currentValue: 'agent-full-access',
        options: ['workspace-write', 'agent-full-access'].map((value) => ({ value, name: value })),
      };
      const handle = unsafeCoerce<AcpProcessHandle>({
        provider: 'CODEX',
        providerSessionId: 'provider-codex-1',
        configOptions: [access],
      });
      const runtimeManager = { setConfigOption: vi.fn() };
      const service = new SessionConfigService({
        repository: unsafeCoerce({ getSessionById: vi.fn(), updateSession: vi.fn() }),
        runtimeManager: unsafeCoerce(runtimeManager),
        codexModelCatalogService: { getModels: vi.fn().mockResolvedValue([]) },
        sessionDomainService: unsafeCoerce({ emitDelta: vi.fn() }),
      });
      if (failure === 'rejected') {
        runtimeManager.setConfigOption.mockRejectedValue(new Error('access rejected'));
      } else {
        runtimeManager.setConfigOption.mockResolvedValue([access]);
      }
      await expect(
        service.applyConfiguredPermissionPreset(
          'session-1',
          unsafeCoerce({ workflow: 'code' }),
          handle,
          'STRICT'
        )
      ).rejects.toThrow();
    }
  );
});
