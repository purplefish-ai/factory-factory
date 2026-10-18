import { expect, it, vi } from 'vitest';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionConfigService } from './session.config.service';

vi.mock('@/backend/services/settings', () => ({
  userSettingsService: {
    get: async () => ({
      autoIterationPermissions: 'STRICT',
      defaultWorkspacePermissions: 'STRICT',
    }),
  },
}));

it.each(['CODEX', 'CLAUDE'] as const)(
  'preserves scheduled %s permission behavior through startup',
  async (provider) => {
    const unattendedMode = '["never","danger-full-access"]';
    const handle = unsafeCoerce<AcpProcessHandle>({
      provider,
      providerSessionId: 'provider-1',
      configOptions: [
        {
          id: 'execution_mode',
          type: 'select',
          category: 'permission',
          name: 'Execution mode',
          currentValue: '["on-request","workspace-write"]',
          options: [
            { value: '["on-request","workspace-write"]', name: 'On Request' },
            { value: unattendedMode, name: 'YOLO' },
          ],
        },
      ],
    });
    const setConfigOption = vi.fn(async (_sessionId: string, _optionId: string, value: string) =>
      handle.configOptions.map((option) => ({ ...option, currentValue: value }))
    );
    const service = new SessionConfigService({
      codexModelCatalogService: unsafeCoerce({}),
      repository: unsafeCoerce({
        getSessionById: async () => ({ id: 'session-1', providerMetadata: null }),
        updateSession: async () => ({}),
      }),
      runtimeManager: unsafeCoerce({ setConfigOption }),
      sessionDomainService: unsafeCoerce({ emitDelta: vi.fn() }),
    });
    await service.applyStartupModePreset('session-1', handle, 'non_interactive', 'periodic-task');
    await service.applyConfiguredPermissionPreset(
      'session-1',
      unsafeCoerce({ id: 'session-1', workflow: 'periodic-task', provider }),
      handle
    );
    expect(handle.configOptions[0]?.currentValue).toBe(
      provider === 'CODEX' ? unattendedMode : '["on-request","workspace-write"]'
    );
  }
);
