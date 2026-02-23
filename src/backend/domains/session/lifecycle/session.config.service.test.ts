import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpProcessHandle } from '@/backend/domains/session/acp';
import { userSettingsAccessor } from '@/backend/resource_accessors/user-settings.accessor';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionConfigService } from './session.config.service';

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/backend/resource_accessors/user-settings.accessor', () => ({
  userSettingsAccessor: {
    get: vi.fn(),
  },
}));

describe('SessionConfigService', () => {
  const repository = {
    getSessionById: vi.fn(),
    updateSession: vi.fn(),
  };

  const runtimeManager = {
    getClient: vi.fn(),
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

    runtimeManager.setSessionMode.mockResolvedValue([
      { ...modeConfig, currentValue: 'bypassPermissions' },
    ]);

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

  it('applies Codex ratchet non-interactive startup execution mode using YOLO', async () => {
    const modeConfig = {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      category: 'mode',
      currentValue: 'ask',
      options: [
        { value: 'ask', name: 'Ask' },
        { value: 'code', name: 'Code' },
      ],
    };
    const executionModeConfig = {
      id: 'execution_mode',
      name: 'Execution Mode',
      type: 'select',
      category: 'permission',
      currentValue: '["on-failure","workspace-write"]',
      options: [
        {
          value: '["on-failure","workspace-write"]',
          name: 'On Failure (Workspace Write)',
        },
        {
          value: '["never","danger-full-access"]',
          name: 'YOLO (Full Access)',
        },
      ],
    };
    const handle = unsafeCoerce<AcpProcessHandle>({
      provider: 'CODEX',
      providerSessionId: 'provider-codex-ratchet-1',
      configOptions: [modeConfig, executionModeConfig],
    });

    runtimeManager.setSessionMode.mockResolvedValue([
      { ...modeConfig, currentValue: 'code' },
      executionModeConfig,
    ]);
    runtimeManager.setConfigOption.mockResolvedValue([
      { ...modeConfig, currentValue: 'code' },
      { ...executionModeConfig, currentValue: '["never","danger-full-access"]' },
    ]);

    await service.applyStartupModePreset(
      'session-codex-ratchet',
      handle,
      'non_interactive',
      'ratchet'
    );

    expect(runtimeManager.setSessionMode).toHaveBeenCalledWith('session-codex-ratchet', 'code');
    expect(runtimeManager.setConfigOption).toHaveBeenCalledWith(
      'session-codex-ratchet',
      'execution_mode',
      '["never","danger-full-access"]'
    );
  });

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

    runtimeManager.setSessionMode.mockResolvedValue([
      { ...modeConfig, currentValue: 'bypassPermissions' },
    ]);

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

  it('returns cached config options when no ACP handle is active', async () => {
    repository.getSessionById.mockResolvedValue(
      unsafeCoerce({
        id: 'session-1',
        provider: 'CLAUDE',
        providerMetadata: {
          acpConfigSnapshot: {
            provider: 'CLAUDE',
            providerSessionId: 'provider-session-1',
            capturedAt: '2026-02-14T00:00:00.000Z',
            configOptions: [
              {
                id: 'model',
                name: 'Model',
                type: 'select',
                category: 'model',
                currentValue: 'claude-sonnet-4-5',
                options: [{ value: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }],
              },
            ],
          },
        },
      })
    );

    await expect(service.getSessionConfigOptionsWithFallback('session-1')).resolves.toEqual([
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        category: 'model',
        currentValue: 'claude-sonnet-4-5',
        options: [{ value: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }],
      },
    ]);
  });

  it('returns empty config options when no ACP handle or cached snapshot exists', async () => {
    repository.getSessionById.mockResolvedValue(
      unsafeCoerce({
        id: 'session-1',
        provider: 'CLAUDE',
        providerMetadata: null,
      })
    );

    await expect(service.getSessionConfigOptionsWithFallback('session-1')).resolves.toEqual([]);
  });

  it('returns empty Claude capabilities when no ACP handle or cached snapshot exists', async () => {
    repository.getSessionById.mockResolvedValue(
      unsafeCoerce({
        id: 'session-claude',
        provider: 'CLAUDE',
        model: 'claude-sonnet-4-5',
        providerMetadata: null,
      })
    );

    const capabilities = await service.getChatBarCapabilities('session-claude');

    expect(capabilities.provider).toBe('CLAUDE');
    expect(capabilities.model.enabled).toBe(false);
    expect(capabilities.model.selected).toBeUndefined();
    expect(capabilities.model.options).toEqual([]);
  });

  it('returns CODEX provider fallback capabilities when no ACP handle is active', async () => {
    repository.getSessionById.mockResolvedValue(
      unsafeCoerce({
        id: 'session-codex',
        provider: 'CODEX',
      })
    );

    const capabilities = await service.getChatBarCapabilities('session-codex');

    expect(capabilities.provider).toBe('CODEX');
    expect(capabilities.model.enabled).toBe(false);
  });

  it('derives CODEX model/reasoning/plan-mode capabilities from cached ACP config options', async () => {
    repository.getSessionById.mockResolvedValue(
      unsafeCoerce({
        id: 'session-codex',
        provider: 'CODEX',
        providerMetadata: {
          acpConfigSnapshot: {
            provider: 'CODEX',
            providerSessionId: 'sess_123',
            capturedAt: '2026-02-15T00:00:00.000Z',
            configOptions: [
              {
                id: 'model',
                name: 'Model',
                type: 'select',
                category: 'model',
                currentValue: 'gpt-5-codex',
                options: [
                  { value: 'gpt-5-codex', name: 'GPT-5 Codex' },
                  { value: 'gpt-5-mini', name: 'GPT-5 Mini' },
                ],
              },
              {
                id: 'mode',
                name: 'Mode',
                type: 'select',
                category: 'mode',
                currentValue: 'plan',
                options: [
                  { value: 'ask', name: 'Ask' },
                  { value: 'plan', name: 'Plan' },
                ],
              },
              {
                id: 'reasoning_effort',
                name: 'Reasoning Effort',
                type: 'select',
                category: 'thought_level',
                currentValue: 'high',
                options: [
                  { value: 'medium', name: 'Medium', description: 'Balanced' },
                  { value: 'high', name: 'High', description: 'Thorough' },
                ],
              },
            ],
          },
        },
      })
    );

    const capabilities = await service.getChatBarCapabilities('session-codex');

    expect(capabilities.provider).toBe('CODEX');
    expect(capabilities.model.options).toEqual([
      { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
      { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
    ]);
    expect(capabilities.reasoning.enabled).toBe(true);
    expect(capabilities.reasoning.options).toEqual([
      { value: 'medium', label: 'Medium', description: 'Balanced' },
      { value: 'high', label: 'High', description: 'Thorough' },
    ]);
    expect(capabilities.reasoning.selected).toBe('high');
    expect(capabilities.planMode.enabled).toBe(true);
    expect(capabilities.thinking.enabled).toBe(false);
  });

  it('disables plan mode when ACP config options do not advertise a plan variant', async () => {
    repository.getSessionById.mockResolvedValue(
      unsafeCoerce({
        id: 'session-codex',
        provider: 'CODEX',
        providerMetadata: {
          acpConfigSnapshot: {
            provider: 'CODEX',
            providerSessionId: 'sess_124',
            capturedAt: '2026-02-15T00:00:00.000Z',
            configOptions: [
              {
                id: 'mode',
                name: 'Approval Policy',
                type: 'select',
                category: 'mode',
                currentValue: 'on-failure',
                options: [{ value: 'on-failure', name: 'On Failure' }],
              },
            ],
          },
        },
      })
    );

    const capabilities = await service.getChatBarCapabilities('session-codex');

    expect(capabilities.planMode.enabled).toBe(false);
  });

  it('skips setSessionModel when requested model is not in ACP model options', async () => {
    runtimeManager.getClient.mockReturnValue(
      unsafeCoerce({
        provider: 'CODEX',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            category: 'model',
            currentValue: 'gpt-5.3-codex',
            options: [
              { value: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
              { value: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
            ],
          },
        ],
      })
    );

    await service.setSessionModel('session-codex', 'opus');

    expect(runtimeManager.setConfigOption).not.toHaveBeenCalled();
    expect(runtimeManager.setSessionModel).not.toHaveBeenCalled();
  });

  it('routes model config updates through ACP setSessionModel', async () => {
    runtimeManager.getClient.mockReturnValue(
      unsafeCoerce({
        provider: 'CLAUDE',
        providerSessionId: 'provider-session-1',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            category: 'model',
            currentValue: 'default',
            options: [
              { value: 'default', name: 'Default' },
              { value: 'claude-sonnet-4-5', name: 'Sonnet 4.5' },
            ],
          },
        ],
      })
    );
    runtimeManager.setSessionModel.mockResolvedValue([
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        category: 'model',
        currentValue: 'claude-sonnet-4-5',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'claude-sonnet-4-5', name: 'Sonnet 4.5' },
        ],
      },
    ]);

    await service.setSessionConfigOption('session-1', 'model', 'claude-sonnet-4-5');

    expect(runtimeManager.setSessionModel).toHaveBeenCalledWith('session-1', 'claude-sonnet-4-5');
    expect(runtimeManager.setConfigOption).not.toHaveBeenCalled();
  });

  it('routes mode config updates through ACP setSessionMode', async () => {
    runtimeManager.getClient.mockReturnValue(
      unsafeCoerce({
        provider: 'CLAUDE',
        providerSessionId: 'provider-session-1',
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            type: 'select',
            category: 'mode',
            currentValue: 'default',
            options: [
              { value: 'default', name: 'Default' },
              { value: 'acceptEdits', name: 'Accept Edits' },
            ],
          },
        ],
      })
    );
    runtimeManager.setSessionMode.mockResolvedValue([
      {
        id: 'mode',
        name: 'Mode',
        type: 'select',
        category: 'mode',
        currentValue: 'acceptEdits',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'acceptEdits', name: 'Accept Edits' },
        ],
      },
    ]);

    await service.setSessionConfigOption('session-1', 'mode', 'acceptEdits');

    expect(runtimeManager.setSessionMode).toHaveBeenCalledWith('session-1', 'acceptEdits');
    expect(runtimeManager.setConfigOption).not.toHaveBeenCalled();
  });

  it('updates cached config snapshot when setting config on inactive session', async () => {
    runtimeManager.getClient.mockReturnValue(undefined);
    repository.getSessionById.mockResolvedValue(
      unsafeCoerce({
        id: 'session-1',
        provider: 'CODEX',
        providerMetadata: {
          acpConfigSnapshot: {
            provider: 'CODEX',
            providerSessionId: 'thread_123',
            capturedAt: '2026-02-15T00:00:00.000Z',
            configOptions: [
              {
                id: 'execution_mode',
                name: 'Execution Mode',
                type: 'select',
                category: 'permission',
                currentValue: '["on-request","workspace-write"]',
                options: [
                  {
                    value: '["on-request","workspace-write"]',
                    name: 'on-request + workspace-write',
                  },
                  {
                    value: '["on-failure","workspace-write"]',
                    name: 'on-failure + workspace-write',
                  },
                ],
              },
            ],
          },
        },
      })
    );

    await service.setSessionConfigOption(
      'session-1',
      'execution_mode',
      '["on-failure","workspace-write"]'
    );

    expect(runtimeManager.setConfigOption).not.toHaveBeenCalled();
    expect(runtimeManager.setSessionMode).not.toHaveBeenCalled();
    expect(runtimeManager.setSessionModel).not.toHaveBeenCalled();
    expect(repository.updateSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        providerMetadata: expect.objectContaining({
          acpConfigSnapshot: expect.objectContaining({
            configOptions: expect.arrayContaining([
              expect.objectContaining({
                id: 'execution_mode',
                currentValue: '["on-failure","workspace-write"]',
              }),
            ]),
          }),
        }),
      })
    );
  });

  it('rejects unsupported cached config values on inactive session', async () => {
    runtimeManager.getClient.mockReturnValue(undefined);
    repository.getSessionById.mockResolvedValue(
      unsafeCoerce({
        id: 'session-1',
        provider: 'CODEX',
        providerMetadata: {
          acpConfigSnapshot: {
            provider: 'CODEX',
            providerSessionId: 'thread_123',
            capturedAt: '2026-02-15T00:00:00.000Z',
            configOptions: [
              {
                id: 'execution_mode',
                name: 'Execution Mode',
                type: 'select',
                category: 'permission',
                currentValue: '["on-request","workspace-write"]',
                options: [
                  {
                    value: '["on-request","workspace-write"]',
                    name: 'on-request + workspace-write',
                  },
                ],
              },
            ],
          },
        },
      })
    );

    await expect(
      service.setSessionConfigOption(
        'session-1',
        'execution_mode',
        '["never","danger-full-access"]'
      )
    ).rejects.toThrow('Unsupported value');
  });

  it('retries persisting ACP config snapshot metadata once when first write fails', async () => {
    const configOptions = [
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        category: 'model',
        currentValue: 'claude-sonnet-4-5',
        options: [{ value: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }],
      },
    ];

    repository.updateSession
      .mockRejectedValueOnce(new Error('primary metadata write failed'))
      .mockResolvedValueOnce(unsafeCoerce({ id: 'session-1' }));
    repository.getSessionById.mockResolvedValue(
      unsafeCoerce({
        id: 'session-1',
        providerMetadata: { existing: 'metadata' },
      })
    );

    await service.persistAcpConfigSnapshot('session-1', {
      provider: 'CLAUDE',
      providerSessionId: 'provider-session-1',
      configOptions: unsafeCoerce(configOptions),
    });

    const metadataUpdates = repository.updateSession.mock.calls.filter(([, update]: unknown[]) =>
      Object.hasOwn(update as object, 'providerMetadata')
    );
    expect(metadataUpdates).toHaveLength(2);
  });

  it('applies configured permission preset for CODEX sessions from user settings', async () => {
    vi.mocked(userSettingsAccessor.get).mockResolvedValue(
      unsafeCoerce({
        ratchetPermissions: 'YOLO',
        defaultWorkspacePermissions: 'RELAXED',
      })
    );

    const handle = unsafeCoerce<AcpProcessHandle>({
      provider: 'CODEX',
      providerSessionId: 'provider-codex-1',
      configOptions: [
        {
          id: 'execution_mode',
          name: 'Execution Mode',
          type: 'select',
          category: 'permission',
          currentValue: '["on-request","workspace-write"]',
          options: [
            {
              value: '["on-request","workspace-write"]',
              name: 'On Request',
            },
            {
              value: '["on-failure","workspace-write"]',
              name: 'On Failure',
            },
          ],
        },
      ],
    });

    runtimeManager.setConfigOption.mockResolvedValue([
      {
        id: 'execution_mode',
        name: 'Execution Mode',
        type: 'select',
        category: 'permission',
        currentValue: '["on-failure","workspace-write"]',
        options: [
          {
            value: '["on-request","workspace-write"]',
            name: 'On Request',
          },
          {
            value: '["on-failure","workspace-write"]',
            name: 'On Failure',
          },
        ],
      },
    ]);

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
      'execution_mode',
      '["on-failure","workspace-write"]'
    );
  });
});
