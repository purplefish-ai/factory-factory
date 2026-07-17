import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { SessionEventBus, sessionEventBus } from '@/backend/services/session';
import { createChatUpgradeHandler } from './chat.handler';
import {
  type ChatConnectionRegistry,
  disposeChatTransportForApplication,
  getChatConnectionRegistryForApplication,
} from './chat-connection-registry';

const allowedOrigin = 'http://localhost:3000';
const testApplications = new Set<AppContext>();
let chatConnectionRegistry: ChatConnectionRegistry;

class MockWebSocket extends EventEmitter {
  readyState = WS_READY_STATE.OPEN;
  send = vi.fn();
  close = vi.fn();
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createTestContext(worktreeBaseDir: string, eventBus: SessionEventBus = sessionEventBus) {
  const logger = createLogger();

  const appContext = {
    services: {
      chatEventForwarderService: {
        setupClientEvents: vi.fn(),
        setupWorkspaceNotifications: vi.fn(),
      },
      chatMessageHandlerService: {
        setClientCreator: vi.fn(),
        tryDispatchNextMessage: vi.fn(),
        handleMessage: vi.fn(async () => undefined),
      },
      configService: {
        getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin] })),
        getDebugConfig: vi.fn(() => ({ chatWebSocket: false })),
        getWorktreeBaseDir: vi.fn(() => worktreeBaseDir),
      },
      createLogger: vi.fn(() => logger),
      sessionFileLogger: {
        initSession: vi.fn(),
        log: vi.fn(),
        closeSession: vi.fn(),
      },
      sessionEventBus: eventBus,
      sessionService: {
        getOrCreateClient: vi.fn(),
        getOrCreateSessionClient: vi.fn(async () => ({})),
        getSessionOptions: vi.fn(),
        isSessionRunning: vi.fn(() => false),
      },
      sessionDomainService: {
        clearSession: vi.fn(),
      },
    },
  } as unknown as AppContext;
  testApplications.add(appContext);
  chatConnectionRegistry = getChatConnectionRegistryForApplication(appContext);

  return {
    appContext,
    chatMessageHandlerService: appContext.services.chatMessageHandlerService,
    chatEventForwarderService: appContext.services.chatEventForwarderService,
    logger,
    sessionFileLogger: appContext.services.sessionFileLogger,
    sessionDomainService: appContext.services.sessionDomainService,
    sessionService: appContext.services.sessionService,
  };
}

describe('createChatUpgradeHandler', () => {
  let tempRootDir: string;

  beforeEach(() => {
    tempRootDir = mkdtempSync(join(tmpdir(), 'chat-handler-test-'));
  });

  afterEach(() => {
    for (const application of testApplications) {
      disposeChatTransportForApplication(application);
    }
    testApplications.clear();
    vi.restoreAllMocks();
  });

  it('rejects invalid workingDir with 400 response before upgrade', () => {
    const { appContext, chatMessageHandlerService } = createTestContext(tempRootDir);
    const handler = createChatUpgradeHandler(appContext);

    const request = {
      headers: { origin: allowedOrigin },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wss = { handleUpgrade: vi.fn() } as unknown as WebSocketServer;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();
    const url = new URL('http://localhost/chat?workingDir=../outside');

    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('400 Bad Request'));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(chatMessageHandlerService.setClientCreator).toHaveBeenCalledTimes(1);
  });

  it('rejects unauthorized origins before validating workingDir', () => {
    const workingDir = join(tempRootDir, 'workspace-1');
    mkdirSync(workingDir, { recursive: true });

    const { appContext } = createTestContext(tempRootDir);
    const handler = createChatUpgradeHandler(appContext);

    const request = { headers: { origin: 'https://evil.example' } } as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wss = { handleUpgrade: vi.fn() } as unknown as WebSocketServer;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();
    const url = new URL(`http://localhost/chat?workingDir=${encodeURIComponent(workingDir)}`);

    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Unauthorized origin'));
    expect(appContext.services.configService.getWorktreeBaseDir).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('rejects untrusted remote addresses before opening a WebSocket', () => {
    const { appContext } = createTestContext(tempRootDir);
    const handler = createChatUpgradeHandler(appContext);

    const request = {
      headers: { origin: allowedOrigin },
      socket: { remoteAddress: '203.0.113.10' },
    } as unknown as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wss = { handleUpgrade: vi.fn() } as unknown as WebSocketServer;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();
    const url = new URL('http://localhost/chat');

    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Untrusted remote address'));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('rejects forwarded local upgrades before opening a WebSocket', () => {
    const { appContext } = createTestContext(tempRootDir);
    const handler = createChatUpgradeHandler(appContext);

    const request = {
      headers: { origin: allowedOrigin, 'x-forwarded-for': '203.0.113.10' },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wss = { handleUpgrade: vi.fn() } as unknown as WebSocketServer;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();
    const url = new URL('http://localhost/chat');

    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
    expect(socket.write).toHaveBeenCalledWith(
      expect.stringContaining('Forwarded WebSocket upgrades are not trusted')
    );
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('registers a connection, dispatches valid messages, and cleans up on close', async () => {
    const workingDir = join(tempRootDir, 'workspace-1');
    mkdirSync(workingDir, { recursive: true });

    const { appContext, chatMessageHandlerService, chatEventForwarderService, sessionFileLogger } =
      createTestContext(tempRootDir);
    const handler = createChatUpgradeHandler(appContext);

    const ws = new MockWebSocket();
    const wss = {
      handleUpgrade: vi.fn(
        (
          _request: IncomingMessage,
          _socket: Duplex,
          _head: Buffer,
          callback: (socket: WebSocket) => void
        ) => callback(ws as unknown as WebSocket)
      ),
    } as unknown as WebSocketServer;

    const request = {
      headers: { origin: allowedOrigin },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();
    const url = new URL(
      `http://localhost/chat?connectionId=conn-1&sessionId=session-1&workingDir=${encodeURIComponent(workingDir)}`
    );

    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);
    expect(chatEventForwarderService.setupWorkspaceNotifications).toHaveBeenCalledTimes(1);
    expect(sessionFileLogger.initSession).toHaveBeenCalledWith('session-1');
    expect(chatConnectionRegistry.get('conn-1')).toMatchObject({ dbSessionId: 'session-1' });
    expect(chatConnectionRegistry.countViewers('session-1')).toBe(1);

    ws.emit('message', JSON.stringify({ type: 'load_session' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(chatMessageHandlerService.handleMessage).toHaveBeenCalledWith(
      ws,
      'session-1',
      realpathSync(workingDir),
      { type: 'load_session' }
    );
    expect(sessionFileLogger.log).toHaveBeenCalledWith('session-1', 'IN_FROM_CLIENT', {
      type: 'load_session',
    });

    ws.emit('close');
    expect(chatConnectionRegistry.has('conn-1')).toBe(false);
    expect(chatConnectionRegistry.countViewers('session-1')).toBe(0);
    expect(sessionFileLogger.closeSession).toHaveBeenCalledWith('session-1');
  });

  it('keeps chat transport dependencies scoped to each application', () => {
    const eventBusA = new SessionEventBus();
    const eventBusB = new SessionEventBus();
    const contextA = createTestContext(tempRootDir, eventBusA);
    const contextB = createTestContext(tempRootDir, eventBusB);
    const handlerA = createChatUpgradeHandler(contextA.appContext);
    const handlerB = createChatUpgradeHandler(contextB.appContext);
    const wsA = new MockWebSocket();
    const wsB = new MockWebSocket();

    const open = (
      handler: ReturnType<typeof createChatUpgradeHandler>,
      ws: MockWebSocket,
      connectionId: string,
      sessionId: string
    ) => {
      const wss = {
        handleUpgrade: vi.fn(
          (
            _request: IncomingMessage,
            _socket: Duplex,
            _head: Buffer,
            callback: (socket: WebSocket) => void
          ) => callback(ws as unknown as WebSocket)
        ),
      } as unknown as WebSocketServer;
      handler(
        {
          headers: { origin: allowedOrigin },
          socket: { remoteAddress: '127.0.0.1' },
        } as unknown as IncomingMessage,
        { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex,
        Buffer.alloc(0),
        new URL(`http://localhost/chat?connectionId=${connectionId}&sessionId=${sessionId}`),
        wss,
        new WeakMap<WebSocket, boolean>()
      );
    };

    open(handlerA, wsA, 'conn-a', 'session-a');
    open(handlerB, wsB, 'conn-b', 'session-b');
    wsA.send.mockClear();
    wsB.send.mockClear();

    eventBusB.publishToSession('session-b', {
      type: 'session_delta',
      data: {
        type: 'assistant_text_delta',
        messageId: 'message-b',
        order: 1,
        offset: 0,
        text: 'from-b',
      },
    });

    expect(wsB.send).toHaveBeenCalledTimes(1);
    expect(wsA.send).not.toHaveBeenCalled();
    expect(contextB.sessionFileLogger.log).toHaveBeenCalledWith(
      'session-b',
      'OUT_TO_CLIENT',
      expect.objectContaining({ type: 'session_delta' })
    );
    expect(contextA.sessionFileLogger.log).not.toHaveBeenCalledWith(
      'session-b',
      'OUT_TO_CLIENT',
      expect.anything()
    );
  });

  it('clears in-memory state when the last viewer disconnects from a stopped session', () => {
    const { appContext, sessionDomainService, sessionService } = createTestContext(tempRootDir);
    const handler = createChatUpgradeHandler(appContext);
    vi.mocked(sessionService.isSessionRunning).mockReturnValue(false);

    const ws = new MockWebSocket();
    const wss = {
      handleUpgrade: vi.fn(
        (
          _request: IncomingMessage,
          _socket: Duplex,
          _head: Buffer,
          callback: (socket: WebSocket) => void
        ) => callback(ws as unknown as WebSocket)
      ),
    } as unknown as WebSocketServer;

    const request = {
      headers: { origin: allowedOrigin },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();
    const url = new URL('http://localhost/chat?connectionId=conn-1&sessionId=session-1');

    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);
    expect(chatConnectionRegistry.get('conn-1')).toMatchObject({ dbSessionId: 'session-1' });

    ws.emit('close');

    expect(sessionDomainService.clearSession).toHaveBeenCalledWith('session-1');
  });

  it('does not clear in-memory state when the disconnected session is still running', () => {
    const { appContext, sessionDomainService, sessionService } = createTestContext(tempRootDir);
    const handler = createChatUpgradeHandler(appContext);
    vi.mocked(sessionService.isSessionRunning).mockReturnValue(true);

    const ws = new MockWebSocket();
    const wss = {
      handleUpgrade: vi.fn(
        (
          _request: IncomingMessage,
          _socket: Duplex,
          _head: Buffer,
          callback: (socket: WebSocket) => void
        ) => callback(ws as unknown as WebSocket)
      ),
    } as unknown as WebSocketServer;

    const request = {
      headers: { origin: allowedOrigin },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();
    const url = new URL('http://localhost/chat?connectionId=conn-1&sessionId=session-1');

    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);
    ws.emit('close');

    expect(sessionDomainService.clearSession).not.toHaveBeenCalled();
  });

  it('waits for in-flight message handling before clearing disconnected session state', async () => {
    const { appContext, chatMessageHandlerService, sessionDomainService, sessionService } =
      createTestContext(tempRootDir);
    const handler = createChatUpgradeHandler(appContext);
    vi.mocked(sessionService.isSessionRunning).mockReturnValue(false);

    let releaseMessage: (() => void) | undefined;
    const messageHandled = new Promise<void>((resolve) => {
      releaseMessage = resolve;
    });
    vi.mocked(chatMessageHandlerService.handleMessage).mockImplementation(async () => {
      await messageHandled;
    });

    const ws = new MockWebSocket();
    const wss = {
      handleUpgrade: vi.fn(
        (
          _request: IncomingMessage,
          _socket: Duplex,
          _head: Buffer,
          callback: (socket: WebSocket) => void
        ) => callback(ws as unknown as WebSocket)
      ),
    } as unknown as WebSocketServer;

    const request = {
      headers: { origin: allowedOrigin },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();
    const url = new URL('http://localhost/chat?connectionId=conn-1&sessionId=session-1');

    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);

    ws.emit('message', JSON.stringify({ type: 'load_session' }));
    await Promise.resolve();

    ws.emit('close');
    expect(sessionDomainService.clearSession).not.toHaveBeenCalled();

    if (!releaseMessage) {
      throw new Error('Expected message release callback');
    }
    releaseMessage();
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionDomainService.clearSession).toHaveBeenCalledWith('session-1');
  });

  it('replaces existing connection with the same id and avoids unregister race on stale close', () => {
    const { appContext, chatMessageHandlerService, sessionFileLogger } =
      createTestContext(tempRootDir);
    const handler = createChatUpgradeHandler(appContext);

    const existingWs = new MockWebSocket();
    chatConnectionRegistry.register('conn-1', {
      ws: existingWs as unknown as WebSocket,
      dbSessionId: 'old',
      workingDir: null,
    });

    const ws = new MockWebSocket();
    const newerWs = new MockWebSocket();
    const wss = {
      handleUpgrade: vi.fn(
        (
          _request: IncomingMessage,
          _socket: Duplex,
          _head: Buffer,
          callback: (socket: WebSocket) => void
        ) => callback(ws as unknown as WebSocket)
      ),
    } as unknown as WebSocketServer;

    const request = {
      headers: { origin: allowedOrigin },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();
    const url = new URL('http://localhost/chat?connectionId=conn-1&sessionId=session-1');

    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);

    expect(existingWs.close).toHaveBeenCalledWith(1000, 'New connection replacing old one');
    expect(chatConnectionRegistry.get('conn-1')?.ws).toBe(ws as unknown as WebSocket);
    expect(chatConnectionRegistry.countViewers('old')).toBe(0);
    expect(chatMessageHandlerService.setClientCreator).toHaveBeenCalledTimes(1);

    // Simulate a newer connection replacing this one before close event fires.
    chatConnectionRegistry.register('conn-1', {
      ws: newerWs as unknown as WebSocket,
      dbSessionId: 'session-1',
      workingDir: null,
    });
    ws.emit('close');

    expect(chatConnectionRegistry.get('conn-1')?.ws).toBe(newerWs as unknown as WebSocket);
    expect(sessionFileLogger.closeSession).not.toHaveBeenCalled();
  });

  it('sends chat errors for invalid JSON/schema messages and logs websocket errors', async () => {
    const { appContext, chatMessageHandlerService, sessionFileLogger, logger } =
      createTestContext(tempRootDir);
    const handler = createChatUpgradeHandler(appContext);

    const ws = new MockWebSocket();
    const wss = {
      handleUpgrade: vi.fn(
        (
          _request: IncomingMessage,
          _socket: Duplex,
          _head: Buffer,
          callback: (socket: WebSocket) => void
        ) => callback(ws as unknown as WebSocket)
      ),
    } as unknown as WebSocketServer;

    const request = {
      headers: { origin: allowedOrigin },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();
    const url = new URL('http://localhost/chat?connectionId=conn-1&sessionId=session-1');

    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);

    ws.emit('message', '{invalid-json');
    await Promise.resolve();
    await Promise.resolve();

    ws.emit('message', JSON.stringify({ type: 'unknown_message_type' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(chatMessageHandlerService.handleMessage).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Invalid message format' })
    );
    expect(sessionFileLogger.log).toHaveBeenCalledWith('session-1', 'OUT_TO_CLIENT', {
      type: 'error',
      message: 'Invalid message format',
    });

    ws.emit('error', new Error('socket failed'));
    expect(logger.error).toHaveBeenCalledWith('Chat WebSocket error', expect.any(Error));
    expect(sessionFileLogger.log).toHaveBeenCalledWith('session-1', 'INFO', {
      event: 'connection_error',
      connectionId: 'conn-1',
      error: 'socket failed',
    });
  });
});
