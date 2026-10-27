import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  launchWorkspace,
  type CreatedWorkspace,
  type WorkspaceLaunchPorts,
} from '@/backend/orchestration/workspace-launch.orchestrator';
import {
  createManagerTestHarness,
  mockNewSession,
  mockSetSessionConfigOption,
  mockPrompt,
  setupSuccessfulSpawn,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-harness';
import {
  defaultOptions,
  defaultContext,
  defaultHandlers,
  defaultConfigOptions,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

describe('manual workspace model launch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies the explicit initial-session model before the ACP runtime becomes available', async () => {
    const { manager } = createManagerTestHarness();
    setupSuccessfulSpawn();
    mockNewSession.mockResolvedValue({
      sessionId: 'provider-session',
      configOptions: defaultConfigOptions(),
    });
    mockSetSessionConfigOption.mockResolvedValue({
      configOptions: defaultConfigOptions().map((option) =>
        option.id === 'model' ? { ...option, currentValue: 'opus' } : option
      ),
    });
    let confirmedModel: unknown;
    const createDefaultSession = vi.fn<WorkspaceLaunchPorts['createDefaultSession']>(
      async (input) => {
        const handle = await manager.getOrCreateClient(
          'session',
          { ...defaultOptions(), provider: input.provider ?? 'CLAUDE', model: input.model },
          defaultHandlers(),
          defaultContext()
        );
        confirmedModel = handle.configOptions.find(
          (option) => option.category === 'model'
        )?.currentValue;
        return { id: 'session' };
      }
    );
    const ports: WorkspaceLaunchPorts = {
      getMaxSessionsPerWorkspace: () => 2,
      resolveProvider: vi.fn().mockResolvedValue('CLAUDE'),
      checkCliHealth: vi.fn().mockResolvedValue({
        claude: { isInstalled: true },
        codex: { isInstalled: true, isAuthenticated: true },
      }),
      createWorkspace: vi
        .fn()
        .mockResolvedValue(unsafeCoerce<CreatedWorkspace>({ id: 'workspace' })),
      createDefaultSession,
      initializeWorktree: vi.fn().mockResolvedValue(undefined),
      logger: { warn: vi.fn(), error: vi.fn() },
    };
    const result = await launchWorkspace(
      {
        type: 'MANUAL',
        projectId: 'project',
        name: 'Workspace',
        provider: 'CLAUDE',
        model: 'opus',
      },
      ports
    );
    expect(result.defaultSessionId).toBe('session');
    expect(createDefaultSession).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'CLAUDE', model: 'opus' })
    );
    expect(mockSetSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'provider-session',
      configId: 'model',
      value: 'opus',
    });
    expect(confirmedModel).toBe('opus');
    expect(mockPrompt).not.toHaveBeenCalled();
  });
});
