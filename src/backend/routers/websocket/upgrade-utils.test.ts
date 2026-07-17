import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import {
  createWebSocketUpgradeHandler,
  validateTrustedLocalWebSocketRequest,
  validateWebSocketOrigin,
} from './upgrade-utils';

function createSocket() {
  return { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
}

function createLogger() {
  return { warn: vi.fn() };
}

function createConfigService(
  allowedOrigins: string[],
  trustedLocalCidrs: string[] = [],
  trustProxyHeaders = false
) {
  return {
    getCorsConfig: vi.fn(() => ({ allowedOrigins, trustedLocalCidrs, trustProxyHeaders })),
  };
}

describe('validateWebSocketOrigin', () => {
  it('rejects upgrades without an Origin header', () => {
    const socket = createSocket();
    const logger = createLogger();

    const isValid = validateWebSocketOrigin({
      request: { headers: {} } as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000']),
      logger,
      connectionName: 'terminal WebSocket',
    });

    expect(isValid).toBe(false);
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Missing Origin header'));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Rejected terminal WebSocket connection without Origin header'
    );
  });

  it('rejects upgrades from unauthorized origins', () => {
    const socket = createSocket();
    const logger = createLogger();

    const isValid = validateWebSocketOrigin({
      request: { headers: { origin: 'https://attacker.example' } } as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000']),
      logger,
      connectionName: 'chat WebSocket',
    });

    expect(isValid).toBe(false);
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Unauthorized origin'));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Rejected chat WebSocket connection from unauthorized origin',
      { origin: 'https://attacker.example' }
    );
  });

  it('allows upgrades from configured origins', () => {
    const socket = createSocket();

    const isValid = validateWebSocketOrigin({
      request: { headers: { origin: 'http://localhost:3000' } } as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000']),
      logger: createLogger(),
      connectionName: 'snapshots WebSocket',
    });

    expect(isValid).toBe(true);
    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('allows upgrades from equivalent loopback origins', () => {
    const socket = createSocket();

    const isValid = validateWebSocketOrigin({
      request: { headers: { origin: 'http://127.0.0.1:3000' } } as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000']),
      logger: createLogger(),
      connectionName: 'terminal WebSocket',
    });

    expect(isValid).toBe(true);
    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('rejects credentialed loopback origins', () => {
    const socket = createSocket();

    const isValid = validateWebSocketOrigin({
      request: { headers: { origin: 'http://evil@localhost:3000' } } as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000']),
      logger: createLogger(),
      connectionName: 'terminal WebSocket',
    });

    expect(isValid).toBe(false);
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Unauthorized origin'));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('validateTrustedLocalWebSocketRequest', () => {
  it('rejects untrusted remote addresses', () => {
    const socket = createSocket();
    const logger = createLogger();

    const isValid = validateTrustedLocalWebSocketRequest({
      request: {
        headers: {},
        socket: { remoteAddress: '203.0.113.10' },
      } as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000']),
      logger,
      connectionName: 'terminal WebSocket',
    });

    expect(isValid).toBe(false);
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Untrusted remote address'));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Rejected terminal WebSocket connection from untrusted remote address',
      { remoteAddress: '203.0.113.10' }
    );
  });

  it('rejects forwarded client address headers from trusted peer addresses', () => {
    const socket = createSocket();
    const logger = createLogger();

    const isValid = validateTrustedLocalWebSocketRequest({
      request: {
        headers: { 'x-forwarded-for': '203.0.113.10' },
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000']),
      logger,
      connectionName: 'terminal WebSocket',
    });

    expect(isValid).toBe(false);
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
    expect(socket.write).toHaveBeenCalledWith(
      expect.stringContaining('Forwarded WebSocket upgrades are not trusted')
    );
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Rejected terminal WebSocket connection with forwarded client address headers',
      {
        forwardedClientAddressHeaders: ['x-forwarded-for'],
        remoteAddress: '127.0.0.1',
      }
    );
  });

  it('allows forwarded client address headers when trustProxyHeaders is enabled', () => {
    const socket = createSocket();
    const logger = createLogger();

    const isValid = validateTrustedLocalWebSocketRequest({
      request: {
        headers: { 'x-forwarded-for': '203.0.113.10' },
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000'], [], true),
      logger,
      connectionName: 'terminal WebSocket',
    });

    expect(isValid).toBe(true);
    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('still rejects untrusted remote addresses when trustProxyHeaders is enabled', () => {
    const socket = createSocket();
    const logger = createLogger();

    const isValid = validateTrustedLocalWebSocketRequest({
      request: {
        headers: {},
        socket: { remoteAddress: '203.0.113.10' },
      } as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000'], [], true),
      logger,
      connectionName: 'terminal WebSocket',
    });

    expect(isValid).toBe(false);
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Untrusted remote address'));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Rejected terminal WebSocket connection from untrusted remote address',
      { remoteAddress: '203.0.113.10' }
    );
  });

  it('allows trusted local requests without forwarded client address headers', () => {
    const socket = createSocket();

    const isValid = validateTrustedLocalWebSocketRequest({
      request: {
        headers: {},
        socket: { remoteAddress: '172.17.0.1' },
      } as IncomingMessage,
      socket,
      configService: createConfigService(['http://localhost:3000'], ['172.17.0.1/32']),
      logger: createLogger(),
      connectionName: 'terminal WebSocket',
    });

    expect(isValid).toBe(true);
    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });
});

describe('createWebSocketUpgradeHandler', () => {
  function createFullLogger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  function createWss(ws: WebSocket = {} as WebSocket) {
    return {
      ws,
      wss: {
        handleUpgrade: vi.fn(
          (
            _request: IncomingMessage,
            _socket: Duplex,
            _head: Buffer,
            callback: (socket: WebSocket) => void
          ) => callback(ws)
        ),
      } as unknown as WebSocketServer,
    };
  }

  const trustedRequest = {
    headers: { origin: 'http://localhost:3000' },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;

  function invoke(
    handler: ReturnType<typeof createWebSocketUpgradeHandler>,
    {
      request = trustedRequest,
      socket = createSocket(),
      url = new URL('http://localhost/ws'),
      wss = createWss().wss,
      wsAliveMap = new WeakMap<WebSocket, boolean>(),
    }: {
      request?: IncomingMessage;
      socket?: Duplex;
      url?: URL;
      wss?: WebSocketServer;
      wsAliveMap?: WeakMap<WebSocket, boolean>;
    } = {}
  ) {
    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);
  }

  it('rejects unauthorized origins before upgrading', () => {
    const socket = createSocket();
    const onOpen = vi.fn();
    const { wss } = createWss();

    const handler = createWebSocketUpgradeHandler({
      connectionName: 'test WebSocket',
      configService: createConfigService(['http://localhost:3000']),
      logger: createFullLogger(),
      onOpen,
    });

    invoke(handler, {
      request: { headers: { origin: 'https://attacker.example' } } as IncomingMessage,
      socket,
      wss,
    });

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Unauthorized origin'));
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('rejects untrusted remote addresses before upgrading', () => {
    const socket = createSocket();
    const onOpen = vi.fn();
    const { wss } = createWss();

    const handler = createWebSocketUpgradeHandler({
      connectionName: 'test WebSocket',
      configService: createConfigService(['http://localhost:3000']),
      logger: createFullLogger(),
      onOpen,
    });

    invoke(handler, {
      request: {
        headers: { origin: 'http://localhost:3000' },
        socket: { remoteAddress: '203.0.113.10' },
      } as unknown as IncomingMessage,
      socket,
      wss,
    });

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('rejects upgrades missing a required query param', () => {
    const socket = createSocket();
    const logger = createFullLogger();
    const onOpen = vi.fn();
    const { wss } = createWss();

    const handler = createWebSocketUpgradeHandler({
      connectionName: 'test WebSocket',
      configService: createConfigService(['http://localhost:3000']),
      logger,
      requiredParams: ['workspaceId'],
      onOpen,
    });

    invoke(handler, { socket, wss });

    expect(logger.warn).toHaveBeenCalledWith('test WebSocket missing workspaceId');
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('400 Bad Request'));
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('upgrades, marks the socket alive, and passes params to onOpen', () => {
    const onOpen = vi.fn();
    const ws = { on: vi.fn() } as unknown as WebSocket;
    const { wss } = createWss(ws);
    const wsAliveMap = new WeakMap<WebSocket, boolean>();

    const handler = createWebSocketUpgradeHandler({
      connectionName: 'test WebSocket',
      configService: createConfigService(['http://localhost:3000']),
      logger: createFullLogger(),
      requiredParams: ['workspaceId'],
      onOpen,
    });

    invoke(handler, {
      url: new URL('http://localhost/ws?workspaceId=workspace-1'),
      wss,
      wsAliveMap,
    });

    expect(wsAliveMap.get(ws)).toBe(true);
    expect(onOpen).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({ params: { workspaceId: 'workspace-1' }, auth: undefined })
    );
  });

  it('does not upgrade when authorize resolves null', async () => {
    const onOpen = vi.fn();
    const { wss } = createWss();

    const handler = createWebSocketUpgradeHandler({
      connectionName: 'test WebSocket',
      configService: createConfigService(['http://localhost:3000']),
      logger: createFullLogger(),
      authorize: () => Promise.resolve(null),
      onOpen,
    });

    invoke(handler, { wss });
    await vi.waitFor(() => {
      expect(onOpen).not.toHaveBeenCalled();
    });

    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('passes the resolved authorize value to onOpen', async () => {
    const onOpen = vi.fn();
    const ws = { on: vi.fn() } as unknown as WebSocket;
    const { wss } = createWss(ws);

    const handler = createWebSocketUpgradeHandler({
      connectionName: 'test WebSocket',
      configService: createConfigService(['http://localhost:3000']),
      logger: createFullLogger(),
      authorize: async () => ({ workingDir: '/tmp/worktree' }),
      onOpen,
    });

    invoke(handler, { wss });

    await vi.waitFor(() => {
      expect(onOpen).toHaveBeenCalledWith(
        ws,
        expect.objectContaining({ auth: { workingDir: '/tmp/worktree' } })
      );
    });
  });

  it('upgrades synchronously when authorize returns a plain value', () => {
    const onOpen = vi.fn();
    const ws = { on: vi.fn() } as unknown as WebSocket;
    const { wss } = createWss(ws);

    const handler = createWebSocketUpgradeHandler({
      connectionName: 'test WebSocket',
      configService: createConfigService(['http://localhost:3000']),
      logger: createFullLogger(),
      authorize: () => ({ connectionId: 'conn-1' }),
      onOpen,
    });

    invoke(handler, { wss });

    expect(onOpen).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({ auth: { connectionId: 'conn-1' } })
    );
  });

  it('rejects synchronously when authorize returns a plain null', () => {
    const onOpen = vi.fn();
    const { wss } = createWss();

    const handler = createWebSocketUpgradeHandler({
      connectionName: 'test WebSocket',
      configService: createConfigService(['http://localhost:3000']),
      logger: createFullLogger(),
      authorize: () => null,
      onOpen,
    });

    invoke(handler, { wss });

    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('fails closed when authorize returns undefined', async () => {
    const socket = createSocket();
    const logger = createFullLogger();
    const onOpen = vi.fn();
    const { wss } = createWss();

    const handler = createWebSocketUpgradeHandler({
      connectionName: 'test WebSocket',
      configService: createConfigService(['http://localhost:3000']),
      logger,
      authorize: async () => undefined as unknown as null,
      onOpen,
    });

    invoke(handler, { socket, wss });

    await vi.waitFor(() => {
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Authorization failed'));
    });
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to authorize test WebSocket upgrade',
      expect.objectContaining({ message: 'authorize hook returned undefined' })
    );
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('rejects hooks that can return undefined at the type level', () => {
    // Compile-time contract check (verified by `pnpm typecheck`): the
    // NonNullable return type rejects hooks with undefined-returning paths.
    const defineHandler = () =>
      createWebSocketUpgradeHandler({
        connectionName: 'test WebSocket',
        configService: createConfigService(['http://localhost:3000']),
        logger: createFullLogger(),
        // @ts-expect-error authorize must not be able to return undefined
        authorize: async () => (Math.random() > 0.5 ? { id: 'a' } : undefined),
        onOpen: vi.fn(),
      });

    expect(defineHandler).toBeDefined();
  });

  it('rejects with 400 when a synchronous authorize throws', () => {
    const socket = createSocket();
    const logger = createFullLogger();
    const onOpen = vi.fn();
    const { wss } = createWss();

    const handler = createWebSocketUpgradeHandler({
      connectionName: 'test WebSocket',
      configService: createConfigService(['http://localhost:3000']),
      logger,
      authorize: () => {
        throw new Error('bad state');
      },
      onOpen,
    });

    invoke(handler, { socket, wss });

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Authorization failed'));
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('rejects with 400 when authorize throws', async () => {
    const socket = createSocket();
    const logger = createFullLogger();
    const onOpen = vi.fn();
    const { wss } = createWss();

    const handler = createWebSocketUpgradeHandler({
      connectionName: 'test WebSocket',
      configService: createConfigService(['http://localhost:3000']),
      logger,
      authorize: () => Promise.reject(new Error('db down')),
      onOpen,
    });

    invoke(handler, { socket, wss });

    await vi.waitFor(() => {
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Authorization failed'));
    });
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to authorize test WebSocket upgrade',
      expect.any(Error)
    );
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
