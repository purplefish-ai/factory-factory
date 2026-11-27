import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { sessionCommandFactories } from '@/backend/services/session';
import {
  SessionDomainService,
  SessionLoadService,
  sessionEventBus,
} from '@/backend/services/session';
import type { CommandInfo } from '@/shared/acp-protocol';
import type { SessionConfigOption } from '@/shared/acp-protocol/sdk-types';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { createTestEventLog } from '@/test-utils/test-event-log';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { disposeChatTransportForApplication } from './chat-connection-registry';
import { createChatRouterServices } from './chat-message-router.test-helpers';
import { createChatUpgradeHandler } from './chat.handler';
import { MockWebSocket } from './mock-websocket.test-helpers';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
const applications: AppContext[] = [];
const domains: SessionDomainService[] = [];
afterEach(() => {
  for (const app of applications.splice(0)) {
    disposeChatTransportForApplication(app);
  }
  for (const domain of domains.splice(0)) {
    domain.clearAllSessions();
  }
  vi.restoreAllMocks();
});

interface SessionMetadataFixture {
  provider: 'CLAUDE' | 'CODEX';
  configOptions: SessionConfigOption[];
}

const DEFAULT_SESSION: SessionMetadataFixture = {
  provider: 'CODEX',
  configOptions: [
    { id: 'model', name: 'Model', type: 'select', currentValue: 'chosen', options: [] },
  ],
};

function setup(
  metadata: {
    sessions?: Record<string, SessionMetadataFixture>;
    claudeCommands?: CommandInfo[];
  } = {}
) {
  const sessions = metadata.sessions ?? {};
  const sessionFixture = (sessionId: string) => sessions[sessionId] ?? DEFAULT_SESSION;
  const ports = createChatRouterServices(sessionCommandFactories);
  const domain = new SessionDomainService();
  domains.push(domain);
  const hydrate = vi.fn(async (): Promise<void> => undefined);
  const capabilities = vi.fn(async () => EMPTY_CHAT_BAR_CAPABILITIES);
  const findSession = vi.fn(async (sessionId: string) => ({
    provider: sessionFixture(sessionId).provider,
    providerSessionId: null,
    providerMetadata: null,
    status: 'IDLE',
    workspace: { status: 'READY', worktreePath: null },
  }));
  const load = new SessionLoadService({
    findSession,
    hydrateProviderHistory: hydrate,
    hydrateLifecycleEvents: async () => undefined,
    getRuntimeSnapshot: () => ({
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      updatedAt: '2026-10-27T12:00:00.000Z',
    }),
    domain,
    config: {
      getSessionConfigProjection: async (sessionId) => {
        const value = await capabilities();
        return {
          currentProjection: () => ({
            capabilities: value,
            configOptions: sessionFixture(sessionId).configOptions,
          }),
        };
      },
    },
    getCachedCommands: async () => metadata.claudeCommands ?? [],
    tryDispatchNextMessage: ports.dispatch.tryDispatchNextMessage,
  });
  const completingLoads = createTestEventLog<Promise<void>>();
  const completeLoad = load.completeLoad.bind(load);
  vi.spyOn(load, 'completeLoad').mockImplementation((prepared) => {
    const completion = completeLoad(prepared);
    completingLoads.record(completion);
    return completion;
  });
  const app = unsafeCoerce<AppContext>({
    services: {
      sessionCommandFactories: ports.factories,
      acpRuntimeManager: ports.runtime,
      sessionDomainService: domain,
      sessionLoadService: load,
      sessionLifecycleService: { ...ports.execution.lifecycle, ...ports.startup },
      sessionBackgroundDeliveryService: ports.execution.backgroundDelivery,
      sessionDispatchService: ports.dispatch,
      sessionService: ports.prompt,
      sessionPermissionService: ports.permission,
      sessionConfigService: ports.config,
      sessionEventBus,
      chatEventForwarderService: {
        setupWorkspaceNotifications: vi.fn(),
        clearPendingRequest: ports.execution.clearPendingRequest,
      },
      sessionFileLogger: { initSession: vi.fn(), log: vi.fn(), closeSession: vi.fn() },
      createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
      configService: {
        getCorsConfig: () => ({ allowedOrigins: ['http://localhost:3000'] }),
        getDebugConfig: () => ({ chatWebSocket: false }),
        getWebSocketConfig: () => ({ maxFrameBytes: 33_554_432 }),
      },
    },
  });
  applications.push(app);
  const handler = createChatUpgradeHandler(app);
  const connect = (id: string, sessionId = 's1') => {
    const ws = new MockWebSocket();
    const wss = unsafeCoerce<WebSocketServer>({
      handleUpgrade: (
        _req: IncomingMessage,
        _socket: Duplex,
        _head: Buffer,
        callback: (ws: WebSocket) => void
      ) => callback(unsafeCoerce(ws)),
    });
    handler(
      unsafeCoerce({
        headers: { origin: 'http://localhost:3000' },
        socket: { remoteAddress: '127.0.0.1' },
      }),
      unsafeCoerce({ write: vi.fn(), destroy: vi.fn() }),
      Buffer.alloc(0),
      new URL(`http://localhost/chat?connectionId=${id}&sessionId=${sessionId}`),
      wss,
      new WeakMap()
    );
    return ws;
  };
  return { app, domain, ports, hydrate, capabilities, findSession, connect, completingLoads };
}
function frames(ws: MockWebSocket) {
  return ws.send.mock.calls.map(([payload]) => JSON.parse(payload));
}

describe('load-session through the actual chat transport', () => {
  it('sends replay to its requester and runtime to every viewer before pending configuration, and activates initial text after all load updates', async () => {
    const test = setup();
    const config = deferred<typeof EMPTY_CHAT_BAR_CAPABILITIES>();
    const configurationStarted = deferred<void>();
    test.capabilities.mockImplementation(() => {
      configurationStarted.resolve();
      return config.promise;
    });
    test.domain.storeInitialMessage('s1', 'Start once');
    const requester = test.connect('requester');
    const viewer = test.connect('viewer');
    requester.emit('message', JSON.stringify({ type: 'load_session', loadRequestId: 'load-1' }));
    await configurationStarted.promise;
    expect(requester.send).toHaveBeenCalledTimes(2);
    expect(frames(requester)).toEqual([
      {
        type: 'session_replay_batch',
        loadRequestId: 'load-1',
        replayEvents: [expect.objectContaining({ type: 'session_runtime_snapshot' })],
      },
      { type: 'session_delta', data: expect.objectContaining({ type: 'session_runtime_updated' }) },
    ]);
    // The viewer did not request the replay, and would drop it.
    expect(frames(viewer)).toEqual(frames(requester).slice(1));
    expect(test.ports.startup.getOrCreateSessionClient).not.toHaveBeenCalled();
    expect(test.ports.dispatch.tryDispatchNextMessage).not.toHaveBeenCalled();
    config.resolve(EMPTY_CHAT_BAR_CAPABILITIES);
    await test.completingLoads.waitForCount(1);
    await test.completingLoads.events[0];
    expect(test.ports.dispatch.tryDispatchNextMessage).toHaveBeenCalledExactlyOnceWith('s1');
    expect(
      frames(requester)
        .slice(2, 5)
        .map((frame) => frame.data.type)
    ).toEqual(['chat_capabilities', 'config_options_update', 'slash_commands']);
    expect(frames(viewer)).toEqual(frames(requester).slice(1));
    const queued = test.domain.peekNextMessage('s1');
    expect(queued).toMatchObject({ id: expect.stringMatching(/^msg-/), text: 'Start once' });
    expect(frames(requester).at(-1)).toMatchObject({
      type: 'session_delta',
      data: { type: 'message_state_changed', id: queued?.id, newState: 'ACCEPTED' },
    });
  });

  it('loads passive history without creating a runtime or dispatching work', async () => {
    const test = setup();
    const requester = test.connect('requester');
    requester.emit('message', JSON.stringify({ type: 'load_session', loadRequestId: 'passive' }));
    await test.completingLoads.waitForCount(1);
    await test.completingLoads.events[0];
    expect(frames(requester).at(-1)).toMatchObject({
      type: 'session_delta',
      data: { type: 'slash_commands' },
    });
    expect(test.ports.startup.getOrCreateSessionClient).not.toHaveBeenCalled();
    expect(test.ports.dispatch.tryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it('preserves hydration failure error copy and keeps it private to the requester', async () => {
    const test = setup();
    test.hydrate.mockRejectedValue(new Error('history unavailable'));
    const requester = test.connect('requester');
    const viewer = test.connect('viewer');
    requester.emit('message', JSON.stringify({ type: 'load_session', loadRequestId: 'failed' }));
    await requester.sent.waitForCount(1);
    expect(frames(requester)).toEqual([{ type: 'error', message: 'Invalid message format' }]);
    expect(viewer.send).not.toHaveBeenCalled();
    expect(test.ports.dispatch.tryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it('delivers a missing-session error only to the requester', async () => {
    const test = setup();
    test.findSession.mockResolvedValue(unsafeCoerce(null));
    const requester = test.connect('requester');
    const viewer = test.connect('viewer');
    requester.emit('message', JSON.stringify({ type: 'load_session', loadRequestId: 'missing' }));
    await requester.sent.waitForCount(1);
    expect(frames(requester)).toEqual([{ type: 'error', message: 'Session not found' }]);
    expect(viewer.send).not.toHaveBeenCalled();
    expect(test.hydrate).not.toHaveBeenCalled();
    expect(test.ports.dispatch.tryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it('completes application loading after the requester closes during replay publication', async () => {
    const test = setup();
    test.domain.storeInitialMessage('s1', 'Continue after disconnect');
    const requester = test.connect('requester');
    const viewer = test.connect('viewer');
    requester.send.mockImplementationOnce(() => {
      requester.readyState = WS_READY_STATE.CLOSED;
      requester.emit('close');
    });
    requester.emit(
      'message',
      JSON.stringify({ type: 'load_session', loadRequestId: 'disconnected' })
    );
    await test.completingLoads.waitForCount(1);
    await test.completingLoads.events[0];
    expect(test.ports.dispatch.tryDispatchNextMessage).toHaveBeenCalledExactlyOnceWith('s1');
    expect(frames(viewer).map((frame) => frame.type)).not.toContain('session_replay_batch');
    expect(frames(viewer).at(-1)).toMatchObject({
      type: 'session_delta',
      data: { type: 'message_state_changed', newState: 'ACCEPTED' },
    });
    expect(test.domain.peekNextMessage('s1')?.text).toBe('Continue after disconnect');
  });

  it('retains disconnected state until failed hydration settles, then cleans up', async () => {
    const test = setup();
    const history = deferred<void>();
    const hydrationStarted = deferred<void>();
    test.hydrate.mockImplementation(() => {
      hydrationStarted.resolve();
      return history.promise;
    });
    const sessionCleared = deferred<void>();
    const clearSession = test.domain.clearSession.bind(test.domain);
    const clear = vi.spyOn(test.domain, 'clearSession').mockImplementation((...args) => {
      clearSession(...args);
      sessionCleared.resolve();
    });
    const requester = test.connect('requester');
    requester.emit('message', JSON.stringify({ type: 'load_session' }));
    await hydrationStarted.promise;
    expect(test.hydrate).toHaveBeenCalled();
    requester.readyState = WS_READY_STATE.CLOSED;
    requester.emit('close');
    expect(clear).not.toHaveBeenCalled();
    history.reject(new Error('history unavailable'));
    await sessionCleared.promise;
    expect(clear).toHaveBeenCalledExactlyOnceWith('s1', { preserveRejections: true });
    expect(requester.send).not.toHaveBeenCalled();
    expect(test.ports.dispatch.tryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it('correlates concurrent replay loads and consumes initial text only once', async () => {
    const test = setup();
    const firstConfig = deferred<typeof EMPTY_CHAT_BAR_CAPABILITIES>();
    const firstConfigurationStarted = deferred<void>();
    test.capabilities.mockImplementationOnce(() => {
      firstConfigurationStarted.resolve();
      return firstConfig.promise;
    });
    test.domain.storeInitialMessage('s1', 'Start once');
    const requester = test.connect('requester');
    requester.emit('message', JSON.stringify({ type: 'load_session', loadRequestId: 'first' }));
    await firstConfigurationStarted.promise;
    expect(test.capabilities).toHaveBeenCalledTimes(1);
    requester.emit('message', JSON.stringify({ type: 'load_session', loadRequestId: 'second' }));
    await test.completingLoads.waitForCount(2);
    await test.completingLoads.events[1];
    expect(test.ports.dispatch.tryDispatchNextMessage).toHaveBeenCalledTimes(1);
    firstConfig.resolve(EMPTY_CHAT_BAR_CAPABILITIES);
    await test.completingLoads.events[0];
    expect(frames(requester).filter((frame) => frame.data?.type === 'slash_commands')).toHaveLength(
      2
    );
    expect(
      frames(requester)
        .filter((frame) => frame.type === 'session_replay_batch')
        .map((frame) => frame.loadRequestId)
    ).toEqual(['first', 'second']);
    expect(test.domain.getQueueLength('s1')).toBe(1);
    expect(test.ports.dispatch.tryDispatchNextMessage).toHaveBeenCalledTimes(1);
  });
});

/** Rows of a replay batch as the client numbers them. */
function replayRows(ws: MockWebSocket) {
  const batch = frames(ws).find((frame) => frame.type === 'session_replay_batch');
  return (batch?.replayEvents ?? []).flatMap(
    (event: { type: string; id?: string; userMessage?: { text: string; order?: number } }) =>
      event.type === 'message_state_changed' && event.userMessage
        ? [{ id: event.id, order: event.userMessage.order, text: event.userMessage.text }]
        : []
  );
}

describe('switching back to an idle session within the grace period', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ff-retained-history-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** Hydrates like the provider history hydrator: each read projects fresh row ids. */
  async function withHistoryFile(lines: string[]) {
    const test = setup();
    const file = join(directory, 'history.jsonl');
    await writeFile(file, `${lines.join('\n')}\n`);
    let reads = 0;
    test.hydrate.mockImplementation(async () => {
      if (test.domain.isHistoryHydrated('s1')) {
        return;
      }
      reads += 1;
      const identity = await stat(file);
      const text = await readFile(file, 'utf8');
      const rows = text
        .split('\n')
        .filter(Boolean)
        .map((line, order) => ({
          id: `read-${reads}-${order}`,
          source: 'user' as const,
          text: line,
          timestamp: '2026-11-23T00:00:00.000Z',
          order,
        }));
      test.domain.replaceTranscript('s1', rows, {
        historySource: 'jsonl',
        historyFile: {
          filePath: file,
          size: identity.size,
          mtimeMs: identity.mtimeMs,
          ino: identity.ino,
        },
      });
    });
    const released = vi.spyOn(test.domain, 'releaseViewerless');
    /** Close the socket and wait until its finished load lets the session go. */
    const leave = async (ws: MockWebSocket) => {
      disconnect(ws);
      await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
    };
    return { test, file, leave, reads: () => reads };
  }

  it('replays the retained store without reading history, keeping row ids and orders', async () => {
    const { test, leave, reads } = await withHistoryFile(['first', 'second']);
    const phone = test.connect('phone');
    await loadSession(test, phone, 'first');
    const before = replayRows(phone);
    expect(before.map((row: { text: string }) => row.text)).toEqual(['first', 'second']);

    await leave(phone);
    const resumed = test.connect('phone');
    await loadSession(test, resumed, 'second');
    expect(reads()).toBe(1);
    expect(replayRows(resumed)).toEqual(before);
  });

  it('reads history again when its file changed while the store was retained', async () => {
    const { test, file, leave, reads } = await withHistoryFile(['first', 'second']);
    const phone = test.connect('phone');
    await loadSession(test, phone, 'first');

    await leave(phone);
    await appendFile(file, 'written elsewhere\n');
    const resumed = test.connect('phone');
    await loadSession(test, resumed, 'second');
    expect(reads()).toBe(2);
    expect(replayRows(resumed).map((row: { text: string }) => row.text)).toEqual([
      'first',
      'second',
      'written elsewhere',
    ]);
  });
});

const claudeCommands: CommandInfo[] = Array.from({ length: 60 }, (_, index) => ({
  name: `review-${index}`,
  description: `Review step ${index}, described at the length of a real command`,
  argumentHint: '[path]',
}));

function selectOption(id: string, currentValue = 'value-0'): SessionConfigOption {
  return {
    id,
    name: id,
    type: 'select',
    currentValue,
    options: Array.from({ length: 30 }, (_, index) => ({
      value: `value-${index}`,
      name: `Value ${index}`,
      description: 'An option described at the length of a real model entry',
    })),
  };
}

const claudeSession: SessionMetadataFixture = {
  provider: 'CLAUDE',
  configOptions: [selectOption('model'), selectOption('effort')],
};
const codexSession: SessionMetadataFixture = {
  provider: 'CODEX',
  configOptions: [selectOption('model', 'value-3'), selectOption('thought_level')],
};
const METADATA_TYPES = new Set(['slash_commands', 'config_options_update', 'cached_metadata']);

interface MetadataFrame {
  bytes: number;
  data: {
    type: string;
    digest?: string;
    deltaType?: string;
    slashCommands?: CommandInfo[];
    configOptions?: SessionConfigOption[];
  };
}

function metadataFrames(ws: MockWebSocket): MetadataFrame[] {
  return ws.send.mock.calls.flatMap(([raw]) => {
    const frame = JSON.parse(raw);
    return frame.type === 'session_delta' && METADATA_TYPES.has(frame.data.type)
      ? [{ bytes: Buffer.byteLength(raw), data: frame.data }]
      : [];
  });
}

function digestsOf(frames: MetadataFrame[]): string[] {
  return frames.flatMap((frame) => (frame.data.digest ? [frame.data.digest] : []));
}

function totalBytes(frames: MetadataFrame[]): number {
  return frames.reduce((sum, frame) => sum + frame.bytes, 0);
}

async function loadSession(
  test: ReturnType<typeof setup>,
  ws: MockWebSocket,
  loadRequestId: string,
  digests?: string[]
) {
  const index = test.completingLoads.events.length;
  ws.send.mockClear();
  ws.emit(
    'message',
    JSON.stringify({
      type: 'load_session',
      loadRequestId,
      ...(digests ? { cachedMetadata: { digests } } : {}),
    })
  );
  await test.completingLoads.waitForCount(index + 1);
  await test.completingLoads.events[index];
  return metadataFrames(ws);
}

function disconnect(ws: MockWebSocket) {
  ws.readyState = WS_READY_STATE.CLOSED;
  ws.emit('close');
}

describe('slash commands and config options a viewer already holds', () => {
  it('sends them whole on first connect and only acknowledges them on an unchanged reconnect', async () => {
    const test = setup({ sessions: { s1: claudeSession }, claudeCommands });
    const phone = test.connect('phone');
    const first = await loadSession(test, phone, 'first');
    expect(first.map((frame) => frame.data.type)).toEqual([
      'config_options_update',
      'slash_commands',
    ]);
    expect(first[0]?.data.configOptions).toEqual(claudeSession.configOptions);
    expect(first[1]?.data.slashCommands).toEqual(claudeCommands);
    const digests = digestsOf(first);
    expect(digests).toEqual([expect.stringMatching(/^v1:/), expect.stringMatching(/^v1:/)]);

    disconnect(phone);
    const resumed = test.connect('phone');
    const second = await loadSession(test, resumed, 'second', digests);
    expect(second.map((frame) => frame.data)).toEqual([
      { type: 'cached_metadata', deltaType: 'config_options_update', digest: digests[0] },
      { type: 'cached_metadata', deltaType: 'slash_commands', digest: digests[1] },
    ]);
    // Acknowledgements keep the position of the deltas they replace.
    expect(
      resumed.send.mock.calls
        .map(([raw]) => JSON.parse(raw))
        .filter((frame) => frame.type === 'session_delta')
        .map((frame) => frame.data.type)
        .slice(-3)
    ).toEqual(['chat_capabilities', 'cached_metadata', 'cached_metadata']);
    expect(totalBytes(first)).toBeGreaterThan(10_000);
    expect(totalBytes(second)).toBeLessThan(400);
  });

  it('sends a changed value whole even when the viewer offers its previous digest', async () => {
    const commands = [...claudeCommands];
    const test = setup({ sessions: { s1: claudeSession }, claudeCommands: commands });
    const phone = test.connect('phone');
    const digests = digestsOf(await loadSession(test, phone, 'first'));
    commands.push({ name: 'deploy', description: 'Added while the phone was asleep' });

    disconnect(phone);
    const resumed = test.connect('phone');
    const [config, slash] = await loadSession(test, resumed, 'second', digests);
    expect(config?.data).toEqual({
      type: 'cached_metadata',
      deltaType: 'config_options_update',
      digest: digests[0],
    });
    expect(slash?.data.type).toBe('slash_commands');
    expect(slash?.data.slashCommands).toEqual(commands);
    expect(slash?.data.digest).toEqual(expect.stringMatching(/^v1:/));
    expect(slash?.data.digest).not.toBe(digests[1]);
  });

  it('decides per viewer, so a second tab without the digest still receives the payload', async () => {
    const test = setup({ sessions: { s1: claudeSession }, claudeCommands });
    const desktop = test.connect('desktop');
    const digests = digestsOf(await loadSession(test, desktop, 'desktop-load'));
    const phone = test.connect('phone');
    await loadSession(test, phone, 'phone-first');
    desktop.send.mockClear();

    const phoneFrames = await loadSession(test, phone, 'phone-again', digests);
    expect(phoneFrames.map((frame) => frame.data.type)).toEqual([
      'cached_metadata',
      'cached_metadata',
    ]);
    // The desktop tab offered nothing with its load, so it gets the whole payload.
    expect(metadataFrames(desktop).map((frame) => frame.data)).toEqual([
      {
        type: 'config_options_update',
        configOptions: claudeSession.configOptions,
        digest: digests[0],
      },
      { type: 'slash_commands', slashCommands: claudeCommands, digest: digests[1] },
    ]);
  });

  it('matches content rather than session, across providers', async () => {
    const test = setup({
      sessions: { claude: claudeSession, codex: codexSession },
      claudeCommands,
    });
    const claudeTab = test.connect('tab', 'claude');
    const claudeDigests = digestsOf(await loadSession(test, claudeTab, 'claude-first'));

    disconnect(claudeTab);
    const codexTab = test.connect('tab', 'codex');
    const codexFrames = await loadSession(test, codexTab, 'codex-first', claudeDigests);
    expect(codexFrames.map((frame) => frame.data.type)).toEqual([
      'config_options_update',
      'slash_commands',
    ]);
    expect(codexFrames[0]?.data.configOptions).toEqual(codexSession.configOptions);
    expect(codexFrames[1]?.data).toEqual({ type: 'slash_commands', slashCommands: [] });
    const codexDigests = digestsOf(codexFrames);
    expect(codexDigests).toHaveLength(1);

    disconnect(codexTab);
    const back = test.connect('tab', 'claude');
    const backFrames = await loadSession(test, back, 'claude-again', [
      ...codexDigests,
      ...claudeDigests,
    ]);
    expect(backFrames.map((frame) => frame.data)).toEqual([
      { type: 'cached_metadata', deltaType: 'config_options_update', digest: claudeDigests[0] },
      { type: 'cached_metadata', deltaType: 'slash_commands', digest: claudeDigests[1] },
    ]);
  });

  it('acknowledges a digest offered after a server restart', async () => {
    const before = setup({ sessions: { s1: claudeSession }, claudeCommands });
    const digests = digestsOf(await loadSession(before, before.connect('phone'), 'before'));
    disposeChatTransportForApplication(before.app);

    const after = setup({ sessions: { s1: claudeSession }, claudeCommands });
    const frames = await loadSession(after, after.connect('phone'), 'after', digests);
    expect(frames.map((frame) => frame.data.type)).toEqual(['cached_metadata', 'cached_metadata']);
  });

  it('sends small metadata whole and without a digest', async () => {
    const test = setup();
    const frames = await loadSession(test, test.connect('phone'), 'small', ['v1:unrelated']);
    expect(frames.map((frame) => frame.data)).toEqual([
      { type: 'config_options_update', configOptions: DEFAULT_SESSION.configOptions },
      { type: 'slash_commands', slashCommands: [] },
    ]);
  });
});
