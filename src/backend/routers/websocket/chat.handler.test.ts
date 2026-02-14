import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { createChatUpgradeHandler } from './chat.handler';

describe('createChatUpgradeHandler', () => {
  it('rejects invalid workingDir with 400 response before upgrade', () => {
    const chatMessageHandlerService = {
      setClientCreator: vi.fn(),
      tryDispatchNextMessage: vi.fn(),
      handleMessage: vi.fn(),
    };
    const sessionService = {
      getOrCreateClient: vi.fn(),
      getOrCreateSessionClient: vi.fn(),
      getSessionOptions: vi.fn(),
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const appContext = {
      services: {
        chatConnectionService: {
          values: vi.fn(() => []),
          get: vi.fn(),
          register: vi.fn(),
          unregister: vi.fn(),
        },
        chatEventForwarderService: {
          setupClientEvents: vi.fn(),
          setupWorkspaceNotifications: vi.fn(),
        },
        chatMessageHandlerService,
        configService: {
          getDebugConfig: vi.fn(() => ({ chatWebSocket: false })),
          getWorktreeBaseDir: vi.fn(),
        },
        createLogger: vi.fn(() => logger),
        sessionFileLogger: {
          initSession: vi.fn(),
          log: vi.fn(),
          closeSession: vi.fn(),
        },
        sessionService,
      },
    } as unknown as AppContext;

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
});
