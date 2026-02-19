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
import { createChatUpgradeHandler } from './chat.handler';

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

function createTestContext(worktreeBaseDir: string) {
  const logger = createLogger();
  const connections = new Map<
    string,
    { ws: MockWebSocket; dbSessionId: string | null; workingDir: string | null }
  >();

  const chatConnectionService = {
    values: vi.fn(() => connections.values()),
    get: vi.fn((connectionId: string) => connections.get(connectionId)),
    register: vi.fn(
      (
        connectionId: string,
        info: { ws: MockWebSocket; dbSessionId: string | null; workingDir: string | null }
      ) => {
        connections.set(connectionId, info);
      }
    ),
    unregister: vi.fn((connectionId: string) => {
      connections.delete(connectionId);
    }),
  };

  const appContext = {
    services: {
      chatConnectionService,
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
        getDebugConfig: vi.fn(() => ({ chatWebSocket: false })),
        getWorktreeBaseDir: vi.fn(() => worktreeBaseDir),
      },
      createLogger: vi.fn(() => logger),
      sessionFileLogger: {
        initSession: vi.fn(),
        log: vi.fn(),
        closeSession: vi.fn(),
      },
      sessionService: {
        getOrCreateClient: vi.fn(),
        getOrCreateSessionClient: vi.fn(async () => ({})),
        getSessionOptions: vi.fn(),
      },
    },
  } as unknown as AppContext;

  return {
    appContext,
    chatConnectionService,
    chatMessageHandlerService: appContext.services.chatMessageHandlerService,
    chatEventForwarderService: appContext.services.chatEventForwarderService,
    logger,
    sessionFileLogger: appContext.services.sessionFileLogger,
    connections,
  };
}

describe('createChatUpgradeHandler', () => {
  let tempRootDir: string;

  beforeEach(() => {
    tempRootDir = mkdtempSync(join(tmpdir(), 'chat-handler-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects invalid workingDir with 400 response before upgrade', () => {
    const { appContext, chatMessageHandlerService } = createTestContext(tempRootDir);
    const handler = createChatUpgradeHandler(appContext);

    const request = {} as IncomingMessage;
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

  it('registers a connection, dispatches valid messages, and cleans up on close', async () => {
    const workingDir = join(tempRootDir, 'workspace-1');
    mkdirSync(workingDir, { recursive: true });

    const {
      appContext,
      chatMessageHandlerService,
      chatEventForwarderService,
      chatConnectionService,
      sessionFileLogger,
    } = createTestContext(tempRootDir);
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

    const request = {} as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();
    const url = new URL(
      `http://localhost/chat?connectionId=conn-1&sessionId=session-1&workingDir=${encodeURIComponent(workingDir)}`
    );

    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);
    expect(chatEventForwarderService.setupWorkspaceNotifications).toHaveBeenCalledTimes(1);
    expect(sessionFileLogger.initSession).toHaveBeenCalledWith('session-1');
    expect(chatConnectionService.register).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({ dbSessionId: 'session-1' })
    );

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
    expect(chatConnectionService.unregister).toHaveBeenCalledWith('conn-1');
    expect(sessionFileLogger.closeSession).toHaveBeenCalledWith('session-1');
  });

  it('replaces existing connection with the same id and avoids unregister race on stale close', () => {
    const {
      appContext,
      connections,
      chatConnectionService,
      chatMessageHandlerService,
      sessionFileLogger,
    } = createTestContext(tempRootDir);
    const handler = createChatUpgradeHandler(appContext);

    const existingWs = new MockWebSocket();
    connections.set('conn-1', { ws: existingWs, dbSessionId: 'old', workingDir: null });

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

    const request = {} as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();
    const url = new URL('http://localhost/chat?connectionId=conn-1&sessionId=session-1');

    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);

    expect(existingWs.close).toHaveBeenCalledWith(1000, 'New connection replacing old one');
    expect(chatConnectionService.register).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({ ws })
    );
    expect(chatMessageHandlerService.setClientCreator).toHaveBeenCalledTimes(1);

    // Simulate a newer connection replacing this one before close event fires.
    connections.set('conn-1', { ws: newerWs, dbSessionId: 'session-1', workingDir: null });
    ws.emit('close');

    expect(chatConnectionService.unregister).not.toHaveBeenCalled();
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

    const request = {} as IncomingMessage;
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
