import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AcpRuntimeEventHandlers } from '@/backend/services/session/service/acp';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import {
  mergeLifecycleMessage,
  mergeLifecycleTranscript,
} from '@/backend/services/session/service/store/session-lifecycle-transcript';
import { buildTranscriptFromHistory } from '@/backend/services/session/service/store/session-transcript';
import type { HistoryMessage } from '@/shared/acp-protocol';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { AcpEventProcessor } from './acp-event-processor';
import { SessionStartupCancelledError } from './session-lifecycle-gate';
import { createDeferred, createLifecycleHarness } from './session-lifecycle.test-helpers';
import { createProviderHistoryHydrator } from './session-provider-history-hydrator';
import { SessionStartupCoordinator } from './session-startup.coordinator';

const { loadHistory } = vi.hoisted(() => ({ loadHistory: vi.fn() }));
vi.mock('@/backend/services/session/service/data/codex-session-history-loader.service', () => ({
  codexSessionHistoryLoaderService: { loadSessionHistory: loadHistory },
}));
vi.mock('@/backend/services/session/service/logging/acp-trace-logger.service', () => ({
  acpTraceLogger: { log: vi.fn() },
}));
vi.mock('@/backend/services/session/service/logging/session-file-logger.service', () => ({
  sessionFileLogger: { log: vi.fn() },
}));
vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: { findById: vi.fn() },
  workspaceNotificationService: {
    listPendingForDelivery: vi.fn(async () => []),
    markDelivered: vi.fn(),
  },
}));

const history: HistoryMessage[] = [
  { type: 'user', content: 'Initial prompt', timestamp: '2026-10-28T20:11:31Z' },
  { type: 'assistant', content: 'Working on it', timestamp: '2026-10-28T20:11:36Z' },
  {
    type: 'tool_use',
    content: '',
    toolId: 'native-tool',
    toolName: 'exec_command',
    toolInput: { cmd: 'pwd' },
    timestamp: '2026-10-28T20:12:00Z',
  },
  {
    type: 'tool_result',
    toolId: 'native-tool',
    content: '/tmp',
    timestamp: '2026-10-28T20:12:01Z',
  },
  { type: 'assistant', content: 'Done', timestamp: '2026-10-28T20:13:00Z' },
];

beforeEach(() => {
  vi.clearAllMocks();
  loadHistory.mockResolvedValue({ status: 'loaded', history, filePath: '/tmp/history.jsonl' });
});

function setup(provider: 'CLAUDE' | 'CODEX' = 'CODEX') {
  const h = createLifecycleHarness({ provider, providerSessionId: 'existing-thread' });
  const domain = new SessionDomainService();
  domain.replaceTranscript(
    'session-1',
    mergeLifecycleTranscript(
      [],
      [
        {
          id: 'shutdown',
          workspaceId: h.session.workspaceId,
          sessionId: 'session-1',
          kind: 'SESSION_STOPPED',
          reason: 'SYSTEM_STOP',
          message: 'Session stopped by the system.',
          dedupeKey: 'shutdown',
          createdAt: new Date('2026-10-28T20:33:54Z'),
        },
      ]
    )
  );
  const processor = new AcpEventProcessor({
    sessionDomainService: domain,
    runtimeManager: unsafeCoerce(h.runtimeManager),
    sessionPermissionService: unsafeCoerce({ createPermissionBridge: vi.fn() }),
    sessionConfigService: unsafeCoerce(h.sessionConfigService),
    onToolCallTimeout: vi.fn(),
  });
  const hydrateProviderHistory = createProviderHistoryHydrator(domain);
  const coordinator = new SessionStartupCoordinator({
    ...h,
    sessionDomainService: domain,
    acpEventProcessor: processor,
    hydrateProviderHistory,
    runtimeExitCoordinator: {
      createHandlers: () => processor.createRuntimeEventHandler('session-1'),
    },
    notificationDelivery: h.notificationDeliveryService,
    stopSession: (id, options) => h.service.stopSession(id, options),
  });
  const replay: SessionUpdate[] = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Initial prompt' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working on it' } },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'acp-tool',
      title: 'pwd',
      kind: 'execute',
      status: 'pending',
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'acp-tool',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '/tmp' } }],
    },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } },
  ];
  h.runtimeManager.getOrCreateClient.mockImplementation((id, _options, handlers) => {
    for (const update of replay) {
      handlers.onAcpEvent?.(id, { type: 'acp_session_update', update });
    }
    processor.finishPromptTurn(id);
    h.runtimeManager.getClient.mockReturnValue(h.handle);
    h.runtimeManager.getSubagentBrowseCapability.mockReturnValue({
      version: 1,
      list: true,
      read: true,
      notifications: true,
    });
    return Promise.resolve(h.handle);
  });
  return { h, domain, processor, coordinator, hydrateProviderHistory };
}

it.each(['active', 'browse'] as const)(
  'hydrates history before %s resume so later loading preserves conversation order',
  async (purpose) => {
    const { h, domain, coordinator, hydrateProviderHistory } = setup();
    if (purpose === 'browse') {
      await expect(coordinator.ensureSubagentBrowseSession('session-1')).resolves.toBe(true);
    } else {
      await coordinator.getOrCreateSessionClient('session-1');
    }
    // Opening the workspace after an automatic resume must not prepend native tools
    // ahead of ACP replay messages stamped with the current time.
    await hydrateProviderHistory('session-1', {
      ...h.session,
      workspace: { worktreePath: '/tmp/workspace' },
    });
    const transcript = domain.getTranscriptSnapshot('session-1');
    expect(transcript.map((entry) => entry.text ?? entry.message?.type)).toEqual([
      'Initial prompt',
      'assistant',
      'stream_event',
      'user',
      'assistant',
      'session_lifecycle',
    ]);
    expect(transcript.map((entry) => entry.timestamp)).toEqual([
      '2026-10-28T20:11:31Z',
      '2026-10-28T20:11:36Z',
      '2026-10-28T20:12:00Z',
      '2026-10-28T20:12:01Z',
      '2026-10-28T20:13:00Z',
      '2026-10-28T20:33:54.000Z',
    ]);
  }
);

it.each([
  { status: 'not_found' },
  { status: 'loaded', history: [], filePath: '/tmp/history.jsonl' },
])('retains ACP replay when saved history has no provider messages: $status', async (result) => {
  loadHistory.mockResolvedValue(result);
  const { domain, coordinator } = setup();
  await coordinator.getOrCreateSessionClient('session-1');
  expect(
    domain.getTranscriptSnapshot('session-1').map((entry) => entry.text ?? entry.message?.type)
  ).toEqual([
    'Initial prompt',
    'session_lifecycle',
    'assistant',
    'stream_event',
    'user',
    'assistant',
  ]);
});

it('accepts live output after suppressing hydrated resume replay', async () => {
  const { h, domain, processor, coordinator } = setup();
  await coordinator.getOrCreateSessionClient('session-1');
  h.runtimeManager.isSessionWorking.mockReturnValue(true);
  h.runtimeManager.isSessionPromptInFlight.mockReturnValue(true);
  processor.createRuntimeEventHandler('session-1').onAcpEvent?.('session-1', {
    type: 'acp_session_update',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'New live response' },
    },
  });
  processor.finishPromptTurn('session-1');
  expect(domain.getTranscriptSnapshot('session-1').at(-1)?.message?.message?.content).toEqual([
    { type: 'text', text: 'New live response' },
  ]);
});

it.each(['CLAUDE', 'CODEX'] as const)(
  'retains a complete %s fallback transcript without replay duplicates',
  async (provider) => {
    const { domain, coordinator } = setup(provider);
    domain.replaceTranscript(
      'session-1',
      mergeLifecycleMessage(
        buildTranscriptFromHistory(history),
        domain.getTranscriptSnapshot('session-1')
      ),
      { historySource: 'none' }
    );
    await coordinator.getOrCreateSessionClient('session-1');
    expect(
      domain.getTranscriptSnapshot('session-1').map((entry) => entry.text ?? entry.message?.type)
    ).toEqual([
      'Initial prompt',
      'assistant',
      'stream_event',
      'user',
      'assistant',
      'session_lifecycle',
    ]);
  }
);

it('does not spawn a runtime when stopped during history hydration', async () => {
  const reading = createDeferred<unknown>();
  loadHistory.mockReturnValue(reading.promise);
  const { h, coordinator } = setup();
  const startup = coordinator
    .getOrCreateSessionClient('session-1')
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(loadHistory).toHaveBeenCalled());
  const reservation = h.lifecycleGate.reserveStop('session-1');
  reading.resolve({ status: 'loaded', history, filePath: '/tmp/history.jsonl' });
  expect(await startup).toBeInstanceOf(SessionStartupCancelledError);
  expect(h.runtimeManager.getOrCreateClient).not.toHaveBeenCalled();
  reservation?.release();
});

it('shares history preparation across concurrent startups and keeps fallback replay flowing', async () => {
  const reading = createDeferred<unknown>();
  loadHistory.mockReturnValue(reading.promise);
  const { h, domain, processor, coordinator } = setup();
  const creating = createDeferred<typeof h.handle>();
  let replayHandlers: AcpRuntimeEventHandlers | undefined;
  h.runtimeManager.getOrCreateClient.mockImplementation((_id, _options, handlers) => {
    replayHandlers ??= handlers;
    return creating.promise.then((handle) => {
      h.runtimeManager.getClient.mockReturnValue(handle);
      return handle;
    });
  });
  const first = coordinator.getOrCreateSessionClient('session-1');
  const second = coordinator.getOrCreateSessionClient('session-1');
  await vi.waitFor(() => expect(loadHistory).toHaveBeenCalled());
  expect(loadHistory).toHaveBeenCalledOnce();
  reading.resolve({ status: 'not_found' });
  await vi.waitFor(() => expect(replayHandlers).toBeDefined());
  replayHandlers!.onAcpEvent?.('session-1', {
    type: 'acp_session_update',
    update: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Initial prompt' },
    },
  });
  await vi.waitFor(() => expect(h.runtimeManager.getOrCreateClient).toHaveBeenCalledTimes(2));
  replayHandlers!.onAcpEvent?.('session-1', {
    type: 'acp_session_update',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Last replayed reply' },
    },
  });
  processor.finishPromptTurn('session-1');
  creating.resolve(h.handle);
  await Promise.all([first, second]);
  expect(domain.getTranscriptSnapshot('session-1').at(-1)?.message?.message?.content).toEqual([
    { type: 'text', text: 'Last replayed reply' },
  ]);
});

it('leaves an already pending runtime in control of its incomplete fallback replay', async () => {
  const { h, domain, processor, coordinator } = setup();
  domain.injectCommittedUserMessage('session-1', 'Initial prompt');
  h.runtimeManager.getPendingClient.mockReturnValue(Promise.resolve(h.handle));
  h.runtimeManager.getOrCreateClient.mockImplementation((id, _options, handlers) => {
    handlers.onAcpEvent?.(id, {
      type: 'acp_session_update',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Remaining fallback reply' },
      },
    });
    processor.finishPromptTurn(id);
    h.runtimeManager.getClient.mockReturnValue(h.handle);
    return Promise.resolve(h.handle);
  });
  await coordinator.getOrCreateSessionClient('session-1');
  expect(domain.getTranscriptSnapshot('session-1').at(-1)?.message?.message?.content).toEqual([
    { type: 'text', text: 'Remaining fallback reply' },
  ]);
});

vi.mock('@/backend/services/codex-accounts', () => ({
  NATIVE_DEFAULT_CODEX_ACCOUNT_ID: 'codex-native-default',
  codexAccountService: {
    getRuntimeContext: vi.fn(async (accountId = 'codex-native-default') => ({
      accountId,
      homeDir: '/test/codex',
      sessionsDir: '/test/codex/sessions',
      env: { CODEX_HOME: '/test/codex' },
    })),
    getPreviewRuntimeContext: vi.fn(async ({ accountId = 'codex-native-default' } = {}) => ({
      accountId,
      homeDir: '/test/codex',
      sessionsDir: '/test/codex/sessions',
      env: { CODEX_HOME: '/test/codex' },
    })),
    withAccountReservation: vi.fn(async (input, create) =>
      create(input.accountId ?? 'codex-native-default')
    ),
    getUsage: vi.fn(),
  },
}));
