import { expect, it, vi } from 'vitest';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { userSettingsService } from '@/backend/services/settings';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionConfigService } from './session.config.service';

vi.mock('@/backend/services/settings', () => ({
  userSettingsService: { get: vi.fn() },
}));

it.each(
  (['CODEX', 'CLAUDE'] as const).flatMap((provider) =>
    (['STRICT', 'RELAXED', 'YOLO'] as const).map((preset) => ({ provider, preset }))
  )
)(
  'preserves scheduled $provider native access with $preset defaults through startup',
  async ({ provider, preset }) => {
    vi.mocked(userSettingsService.get).mockResolvedValue(
      unsafeCoerce({
        autoIterationPermissions: preset,
        defaultWorkspacePermissions: preset,
      })
    );
    const handle = unsafeCoerce<AcpProcessHandle>({
      provider,
      providerSessionId: 'provider-1',
      configOptions: [
        {
          id: 'mode',
          type: 'select',
          category: 'mode',
          name: 'Access',
          currentValue: provider === 'CODEX' ? 'workspace-write' : 'default',
          options: (provider === 'CODEX'
            ? ['read-only', 'workspace-write', 'agent', 'agent-full-access']
            : ['default', 'acceptEdits', 'bypassPermissions', 'plan']
          ).map((value) => ({ value, name: value })),
        },
        ...(provider === 'CODEX'
          ? [
              {
                id: 'collaboration_mode',
                type: 'select',
                category: 'collaboration_mode',
                name: 'Planning',
                currentValue: 'plan',
                options: ['default', 'plan'].map((value) => ({ value, name: value })),
              },
            ]
          : []),
      ],
    });
    const updateOption = (id: string, value: string) =>
      Promise.resolve(
        handle.configOptions.map((option) =>
          option.id === id && option.type === 'select' ? { ...option, currentValue: value } : option
        )
      );
    const setConfigOption = vi.fn(async (_sessionId: string, optionId: string, value: string) =>
      updateOption(optionId, value)
    );
    const setSessionMode = vi.fn(async (_sessionId: string, value: string) =>
      updateOption('mode', value)
    );
    const service = new SessionConfigService({
      codexModelCatalogService: unsafeCoerce({}),
      repository: unsafeCoerce({
        getSessionById: async () => ({ id: 'session-1', providerMetadata: null }),
        updateSession: async () => ({}),
      }),
      runtimeManager: unsafeCoerce({ setConfigOption, setSessionMode }),
      sessionDomainService: unsafeCoerce({ emitDelta: vi.fn() }),
    });
    await service.applyStartupModePreset('session-1', handle, 'non_interactive', 'periodic-task');
    await service.applyConfiguredPermissionPreset(
      'session-1',
      unsafeCoerce({ id: 'session-1', workflow: 'periodic-task', provider }),
      handle
    );
    const claudeModes = { STRICT: 'default', RELAXED: 'acceptEdits', YOLO: 'bypassPermissions' };
    expect(handle.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
      provider === 'CODEX' ? 'agent-full-access' : claudeModes[preset]
    );
    if (provider === 'CODEX') {
      expect(
        handle.configOptions.find((option) => option.id === 'collaboration_mode')?.currentValue
      ).toBe('default');
    }
  }
);
