import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { sessionCommandFactories } from '@/backend/services/session';
import {
  SessionDomainService,
  SessionLoadService,
  sessionEventBus,
} from '@/backend/services/session';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { disposeChatTransportForApplication } from './chat-connection-registry';
import { createChatRouterServices } from './chat-message-router.test-helpers';
import { createChatUpgradeHandler } from './chat.handler';

class Socket extends EventEmitter {
  readyState: number = WS_READY_STATE.OPEN;
  send = vi.fn();
  close = vi.fn();
}
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
afterEach(() => {
  for (const app of applications.splice(0)) {
    disposeChatTransportForApplication(app);
  }
  vi.restoreAllMocks();
});

function setup() {
  const ports = createChatRouterServices(sessionCommandFactories);
  const domain = new SessionDomainService();
  const hydrate = vi.fn(async (): Promise<void> => undefined);
  const capabilities = vi.fn(async () => EMPTY_CHAT_BAR_CAPABILITIES);
  const findSession = vi.fn(async (_sessionId: string) => ({
    provider: 'CODEX' as const,
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
      getChatBarCapabilities: capabilities,
      getSessionConfigOptionsWithFallback: async () => [
        { id: 'model', name: 'Model', type: 'select', currentValue: 'chosen', options: [] },
      ],
    },
    getCachedCommands: async () => [],
    tryDispatchNextMessage: ports.dispatch.tryDispatchNextMessage,
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
      },
    },
  });
  applications.push(app);
  const handler = createChatUpgradeHandler(app);
  const connect = (id: string) => {
    const ws = new Socket();
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
      new URL(`http://localhost/chat?connectionId=${id}&sessionId=s1`),
      wss,
      new WeakMap()
    );
    return ws;
  };
  return { app, domain, ports, hydrate, capabilities, findSession, connect };
}
function frames(ws: Socket) {
  return ws.send.mock.calls.map(([payload]) => JSON.parse(payload));
}

describe('load-session through the actual chat transport', () => {
  it('broadcasts replay/runtime before pending configuration and activates initial text after all load updates', async () => {
    const test = setup();
    const config = deferred<typeof EMPTY_CHAT_BAR_CAPABILITIES>();
    test.capabilities.mockReturnValue(config.promise);
    test.domain.storeInitialMessage('s1', 'Start once');
    const requester = test.connect('requester');
    const viewer = test.connect('viewer');
    requester.emit('message', JSON.stringify({ type: 'load_session', loadRequestId: 'load-1' }));
    await vi.waitFor(() => expect(requester.send).toHaveBeenCalledTimes(2));
    expect(frames(requester)).toEqual([
      {
        type: 'session_replay_batch',
        loadRequestId: 'load-1',
        replayEvents: [expect.objectContaining({ type: 'session_runtime_snapshot' })],
      },
      { type: 'session_delta', data: expect.objectContaining({ type: 'session_runtime_updated' }) },
    ]);
    expect(frames(viewer)).toEqual(frames(requester));
    expect(test.ports.startup.getOrCreateSessionClient).not.toHaveBeenCalled();
    expect(test.ports.dispatch.tryDispatchNextMessage).not.toHaveBeenCalled();
    config.resolve(EMPTY_CHAT_BAR_CAPABILITIES);
    await vi.waitFor(() =>
      expect(test.ports.dispatch.tryDispatchNextMessage).toHaveBeenCalledExactlyOnceWith('s1')
    );
    expect(
      frames(requester)
        .slice(2, 5)
        .map((frame) => frame.data.type)
    ).toEqual(['chat_capabilities', 'config_options_update', 'slash_commands']);
    expect(frames(viewer)).toEqual(frames(requester));
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
    await vi.waitFor(() =>
      expect(frames(requester).at(-1)).toMatchObject({
        type: 'session_delta',
        data: { type: 'slash_commands' },
      })
    );
    expect(test.ports.startup.getOrCreateSessionClient).not.toHaveBeenCalled();
    expect(test.ports.dispatch.tryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it('preserves hydration failure error copy and keeps it private to the requester', async () => {
    const test = setup();
    test.hydrate.mockRejectedValue(new Error('history unavailable'));
    const requester = test.connect('requester');
    const viewer = test.connect('viewer');
    requester.emit('message', JSON.stringify({ type: 'load_session', loadRequestId: 'failed' }));
    await vi.waitFor(() =>
      expect(frames(requester)).toEqual([{ type: 'error', message: 'Invalid message format' }])
    );
    expect(viewer.send).not.toHaveBeenCalled();
    expect(test.ports.dispatch.tryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it('delivers a missing-session error only to the requester', async () => {
    const test = setup();
    test.findSession.mockResolvedValue(unsafeCoerce(null));
    const requester = test.connect('requester');
    const viewer = test.connect('viewer');
    requester.emit('message', JSON.stringify({ type: 'load_session', loadRequestId: 'missing' }));
    await vi.waitFor(() =>
      expect(frames(requester)).toEqual([{ type: 'error', message: 'Session not found' }])
    );
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
    await vi.waitFor(() =>
      expect(test.ports.dispatch.tryDispatchNextMessage).toHaveBeenCalledExactlyOnceWith('s1')
    );
    expect(frames(viewer)[0]).toMatchObject({
      type: 'session_replay_batch',
      loadRequestId: 'disconnected',
    });
    expect(frames(viewer).at(-1)).toMatchObject({
      type: 'session_delta',
      data: { type: 'message_state_changed', newState: 'ACCEPTED' },
    });
    expect(test.domain.peekNextMessage('s1')?.text).toBe('Continue after disconnect');
  });

  it('retains disconnected state until failed hydration settles, then cleans up', async () => {
    const test = setup();
    const history = deferred<void>();
    test.hydrate.mockReturnValue(history.promise);
    const clear = vi.spyOn(test.domain, 'clearSession');
    const requester = test.connect('requester');
    requester.emit('message', JSON.stringify({ type: 'load_session' }));
    await vi.waitFor(() => expect(test.hydrate).toHaveBeenCalled());
    requester.readyState = WS_READY_STATE.CLOSED;
    requester.emit('close');
    expect(clear).not.toHaveBeenCalled();
    history.reject(new Error('history unavailable'));
    await vi.waitFor(() =>
      expect(clear).toHaveBeenCalledExactlyOnceWith('s1', { preserveRejections: true })
    );
    expect(requester.send).not.toHaveBeenCalled();
    expect(test.ports.dispatch.tryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it('correlates concurrent replay loads and consumes initial text only once', async () => {
    const test = setup();
    const firstConfig = deferred<typeof EMPTY_CHAT_BAR_CAPABILITIES>();
    test.capabilities.mockReturnValueOnce(firstConfig.promise);
    test.domain.storeInitialMessage('s1', 'Start once');
    const requester = test.connect('requester');
    requester.emit('message', JSON.stringify({ type: 'load_session', loadRequestId: 'first' }));
    await vi.waitFor(() => expect(test.capabilities).toHaveBeenCalledTimes(1));
    requester.emit('message', JSON.stringify({ type: 'load_session', loadRequestId: 'second' }));
    await vi.waitFor(() =>
      expect(test.ports.dispatch.tryDispatchNextMessage).toHaveBeenCalledTimes(1)
    );
    firstConfig.resolve(EMPTY_CHAT_BAR_CAPABILITIES);
    await vi.waitFor(() =>
      expect(
        frames(requester).filter((frame) => frame.data?.type === 'slash_commands')
      ).toHaveLength(2)
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
