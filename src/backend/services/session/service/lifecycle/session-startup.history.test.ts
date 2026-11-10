import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AcpRuntimeEventHandlers } from '@/backend/services/session/service/acp';
import {
  createTestProcessHandle,
  defaultOptions,
  defaultContext,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { AcpRuntimeSupervisor } from '@/backend/services/session/service/acp/acp-runtime-supervisor';
import { createProviderHistoryHydrator } from '@/backend/services/session/service/data/session-provider-history-hydrator';
import { AcpEventProcessor } from '@/backend/services/session/service/events/acp-event-processor';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import {
  mergeLifecycleMessage,
  mergeLifecycleTranscript,
} from '@/backend/services/session/service/store/session-lifecycle-transcript';
import { buildTranscriptFromHistory } from '@/backend/services/session/service/store/session-transcript';
import type { HistoryMessage } from '@/shared/acp-protocol';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionStartupCancelledError } from './session-lifecycle-gate';
import { createDeferred, createLifecycleHarness } from './session-lifecycle.test-helpers';
import {
  createSessionHistoryBarrier,
  prepareSessionHistoryForResume,
} from './session-startup-history';
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
  h.runtimeManager.getOrCreateClient.mockImplementation(async (id, options, handlers) => {
    await options.beforeSessionCreation?.();
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

it('starts adapter initialization while cold history is pending, then gates provider replay', async () => {
  const reading = createDeferred<unknown>();
  loadHistory.mockReturnValue(reading.promise);
  const { h, coordinator, domain } = setup();
  const initializing = createDeferred<void>();
  const original = h.runtimeManager.getOrCreateClient.getMockImplementation()!;
  h.runtimeManager.getOrCreateClient.mockImplementation((...args) => {
    initializing.resolve();
    return original(...args);
  });
  const startup = coordinator.getOrCreateSessionClient('session-1');
  await initializing.promise;
  expect(loadHistory).toHaveBeenCalledOnce();
  expect(
    domain
      .getTranscriptSnapshot('session-1')
      .every((message) => message.message?.type === 'session_lifecycle')
  ).toBe(true);
  reading.resolve({ status: 'loaded', history, filePath: '/tmp/history.jsonl' });
  await startup;
  expect(domain.getTranscriptSnapshot('session-1')[0]?.text).toBe('Initial prompt');
});

it('owns a late hydration rejection after adapter initialization has failed', async () => {
  const reading = createDeferred<unknown>();
  loadHistory.mockReturnValue(reading.promise);
  const { h, coordinator } = setup();
  h.runtimeManager.getOrCreateClient.mockRejectedValue(new Error('initialize failed'));
  await expect(coordinator.getOrCreateSessionClient('session-1')).rejects.toThrow(
    'initialize failed'
  );
  reading.reject(new Error('late history read failure'));
  // Flush the detached preparation: Vitest also reports any unhandled rejection.
  await reading.promise.catch(() => undefined);
  await Promise.resolve();
});

it('does not resume a provider when stopped during concurrent history hydration', async () => {
  const reading = createDeferred<unknown>();
  loadHistory.mockReturnValue(reading.promise);
  const { h, coordinator, domain } = setup();
  const startup = coordinator
    .getOrCreateSessionClient('session-1')
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(loadHistory).toHaveBeenCalled());
  const reservation = h.lifecycleGate.reserveStop('session-1');
  reading.resolve({ status: 'loaded', history, filePath: '/tmp/history.jsonl' });
  expect(await startup).toBeInstanceOf(SessionStartupCancelledError);
  expect(h.runtimeManager.getClient('session-1')).toBeUndefined();
  expect(
    domain
      .getTranscriptSnapshot('session-1')
      .every((message) => message.message?.type === 'session_lifecycle')
  ).toBe(true);
  expect(domain.isHistoryHydrated('session-1')).toBe(false);
  reservation?.release();
});

it('shares history preparation across concurrent startups and keeps fallback replay flowing', async () => {
  const reading = createDeferred<unknown>();
  loadHistory.mockReturnValue(reading.promise);
  const { h, domain, processor, coordinator } = setup();
  const creating = createDeferred<typeof h.handle>();
  let replayHandlers: AcpRuntimeEventHandlers | undefined;
  h.runtimeManager.getOrCreateClient.mockImplementation(async (_id, options, handlers) => {
    await options.beforeSessionCreation?.();
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
  h.runtimeManager.getOrCreateClient.mockImplementation(async (id, options, handlers) => {
    await options.beforeSessionCreation?.();
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

it('joins shared history before a pending adapter can fail and release a queued retry', async () => {
  const reading = createDeferred<unknown>();
  loadHistory.mockReturnValue(reading.promise);
  const { h, domain, hydrateProviderHistory } = setup();
  const context = await h.contextService.load('session-1');
  expect(context).not.toBeNull();
  if (!context) {
    throw new Error('Missing test context');
  }
  const dependencies = {
    hydrateProviderHistory,
    sessionDomainService: domain,
    runtimeManager: h.runtimeManager,
  };
  const first = prepareSessionHistoryForResume('session-1', context, dependencies);
  h.runtimeManager.getPendingClient.mockReturnValue(Promise.resolve(h.handle));
  const retry = prepareSessionHistoryForResume('session-1', context, dependencies);
  try {
    expect(retry).toBe(first);
    expect(loadHistory).toHaveBeenCalledOnce();
  } finally {
    reading.resolve({ status: 'loaded', history, filePath: '/tmp/history.jsonl' });
    await Promise.all([first, retry]);
  }
});

it('keeps a serialized retry behind shared hydration when the first adapter initialization fails', async () => {
  const reading = createDeferred<unknown>();
  loadHistory.mockReturnValue(reading.promise);
  const { h, domain, processor, hydrateProviderHistory } = setup();
  const context = await h.contextService.load('session-1');
  if (!context) {
    throw new Error('Missing test context');
  }
  const firstInitializing = createDeferred<void>();
  const failFirst = createDeferred<void>();
  const retryInitializing = createDeferred<void>();
  const replayed = vi.fn();
  let attempt = 0;
  const supervisor = new AcpRuntimeSupervisor({
    cancelPrompt: async () => true,
    clientFactory: {
      createClient: async ({ options }) => {
        if (++attempt === 1) {
          firstInitializing.resolve();
          await failFirst.promise;
          throw new Error('first adapter initialization failed');
        }
        retryInitializing.resolve();
        await options.beforeSessionCreation?.();
        replayed();
        return createTestProcessHandle({
          providerSessionId: 'existing-thread',
          sessionCreationOutcome: { kind: 'resumed' },
        });
      },
    },
  });
  const dependencies = {
    hydrateProviderHistory,
    sessionDomainService: domain,
    runtimeManager: supervisor,
    acpEventProcessor: processor,
  };
  const barrier = () =>
    createSessionHistoryBarrier('session-1', context, dependencies, async () => undefined);
  const first = supervisor
    .getOrCreateClient(
      'session-1',
      { ...defaultOptions(), beforeSessionCreation: barrier() },
      {},
      defaultContext()
    )
    .catch((error: unknown) => error);
  await firstInitializing.promise;
  expect(supervisor.getPendingClient('session-1')).toBeDefined();
  const retry = supervisor.getOrCreateClient(
    'session-1',
    { ...defaultOptions(), beforeSessionCreation: barrier() },
    {},
    defaultContext()
  );
  failFirst.resolve();
  await retryInitializing.promise;
  // Drain only promise continuations, with no wall-clock delay or provider work.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(replayed).not.toHaveBeenCalled();
  reading.resolve({ status: 'loaded', history, filePath: '/tmp/history.jsonl' });
  expect(await first).toBeInstanceOf(Error);
  await retry;
  expect(replayed).toHaveBeenCalledOnce();
  expect(domain.getTranscriptSnapshot('session-1')[0]?.timestamp).toBe(history[0]?.timestamp);
});

it.each(['existing-thread', null])(
  'discards old %s suppression after identity replacement during the caller check',
  async (oldIdentity) => {
    const { h, domain, processor, hydrateProviderHistory } = setup();
    const context = await h.contextService.load('session-1');
    if (!context) {
      throw new Error('Missing test context');
    }
    context.session.providerSessionId = oldIdentity;
    context.session.providerMetadata = {};
    loadHistory.mockResolvedValue({ status: 'not_found' });
    const checking = createDeferred<void>();
    const checked = createDeferred<void>();
    const suppression = vi.spyOn(processor, 'setReplaySuppression');
    const barrier = createSessionHistoryBarrier(
      'session-1',
      context,
      {
        hydrateProviderHistory,
        sessionDomainService: domain,
        runtimeManager: h.runtimeManager,
        acpEventProcessor: processor,
      },
      async () => {
        checking.resolve();
        await checked.promise;
      }
    );
    const committing = barrier();
    await checking.promise;
    domain.resetProviderHistory('session-1', 'replacement');
    processor.setReplaySuppression('session-1', true);
    checked.resolve();
    await committing;
    expect(suppression).toHaveBeenCalledExactlyOnceWith('session-1', true);
  }
);

it.each(['stop', 'source reset'])(
  'starts fresh hydration after %s instead of joining an obsolete same-provider preparation',
  async (invalidation) => {
    const oldRead = createDeferred<unknown>();
    const newRead = createDeferred<unknown>();
    loadHistory.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const { h, domain, hydrateProviderHistory } = setup();
    const context = await h.contextService.load('session-1');
    if (!context) {
      throw new Error('Missing test context');
    }
    const dependencies = {
      hydrateProviderHistory,
      sessionDomainService: domain,
      runtimeManager: h.runtimeManager,
    };
    let oldCurrent = true;
    const old = prepareSessionHistoryForResume(
      'session-1',
      context,
      dependencies,
      undefined,
      () => oldCurrent
    );
    if (invalidation === 'stop') {
      oldCurrent = false;
    } else {
      domain.resetProviderHistory('session-1', 'existing-thread');
    }
    h.runtimeManager.getPendingClient.mockReturnValue(Promise.resolve(h.handle));
    const fresh = prepareSessionHistoryForResume(
      'session-1',
      context,
      dependencies,
      undefined,
      () => true
    );
    expect(fresh).not.toBe(old);
    expect(loadHistory).toHaveBeenCalledTimes(2);
    oldRead.resolve({ status: 'loaded', history, filePath: '/tmp/old.jsonl' });
    await expect(old).resolves.toBe(false);
    expect(domain.isHistoryHydrated('session-1')).toBe(false);
    const joining = prepareSessionHistoryForResume(
      'session-1',
      context,
      dependencies,
      undefined,
      () => true
    );
    expect(joining).toBe(fresh);
    newRead.resolve({ status: 'loaded', history, filePath: '/tmp/fresh.jsonl' });
    await expect(fresh).resolves.toBe(true);
    expect(domain.getTranscriptSnapshot('session-1')[0]?.timestamp).toBe(history[0]?.timestamp);
  }
);

it('rejects a delayed null-source preparation after repaired history is ordinarily evicted', async () => {
  const { h, domain, processor, hydrateProviderHistory } = setup();
  const context = await h.contextService.load('session-1');
  if (!context) {
    throw new Error('Missing test context');
  }
  context.session.providerSessionId = null;
  context.session.providerMetadata = {};
  domain.resetProviderHistory('session-1', 'replacement');
  domain.clearSession('session-1');
  processor.setReplaySuppression('session-1', true);
  const suppression = vi.spyOn(processor, 'setReplaySuppression');
  const barrier = createSessionHistoryBarrier(
    'session-1',
    context,
    {
      hydrateProviderHistory,
      sessionDomainService: domain,
      runtimeManager: h.runtimeManager,
      acpEventProcessor: processor,
    },
    async () => undefined
  );
  await barrier();
  expect(suppression).not.toHaveBeenCalled();
  expect(domain.isHistoryHydrated('session-1')).toBe(false);
  expect(domain.acceptProviderHistoryIdentity('session-1', 'replacement')).toBe(true);
});

it('rechecks lifecycle generation after the caller check resolves before committing suppression', async () => {
  const { h, domain, processor, hydrateProviderHistory } = setup();
  const context = await h.contextService.load('session-1');
  if (!context) {
    throw new Error('Missing test context');
  }
  loadHistory.mockResolvedValue({ status: 'not_found' });
  const generation = h.lifecycleGate.getGeneration('session-1');
  const isCurrent = () =>
    h.lifecycleGate.isGenerationCurrent('session-1', generation) &&
    !h.lifecycleGate.isSessionStopping('session-1');
  const suppression = vi.spyOn(processor, 'setReplaySuppression');
  const barrier = createSessionHistoryBarrier(
    'session-1',
    context,
    {
      hydrateProviderHistory,
      sessionDomainService: domain,
      runtimeManager: h.runtimeManager,
      acpEventProcessor: processor,
    },
    () => {
      expect(isCurrent()).toBe(true);
      queueMicrotask(() => {
        const stop = h.lifecycleGate.reserveStop('session-1');
        stop?.release();
        h.lifecycleGate.getGeneration('session-1');
        processor.setReplaySuppression('session-1', true);
      });
      return Promise.resolve();
    },
    undefined,
    isCurrent
  );
  await barrier();
  expect(isCurrent()).toBe(false);
  expect(suppression).toHaveBeenCalledExactlyOnceWith('session-1', true);
});
