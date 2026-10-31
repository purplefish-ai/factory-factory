import type {
  SessionConfigOption,
  SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk/unstable';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpRuntimeConfigController } from '@/backend/services/session/service/acp/acp-runtime-config-controller';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import { SessionDispatchService } from '@/backend/services/session/service/dispatch/session-dispatch.service';
import { SessionConfigService } from '@/backend/services/session/service/lifecycle/session.config.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { userSettingsService } from '@/backend/services/settings';
import type { QueuedMessage } from '@/shared/acp-protocol';
import type { ChatProvider } from '@/shared/chat-capabilities';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

vi.mock('@/backend/services/settings', () => ({ userSettingsService: { get: vi.fn() } }));

function setup(provider: ChatProvider) {
  const effortId = provider === 'CLAUDE' ? 'effort' : 'reasoning_effort';
  const planId = provider === 'CLAUDE' ? 'mode' : 'collaboration_mode';
  const model = provider === 'CLAUDE' ? 'sonnet' : 'gpt-6-sol';
  const configOptions: SessionConfigOption[] = [
    {
      id: 'model',
      category: 'model',
      name: 'Model',
      type: 'select',
      currentValue: model,
      options: [{ value: model, name: model }],
    },
    {
      id: effortId,
      category: 'thought_level',
      name: 'Thinking',
      type: 'select',
      currentValue: 'medium',
      options: ['low', 'medium', 'high'].map((value) => ({ value, name: value })),
    },
    {
      id: planId,
      category: planId,
      name: 'Planning',
      type: 'select',
      currentValue: 'plan',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  ];
  if (provider === 'CODEX') {
    configOptions.push({
      id: 'mode',
      category: 'mode',
      name: 'Access',
      type: 'select',
      currentValue: 'workspace-write',
      options: [{ value: 'workspace-write', name: 'Workspace access' }],
    });
  }
  const nativeSet = vi.fn(async ({ configId, value }: SetSessionConfigOptionRequest) => ({
    configOptions: handle.configOptions.map((option) =>
      option.id !== configId
        ? option
        : option.type === 'select' && typeof value === 'string'
          ? { ...option, currentValue: value }
          : option.type === 'boolean' && typeof value === 'boolean'
            ? { ...option, currentValue: value }
            : option
    ),
  }));
  const handle = createTestProcessHandle({
    provider,
    providerSessionId: 'native-session',
    connection: { setSessionConfigOption: nativeSet },
  });
  handle.configOptions = configOptions;
  const controller = new AcpRuntimeConfigController();
  const runtime = {
    getClient: () => handle,
    isStopInProgress: () => false,
    isSessionWorking: () => false,
    isSessionPromptInFlight: () => false,
    isSessionRunning: () => true,
    setConfigOption: (id: string, configId: string, value: string) =>
      controller.setConfigOption(handle, configId, value, id),
  };
  const session = {
    id: 'session',
    workspaceId: 'workspace',
    provider,
    model,
    workflow: 'followup',
    providerSessionId: 'native-session',
    providerMetadata: null,
    workspace: { status: 'READY', worktreePath: '/tmp/launch-dispatch' },
  };
  const repository = {
    getSessionById: async () => session,
    updateSession: (_id: string, update: object, assertCurrent?: () => void) => {
      assertCurrent?.();
      return Promise.resolve(Object.assign(session, update));
    },
  };
  const configService = new SessionConfigService({
    repository: unsafeCoerce(repository),
    runtimeManager: unsafeCoerce(runtime),
    codexModelCatalogService: { getModels: vi.fn() },
    sessionDomainService,
  });
  const prompted: { effort: unknown; plan: unknown }[] = [];
  const dispatcher = new SessionDispatchService({
    runtimeManager: runtime,
    configService,
    promptService: {
      steerSessionMessage: async () => ({ outcome: 'injected' }),
      sendSessionMessage: () => {
        prompted.push({
          effort: handle.configOptions.find((option) => option.id === effortId)?.currentValue,
          plan: handle.configOptions.find((option) => option.id === planId)?.currentValue,
        });
        return Promise.resolve();
      },
    },
    backgroundDelivery: { prepare: vi.fn(), validate: vi.fn(), fail: vi.fn(), complete: vi.fn() },
  });
  dispatcher.configure({
    initPolicy: { getWorkspaceInitPolicy: () => ({ dispatchPolicy: 'allowed' }) },
  });
  dispatcher.configureLifecycle({
    gate: {
      getGeneration: () => 0,
      isGenerationCurrent: () => true,
      isSessionStopping: () => false,
    },
    startup: { getSessionClient: () => handle, getOrCreateSessionClient: async () => handle },
    notificationDelivery: {
      claimForDispatch: () => ({ status: 'not_notification' }),
      isAlreadyDelivered: async () => false,
      acknowledgeSuccessfulDispatch: async () => undefined,
      recoverPending: async () => ({ dispatchableCount: 0 }),
      resetSession: () => undefined,
      removeDuplicateFromQueue: () => false,
      isNotificationMessage: () => false,
    },
  });
  vi.spyOn(sessionDataService, 'findAgentSessionById').mockResolvedValue(unsafeCoerce(session));
  return { dispatcher, prompted, nativeSet };
}

beforeEach(() => {
  vi.mocked(userSettingsService.get).mockResolvedValue(
    unsafeCoerce({
      defaultClaudeReasoningEffort: 'high',
      defaultCodexReasoningEffort: 'high',
    })
  );
});
afterEach(() => {
  sessionDomainService.clearAllSessions();
  vi.restoreAllMocks();
});

describe.each(['CLAUDE', 'CODEX'] as const)(
  '%s confirmed launch configuration at first dispatch',
  (provider) => {
    it.each([
      { effort: null, expected: 'medium' },
      { effort: 'low', expected: 'low' },
    ])(
      'dispatches with $expected when the queued effort is $effort',
      async ({ effort, expected }) => {
        const { dispatcher, prompted } = setup(provider);
        const message: QueuedMessage = {
          id: 'initial-message',
          text: 'First task',
          timestamp: '2026-10-27T00:00:00Z',
          settings: {
            selectedModel: null,
            reasoningEffort: effort,
            thinkingEnabled: false,
            planModeEnabled: false,
          },
        };
        sessionDomainService.enqueue('session', message);
        await dispatcher.tryDispatchNextMessage('session');
        expect(prompted).toEqual([{ effort: expected, plan: 'plan' }]);
        expect(sessionDomainService.peekNextMessage('session')).toBeUndefined();
      }
    );
  }
);
