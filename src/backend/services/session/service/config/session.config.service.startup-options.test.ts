import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { userSettingsService } from '@/backend/services/settings';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionConfigService } from './session.config.service';

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => mockLogger,
}));

vi.mock('@/backend/services/settings', () => ({
  userSettingsService: {
    get: vi.fn(),
  },
}));

describe('SessionConfigService', () => {
  const codexModelCatalogService = { getModels: vi.fn() };
  const repository = {
    getSessionById: vi.fn(),
    updateSession: vi.fn(),
  };

  const runtimeManager = {
    getClient: vi.fn(),
    isStopInProgress: vi.fn(() => false),
    setSessionMode: vi.fn(),
    setSessionModel: vi.fn(),
    setConfigOption: vi.fn(),
  };
  const sessionDomain = {
    emitDelta: vi.fn(),
  };

  let service: SessionConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    codexModelCatalogService.getModels.mockResolvedValue([]);

    repository.getSessionById.mockResolvedValue(
      unsafeCoerce({
        id: 'session-1',
        provider: 'CLAUDE',
        providerMetadata: null,
      })
    );
    repository.updateSession.mockResolvedValue(unsafeCoerce({ id: 'session-1' }));

    runtimeManager.getClient.mockReturnValue(undefined);
    runtimeManager.setSessionMode.mockReset();
    runtimeManager.setSessionModel.mockReset();
    runtimeManager.setConfigOption.mockReset();

    service = new SessionConfigService({
      codexModelCatalogService,
      repository: unsafeCoerce(repository),
      runtimeManager: unsafeCoerce(runtimeManager),
      sessionDomainService: unsafeCoerce(sessionDomain),
    });
  });

  it('applies Claude non-interactive startup mode preset when bypassPermissions is available', async () => {
    const modeConfig = {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      category: 'mode',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'bypassPermissions', name: 'Bypass Permissions' },
      ],
    };
    const handle = unsafeCoerce<AcpProcessHandle>({
      provider: 'CLAUDE',
      providerSessionId: 'provider-session-1',
      configOptions: [modeConfig],
    });

    runtimeManager.getClient.mockReturnValue(handle);
    runtimeManager.setSessionMode.mockImplementation(() => {
      handle.configOptions = unsafeCoerce([{ ...modeConfig, currentValue: 'bypassPermissions' }]);
      return Promise.resolve(handle.configOptions);
    });

    await service.applyStartupModePreset('session-1', handle, 'non_interactive', 'default');

    expect(runtimeManager.setSessionMode).toHaveBeenCalledWith('session-1', 'bypassPermissions');
    expect(sessionDomain.emitDelta).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'config_options_update',
      })
    );
    expect(sessionDomain.emitDelta).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'chat_capabilities' })
    );
  });

  it.each(['periodic-task'])(
    'sets %s collaboration independently of native access at startup',
    async (workflow) => {
      const access = {
        id: 'mode',
        name: 'Access',
        type: 'select',
        category: 'mode',
        currentValue: 'workspace-write',
        options: [{ value: 'workspace-write', name: 'Workspace access' }],
      };
      const planning = {
        id: 'collaboration_mode',
        name: 'Planning',
        type: 'select',
        category: 'collaboration_mode',
        currentValue: 'plan',
        options: ['default', 'plan'].map((value) => ({ value, name: value })),
      };
      const handle = unsafeCoerce<AcpProcessHandle>({
        provider: 'CODEX',
        providerSessionId: 'provider-codex-1',
        configOptions: [access, planning],
      });
      runtimeManager.getClient.mockReturnValue(handle);
      runtimeManager.setConfigOption.mockImplementation(() => {
        handle.configOptions = unsafeCoerce([access, { ...planning, currentValue: 'default' }]);
        return Promise.resolve(handle.configOptions);
      });
      await service.applyStartupModePreset('session-codex', handle, 'non_interactive', workflow);
      expect(runtimeManager.setConfigOption).toHaveBeenCalledWith(
        'session-codex',
        'collaboration_mode',
        'default'
      );
      expect(runtimeManager.setSessionMode).not.toHaveBeenCalled();
      expect(handle.configOptions[0]?.currentValue).toBe('workspace-write');
    }
  );

  it('continues startup when persistSnapshot callback fails', async () => {
    const modeConfig = {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      category: 'mode',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'bypassPermissions', name: 'Bypass Permissions' },
      ],
    };
    const handle = unsafeCoerce<AcpProcessHandle>({
      provider: 'CLAUDE',
      providerSessionId: 'provider-session-1',
      configOptions: [modeConfig],
    });

    runtimeManager.getClient.mockReturnValue(handle);
    runtimeManager.setSessionMode.mockImplementation(() => {
      handle.configOptions = unsafeCoerce([{ ...modeConfig, currentValue: 'bypassPermissions' }]);
      return Promise.resolve(handle.configOptions);
    });

    const persistSnapshot = vi.fn().mockRejectedValue(new Error('db unavailable'));

    await expect(
      service.applyStartupModePreset('session-1', handle, 'non_interactive', 'default', {
        persistSnapshot,
      })
    ).resolves.toBeUndefined();

    expect(runtimeManager.setSessionMode).toHaveBeenCalledWith('session-1', 'bypassPermissions');
    expect(persistSnapshot).toHaveBeenCalledTimes(1);
    expect(handle.configOptions[0]?.currentValue).toBe('bypassPermissions');
  });

  it('applies configured reasoning effort to a new ACP handle without immediate emit when requested', async () => {
    vi.mocked(userSettingsService.get).mockResolvedValue(
      unsafeCoerce({
        defaultCodexReasoningEffort: 'high',
      })
    );
    const handle = unsafeCoerce<AcpProcessHandle>({
      provider: 'CODEX',
      providerSessionId: 'provider-codex-1',
      configOptions: [
        {
          id: 'reasoning_effort',
          name: 'Reasoning Effort',
          type: 'select',
          category: 'thought_level',
          currentValue: 'medium',
          options: [
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
    });
    runtimeManager.getClient.mockReturnValue(handle);
    runtimeManager.setConfigOption.mockImplementation(() => {
      handle.configOptions = unsafeCoerce([
        {
          ...handle.configOptions[0],
          currentValue: 'high',
        },
      ]);
      return Promise.resolve(handle.configOptions);
    });

    await service.applyConfiguredReasoningEffort('session-1', handle, {
      persistSnapshot: false,
      emitUpdates: false,
    });

    expect(runtimeManager.setConfigOption).toHaveBeenCalledWith(
      'session-1',
      'reasoning_effort',
      'high'
    );
    expect(handle.configOptions[0]?.currentValue).toBe('high');
    expect(repository.updateSession).not.toHaveBeenCalled();
    expect(sessionDomain.emitDelta).not.toHaveBeenCalled();
  });

  it.each(['default', 'auto-iteration'])(
    'applies configured permissions for %s',
    async (workflow) => {
      vi.mocked(userSettingsService.get).mockResolvedValue(
        unsafeCoerce({
          defaultWorkspacePermissions: 'RELAXED',
        })
      );

      const handle = unsafeCoerce<AcpProcessHandle>({
        provider: 'CODEX',
        providerSessionId: 'provider-codex-1',
        configOptions: [
          {
            id: 'mode',
            name: 'Access',
            type: 'select',
            category: 'mode',
            currentValue: 'workspace-write',
            options: [
              {
                value: 'workspace-write',
                name: 'On Request',
              },
              {
                value: 'agent',
                name: 'On Failure',
              },
            ],
          },
        ],
      });

      runtimeManager.getClient.mockReturnValue(handle);
      runtimeManager.setConfigOption.mockImplementation(() => {
        handle.configOptions = unsafeCoerce([
          {
            id: 'mode',
            name: 'Access',
            type: 'select',
            category: 'mode',
            currentValue: 'agent',
            options: [
              {
                value: 'workspace-write',
                name: 'On Request',
              },
              {
                value: 'agent',
                name: 'On Failure',
              },
            ],
          },
        ]);
        return Promise.resolve(handle.configOptions);
      });

      await service.applyConfiguredPermissionPreset(
        'session-1',
        unsafeCoerce({
          id: 'session-1',
          workflow,
        }),
        handle
      );

      expect(runtimeManager.setConfigOption).toHaveBeenCalledWith('session-1', 'mode', 'agent');
    }
  );

  it('applies configured permission preset for CLAUDE sessions that expose permission config', async () => {
    vi.mocked(userSettingsService.get).mockResolvedValue(
      unsafeCoerce({
        defaultWorkspacePermissions: 'YOLO',
      })
    );

    const handle = unsafeCoerce<AcpProcessHandle>({
      provider: 'CLAUDE',
      providerSessionId: 'provider-claude-1',
      configOptions: [
        {
          id: 'mode',
          name: 'Access',
          type: 'select',
          category: 'mode',
          currentValue: 'default',
          options: [
            {
              value: 'default',
              name: 'On Request',
            },
            {
              value: 'bypassPermissions',
              name: 'YOLO',
            },
          ],
        },
      ],
    });

    runtimeManager.getClient.mockReturnValue(handle);
    runtimeManager.setConfigOption.mockImplementation(() => {
      handle.configOptions = unsafeCoerce([
        {
          id: 'mode',
          name: 'Access',
          type: 'select',
          category: 'mode',
          currentValue: 'bypassPermissions',
          options: [
            {
              value: 'default',
              name: 'On Request',
            },
            {
              value: 'bypassPermissions',
              name: 'YOLO',
            },
          ],
        },
      ]);
      return Promise.resolve(handle.configOptions);
    });

    await service.applyConfiguredPermissionPreset(
      'session-1',
      unsafeCoerce({
        id: 'session-1',
        workflow: 'default',
      }),
      handle
    );

    expect(runtimeManager.setConfigOption).toHaveBeenCalledWith(
      'session-1',
      'mode',
      'bypassPermissions'
    );
  });
});
