import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import {
  createWebSocketUpgradeHandler,
  trackConnection,
  validateTrustedLocalWebSocketRequest,
  validateWebSocketOrigin,
} from './upgrade-utils';

function createSocket() {
  return { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
}

function createLogger() {
  return { warn: vi.fn() };
}

function createConfigService(allowedOrigins: string[], trustedLocalCidrs: string[] = []) {
  return {
    getCorsConfig: vi.fn(() => ({ allowedOrigins, trustedLocalCidrs })),
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

describe('trackConnection', () => {
  const wsA = {} as WebSocket;
  const wsB = {} as WebSocket;

  it('adds the socket to the connection set for the key', () => {
    const map = new Map<string, Set<WebSocket>>();

    trackConnection(map, 'workspace-1', wsA);

    expect(map.get('workspace-1')).toEqual(new Set([wsA]));
  });

  it('removes the socket and drops the empty key on dispose', () => {
    const map = new Map<string, Set<WebSocket>>();
    const onEmpty = vi.fn();

    const untrack = trackConnection(map, 'workspace-1', wsA, onEmpty);
    untrack();

    expect(map.has('workspace-1')).toBe(false);
    expect(onEmpty).toHaveBeenCalledTimes(1);
  });

  it('keeps the key while other sockets remain', () => {
    const map = new Map<string, Set<WebSocket>>();
    const onEmpty = vi.fn();

    const untrackA = trackConnection(map, 'workspace-1', wsA, onEmpty);
    trackConnection(map, 'workspace-1', wsB, onEmpty);
    untrackA();

    expect(map.get('workspace-1')).toEqual(new Set([wsB]));
    expect(onEmpty).not.toHaveBeenCalled();
  });

  it('is safe to dispose twice', () => {
    const map = new Map<string, Set<WebSocket>>();
    const onEmpty = vi.fn();

    const untrack = trackConnection(map, 'workspace-1', wsA, onEmpty);
    untrack();
    untrack();

    expect(map.has('workspace-1')).toBe(false);
    expect(onEmpty).toHaveBeenCalledTimes(1);
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
