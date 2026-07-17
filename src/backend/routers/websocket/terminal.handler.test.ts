import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { MAX_WEBSOCKET_STREAM_BUFFERED_BYTES } from '@/backend/lib/websocket-send';
import { sessionDataService } from '@/backend/services/session';
import { workspaceDataService } from '@/backend/services/workspace';
import { createTerminalUpgradeHandler, terminalConnections } from './terminal.handler';

const allowedOrigin = 'http://localhost:3000';
const mockClearTerminalPid = vi.fn();

type MockTerminalDescriptor = {
  id: string;
  createdAt: Date;
  outputBuffer: string;
};

vi.mock('@/backend/services/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/services/session')>();
  return {
    ...actual,
    sessionDataService: {
      ...actual.sessionDataService,
      clearTerminalPid: (...args: unknown[]) => mockClearTerminalPid(...args),
      createTerminalSession: vi.fn(),
    },
  };
});

vi.mock('@/backend/services/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/services/workspace')>();
  return {
    ...actual,
    workspaceDataService: {
      ...actual.workspaceDataService,
      findById: vi.fn(),
    },
  };
});

class MockWebSocket extends EventEmitter {
  readyState = WS_READY_STATE.OPEN;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn();
  terminate = vi.fn();
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createTerminalService() {
  const outputListeners = new Map<string, Set<(output: string) => void>>();
  const exitListeners = new Map<string, Set<(exitCode: number) => void>>();

  const terminalService = {
    getTerminalsForWorkspace: vi.fn(() => [] as MockTerminalDescriptor[]),
    getTerminal: vi.fn(() => null as { outputBuffer: string } | null),
    onOutput: vi.fn((id: string, callback: (output: string) => void) => {
      const listeners = outputListeners.get(id) ?? new Set();
      listeners.add(callback);
      outputListeners.set(id, listeners);
      return () => listeners.delete(callback);
    }),
    onExit: vi.fn((id: string, callback: (exitCode: number) => void) => {
      const listeners = exitListeners.get(id) ?? new Set();
      listeners.add(callback);
      exitListeners.set(id, listeners);
      return () => listeners.delete(callback);
    }),
    createTerminal: vi.fn(async () => ({ terminalId: 'terminal-1', pid: 4321 })),
    writeToTerminal: vi.fn(() => true),
    resizeTerminal: vi.fn(),
    destroyTerminal: vi.fn(),
    setActiveTerminal: vi.fn(),
  };

  return {
    terminalService,
    outputListeners,
    exitListeners,
  };
}

function createWss(ws: MockWebSocket) {
  return {
    handleUpgrade: vi.fn(
      (
        _request: IncomingMessage,
        _socket: Duplex,
        _head: Buffer,
        callback: (socket: WebSocket) => void
      ) => callback(ws as unknown as WebSocket)
    ),
  } as unknown as WebSocketServer;
}

function createRequest(
  origin = allowedOrigin,
  remoteAddress = '127.0.0.1',
  headers: Record<string, string> = {}
) {
  return {
    headers: { origin, ...headers },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

describe('createTerminalUpgradeHandler', () => {
  beforeEach(() => {
    terminalConnections.clear();
    vi.clearAllMocks();
    mockClearTerminalPid.mockResolvedValue(undefined);
    vi.mocked(workspaceDataService.findById).mockResolvedValue({
      id: 'workspace-1',
      worktreePath: '/tmp/worktree',
    } as never);
  });

  it('rejects upgrades without workspaceId', () => {
    const { terminalService } = createTerminalService();
    const logger = createLogger();
    const appContext = {
      services: {
        sessionDataService,
        terminalService,
        workspaceDataService,
        configService: {
          getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin] })),
        },
        createLogger: vi.fn(() => logger),
      },
    } as unknown as AppContext;
    const handler = createTerminalUpgradeHandler(appContext);

    const request = createRequest();
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wss = { handleUpgrade: vi.fn() } as unknown as WebSocketServer;

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL('http://localhost/terminal'),
      wss,
      new WeakMap<WebSocket, boolean>()
    );

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('400 Bad Request'));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('rejects unauthorized origins before checking workspaceId', () => {
    const { terminalService } = createTerminalService();
    const logger = createLogger();
    const appContext = {
      services: {
        sessionDataService,
        terminalService,
        workspaceDataService,
        configService: {
          getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin] })),
        },
        createLogger: vi.fn(() => logger),
      },
    } as unknown as AppContext;
    const handler = createTerminalUpgradeHandler(appContext);

    const request = createRequest('https://attacker.example');
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wss = { handleUpgrade: vi.fn() } as unknown as WebSocketServer;

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL('http://localhost/terminal'),
      wss,
      new WeakMap<WebSocket, boolean>()
    );

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Unauthorized origin'));
    expect(logger.warn).not.toHaveBeenCalledWith('Terminal WebSocket missing workspaceId');
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('rejects untrusted remote addresses before opening a WebSocket', () => {
    const { terminalService } = createTerminalService();
    const logger = createLogger();
    const appContext = {
      services: {
        sessionDataService,
        terminalService,
        workspaceDataService,
        configService: {
          getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin], trustedLocalCidrs: [] })),
        },
        createLogger: vi.fn(() => logger),
      },
    } as unknown as AppContext;
    const handler = createTerminalUpgradeHandler(appContext);

    const request = createRequest(allowedOrigin, '203.0.113.10');
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wss = { handleUpgrade: vi.fn() } as unknown as WebSocketServer;

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL('http://localhost/terminal?workspaceId=workspace-1'),
      wss,
      new WeakMap<WebSocket, boolean>()
    );

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Untrusted remote address'));
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(terminalService.getTerminalsForWorkspace).not.toHaveBeenCalled();
  });

  it('rejects forwarded local upgrades before replaying terminal buffers', () => {
    const { terminalService } = createTerminalService();
    terminalService.getTerminalsForWorkspace.mockReturnValue([
      {
        id: 'terminal-1',
        createdAt: new Date('2026-02-11T00:00:00.000Z'),
        outputBuffer: 'secret output',
      },
    ]);
    const logger = createLogger();
    const appContext = {
      services: {
        sessionDataService,
        terminalService,
        workspaceDataService,
        configService: {
          getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin], trustedLocalCidrs: [] })),
        },
        createLogger: vi.fn(() => logger),
      },
    } as unknown as AppContext;
    const handler = createTerminalUpgradeHandler(appContext);

    const request = createRequest(allowedOrigin, '127.0.0.1', {
      'x-forwarded-for': '203.0.113.10',
    });
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wss = { handleUpgrade: vi.fn() } as unknown as WebSocketServer;

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL('http://localhost/terminal?workspaceId=workspace-1'),
      wss,
      new WeakMap<WebSocket, boolean>()
    );

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
    expect(socket.write).toHaveBeenCalledWith(
      expect.stringContaining('Forwarded WebSocket upgrades are not trusted')
    );
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(workspaceDataService.findById).not.toHaveBeenCalled();
    expect(terminalService.getTerminalsForWorkspace).not.toHaveBeenCalled();
  });

  it('rejects unknown workspaces before replaying terminal buffers', async () => {
    vi.mocked(workspaceDataService.findById).mockResolvedValue(null as never);
    const { terminalService } = createTerminalService();
    terminalService.getTerminalsForWorkspace.mockReturnValue([
      {
        id: 'terminal-1',
        createdAt: new Date('2026-02-11T00:00:00.000Z'),
        outputBuffer: 'secret output',
      },
    ]);
    const logger = createLogger();
    const appContext = {
      services: {
        sessionDataService,
        terminalService,
        workspaceDataService,
        configService: {
          getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin], trustedLocalCidrs: [] })),
        },
        createLogger: vi.fn(() => logger),
      },
    } as unknown as AppContext;
    const handler = createTerminalUpgradeHandler(appContext);

    const request = createRequest();
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wss = { handleUpgrade: vi.fn() } as unknown as WebSocketServer;

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL('http://localhost/terminal?workspaceId=missing-workspace'),
      wss,
      new WeakMap<WebSocket, boolean>()
    );

    await vi.waitFor(() => {
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('400 Bad Request'));
    });
    expect(socket.write).toHaveBeenCalledWith(
      expect.stringContaining('Workspace not found or has no worktree')
    );
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(terminalService.getTerminalsForWorkspace).not.toHaveBeenCalled();
  });

  it('keeps existing connections streaming when a new client connects', async () => {
    const workspaceId = 'workspace-1';
    const terminalId = 'terminal-1';

    const outputListeners = new Map<string, Set<(output: string) => void>>();
    const exitListeners = new Map<string, Set<(exitCode: number) => void>>();

    const terminalService = {
      getTerminalsForWorkspace: vi.fn(() => [
        {
          id: terminalId,
          createdAt: new Date('2026-02-11T00:00:00.000Z'),
          outputBuffer: 'initial output',
        },
      ]),
      onOutput: vi.fn((id: string, callback: (output: string) => void) => {
        const listeners = outputListeners.get(id) ?? new Set();
        listeners.add(callback);
        outputListeners.set(id, listeners);
        return () => listeners.delete(callback);
      }),
      onExit: vi.fn((id: string, callback: (exitCode: number) => void) => {
        const listeners = exitListeners.get(id) ?? new Set();
        listeners.add(callback);
        exitListeners.set(id, listeners);
        return () => listeners.delete(callback);
      }),
      createTerminal: vi.fn(),
      writeToTerminal: vi.fn(),
      resizeTerminal: vi.fn(),
      destroyTerminal: vi.fn(),
      setActiveTerminal: vi.fn(),
    };

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const appContext = {
      services: {
        sessionDataService,
        terminalService,
        workspaceDataService,
        configService: {
          getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin] })),
        },
        createLogger: vi.fn(() => logger),
      },
    } as unknown as AppContext;

    const handler = createTerminalUpgradeHandler(appContext);

    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();
    const wsQueue = [ws1, ws2];

    const wss = {
      handleUpgrade: vi.fn(
        (
          _request: IncomingMessage,
          _socket: Duplex,
          _head: Buffer,
          callback: (ws: WebSocket) => void
        ) => {
          const nextWs = wsQueue.shift();
          if (!nextWs) {
            throw new Error('No WebSocket available');
          }
          callback(nextWs as unknown as WebSocket);
        }
      ),
    } as unknown as WebSocketServer;

    const request = createRequest();
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();
    const url = new URL(`http://localhost/terminal?workspaceId=${workspaceId}`);

    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);
    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);

    await vi.waitFor(() => {
      expect(wss.handleUpgrade).toHaveBeenCalledTimes(2);
    });

    const listeners = outputListeners.get(terminalId);
    expect(listeners?.size).toBe(2);

    ws1.send.mockClear();
    ws2.send.mockClear();
    ws1.bufferedAmount = MAX_WEBSOCKET_STREAM_BUFFERED_BYTES + 1;

    for (const listener of listeners ?? []) {
      listener('live output');
    }

    const outputMessage = JSON.stringify({
      type: 'output',
      terminalId,
      data: 'live output',
    });
    expect(ws1.send).not.toHaveBeenCalled();
    expect(ws2.send).toHaveBeenCalledWith(outputMessage, expect.any(Function));
    expect(terminalConnections.subscriberCount(workspaceId)).toBe(2);
  });

  it('drops live terminal output while the socket is congested and resumes after drain', async () => {
    const workspaceId = 'workspace-1';
    const terminalId = 'terminal-1';
    const { terminalService, outputListeners } = createTerminalService();
    terminalService.getTerminalsForWorkspace.mockReturnValue([
      {
        id: terminalId,
        createdAt: new Date('2026-07-16T00:00:00.000Z'),
        outputBuffer: '',
      },
    ]);
    const logger = createLogger();
    const appContext = {
      services: {
        sessionDataService,
        terminalService,
        workspaceDataService,
        configService: {
          getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin] })),
        },
        createLogger: vi.fn(() => logger),
      },
    } as unknown as AppContext;
    const ws = new MockWebSocket();
    const handler = createTerminalUpgradeHandler(appContext);

    handler(
      createRequest(),
      { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex,
      Buffer.alloc(0),
      new URL(`http://localhost/terminal?workspaceId=${workspaceId}`),
      createWss(ws),
      new WeakMap<WebSocket, boolean>()
    );

    await vi.waitFor(() => {
      expect(outputListeners.get(terminalId)?.size).toBe(1);
    });
    const listener = Array.from(outputListeners.get(terminalId) ?? [])[0];
    if (!listener) {
      throw new Error('Expected terminal output listener');
    }

    ws.send.mockClear();
    ws.bufferedAmount = MAX_WEBSOCKET_STREAM_BUFFERED_BYTES + 1;
    listener('dropped output');
    expect(ws.send).not.toHaveBeenCalled();

    ws.bufferedAmount = 0;
    listener('resumed output');
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'output',
        terminalId,
        data: 'resumed output',
      }),
      expect.any(Function)
    );
  });

  it('creates terminals, persists sessions, and routes message types', async () => {
    const workspaceId = 'workspace-1';
    vi.mocked(workspaceDataService.findById).mockResolvedValue({
      id: workspaceId,
      worktreePath: '/tmp/worktree',
    } as never);

    const { terminalService, outputListeners, exitListeners } = createTerminalService();
    const logger = createLogger();
    const appContext = {
      services: {
        sessionDataService,
        terminalService,
        workspaceDataService,
        configService: {
          getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin] })),
        },
        createLogger: vi.fn(() => logger),
      },
    } as unknown as AppContext;

    const handler = createTerminalUpgradeHandler(appContext);
    const ws = new MockWebSocket();
    const wss = createWss(ws);
    const request = createRequest();
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL(`http://localhost/terminal?workspaceId=${workspaceId}`),
      wss,
      wsAliveMap
    );

    await vi.waitFor(() => {
      expect(wss.handleUpgrade).toHaveBeenCalledTimes(1);
    });

    ws.emit('message', JSON.stringify({ type: 'create', cols: 120, rows: 40 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(terminalService.createTerminal).toHaveBeenCalledWith({
      workspaceId,
      workingDir: '/tmp/worktree',
      cols: 120,
      rows: 40,
    });
    expect(sessionDataService.createTerminalSession).toHaveBeenCalledWith({
      workspaceId,
      name: 'terminal-1',
      pid: 4321,
    });
    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'created', terminalId: 'terminal-1' })
      );
    });

    ws.emit(
      'message',
      JSON.stringify({ type: 'input', terminalId: 'terminal-1', data: 'echo hello\n' })
    );
    ws.emit(
      'message',
      JSON.stringify({ type: 'resize', terminalId: 'terminal-1', cols: 100, rows: 30 })
    );
    ws.emit('message', JSON.stringify({ type: 'set_active', terminalId: 'terminal-1' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(terminalService.writeToTerminal).toHaveBeenCalledWith(
      workspaceId,
      'terminal-1',
      'echo hello\n'
    );
    expect(terminalService.resizeTerminal).toHaveBeenCalledWith(workspaceId, 'terminal-1', 100, 30);
    expect(terminalService.setActiveTerminal).toHaveBeenCalledWith(workspaceId, 'terminal-1');

    for (const callback of outputListeners.get('terminal-1') ?? []) {
      callback('stdout');
    }
    for (const callback of exitListeners.get('terminal-1') ?? []) {
      callback(0);
    }
    await Promise.resolve();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'output', terminalId: 'terminal-1', data: 'stdout' }),
      expect.any(Function)
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'exit', terminalId: 'terminal-1', exitCode: 0 })
    );
    expect(mockClearTerminalPid).toHaveBeenCalledWith(workspaceId, 'terminal-1');

    ws.emit('message', JSON.stringify({ type: 'destroy', terminalId: 'terminal-1' }));
    await Promise.resolve();
    expect(terminalService.destroyTerminal).toHaveBeenCalledWith(workspaceId, 'terminal-1');
  });

  it('includes output buffered before listeners attach in the created message', async () => {
    const workspaceId = 'workspace-1';
    const { terminalService } = createTerminalService();
    terminalService.getTerminal.mockReturnValue({ outputBuffer: 'early prompt $ ' });

    const logger = createLogger();
    const appContext = {
      services: {
        sessionDataService,
        terminalService,
        workspaceDataService,
        configService: {
          getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin] })),
        },
        createLogger: vi.fn(() => logger),
      },
    } as unknown as AppContext;

    const handler = createTerminalUpgradeHandler(appContext);
    const ws = new MockWebSocket();
    const wss = createWss(ws);
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;

    handler(
      createRequest(),
      socket,
      Buffer.alloc(0),
      new URL(`http://localhost/terminal?workspaceId=${workspaceId}`),
      wss,
      new WeakMap<WebSocket, boolean>()
    );

    await vi.waitFor(() => {
      expect(wss.handleUpgrade).toHaveBeenCalledTimes(1);
    });

    ws.emit('message', JSON.stringify({ type: 'create', requestId: 'request-1' }));

    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'created',
          terminalId: 'terminal-1',
          requestId: 'request-1',
          outputBuffer: 'early prompt $ ',
        })
      );
    });

    // The buffer snapshot must be taken before the live output listener
    // attaches so bytes emitted during the DB write are not duplicated.
    const getTerminalOrder = terminalService.getTerminal.mock.invocationCallOrder[0];
    const onOutputOrder = terminalService.onOutput.mock.invocationCallOrder[0];
    expect(getTerminalOrder).toBeDefined();
    expect(onOutputOrder).toBeDefined();
    expect(getTerminalOrder!).toBeLessThan(onOutputOrder!);
  });

  it('echoes create request ids when terminal creations resolve out of order', async () => {
    const workspaceId = 'workspace-1';
    vi.mocked(workspaceDataService.findById).mockResolvedValue({
      id: workspaceId,
      worktreePath: '/tmp/worktree',
    } as never);

    const { terminalService } = createTerminalService();
    type CreateResult = { terminalId: string; pid: number };
    let resolveFirst: ((value: CreateResult | PromiseLike<CreateResult>) => void) | undefined;
    let resolveSecond: ((value: CreateResult | PromiseLike<CreateResult>) => void) | undefined;

    terminalService.createTerminal
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          })
      );

    const logger = createLogger();
    const appContext = {
      services: {
        sessionDataService,
        terminalService,
        workspaceDataService,
        configService: {
          getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin] })),
        },
        createLogger: vi.fn(() => logger),
      },
    } as unknown as AppContext;

    const handler = createTerminalUpgradeHandler(appContext);
    const ws = new MockWebSocket();
    const wss = createWss(ws);
    const request = createRequest();
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL(`http://localhost/terminal?workspaceId=${workspaceId}`),
      wss,
      new WeakMap<WebSocket, boolean>()
    );

    await vi.waitFor(() => {
      expect(wss.handleUpgrade).toHaveBeenCalledTimes(1);
    });

    ws.emit(
      'message',
      JSON.stringify({ type: 'create', requestId: 'request-1', cols: 80, rows: 24 })
    );
    ws.emit(
      'message',
      JSON.stringify({ type: 'create', requestId: 'request-2', cols: 80, rows: 24 })
    );

    await vi.waitFor(() => {
      expect(resolveFirst).toBeDefined();
      expect(resolveSecond).toBeDefined();
    });

    resolveSecond?.({ terminalId: 'terminal-2', pid: 4322 });
    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'created',
          terminalId: 'terminal-2',
          requestId: 'request-2',
        })
      );
    });

    resolveFirst?.({ terminalId: 'terminal-1', pid: 4321 });
    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'created',
          terminalId: 'terminal-1',
          requestId: 'request-1',
        })
      );
    });
  });

  it('retries clearing the persisted pid when terminal exit cleanup transiently fails', async () => {
    const workspaceId = 'workspace-1';
    const terminalId = 'terminal-1';
    const { terminalService, exitListeners } = createTerminalService();
    terminalService.getTerminalsForWorkspace.mockReturnValue([
      {
        id: terminalId,
        createdAt: new Date('2026-07-15T00:00:00.000Z'),
        outputBuffer: '',
      },
    ]);
    mockClearTerminalPid
      .mockRejectedValueOnce(new Error('database locked'))
      .mockResolvedValueOnce(undefined);

    const logger = createLogger();
    const appContext = {
      services: {
        sessionDataService,
        terminalService,
        workspaceDataService,
        configService: {
          getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin] })),
        },
        createLogger: vi.fn(() => logger),
      },
    } as unknown as AppContext;
    const handler = createTerminalUpgradeHandler(appContext);
    const ws = new MockWebSocket();
    const wss = createWss(ws);

    handler(
      createRequest(),
      { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex,
      Buffer.alloc(0),
      new URL(`http://localhost/terminal?workspaceId=${workspaceId}`),
      wss,
      new WeakMap<WebSocket, boolean>()
    );

    await vi.waitFor(() => {
      expect(exitListeners.get(terminalId)?.size).toBe(1);
    });

    for (const callback of exitListeners.get(terminalId) ?? []) {
      callback(0);
    }

    await vi.waitFor(() => {
      expect(mockClearTerminalPid).toHaveBeenCalledTimes(2);
    });
    expect(mockClearTerminalPid).toHaveBeenNthCalledWith(1, workspaceId, terminalId);
    expect(mockClearTerminalPid).toHaveBeenNthCalledWith(2, workspaceId, terminalId);
    expect(logger.warn).not.toHaveBeenCalledWith('Failed to clear terminal PID', expect.anything());
  });

  it('destroys a newly created terminal when session persistence fails', async () => {
    const workspaceId = 'workspace-1';
    vi.mocked(workspaceDataService.findById).mockResolvedValue({
      id: workspaceId,
      worktreePath: '/tmp/worktree',
    } as never);
    vi.mocked(sessionDataService.createTerminalSession).mockRejectedValueOnce(
      new Error('database locked')
    );

    const terminalInstances = new Map<string, { id: string; pid: number }>();
    const { terminalService } = createTerminalService();
    terminalService.createTerminal.mockImplementationOnce(() => {
      const terminalId = 'terminal-1';
      terminalInstances.set(terminalId, { id: terminalId, pid: 4321 });
      return Promise.resolve({ terminalId, pid: 4321 });
    });
    terminalService.destroyTerminal.mockImplementationOnce((_wsId, terminalId) => {
      terminalInstances.delete(terminalId);
      return true;
    });

    const logger = createLogger();
    const appContext = {
      services: {
        sessionDataService,
        terminalService,
        workspaceDataService,
        configService: {
          getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin] })),
        },
        createLogger: vi.fn(() => logger),
      },
    } as unknown as AppContext;

    const handler = createTerminalUpgradeHandler(appContext);
    const ws = new MockWebSocket();
    const wss = createWss(ws);
    const request = createRequest();
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL(`http://localhost/terminal?workspaceId=${workspaceId}`),
      wss,
      new WeakMap<WebSocket, boolean>()
    );

    await vi.waitFor(() => {
      expect(wss.handleUpgrade).toHaveBeenCalledTimes(1);
    });

    ws.emit('message', JSON.stringify({ type: 'create', cols: 80, rows: 24 }));

    await vi.waitFor(() => {
      expect(sessionDataService.createTerminalSession).toHaveBeenCalledWith({
        workspaceId,
        name: 'terminal-1',
        pid: 4321,
      });
      expect(terminalService.destroyTerminal).toHaveBeenCalledWith(workspaceId, 'terminal-1');
    });

    expect(terminalInstances.size).toBe(0);
    expect(terminalService.onOutput).not.toHaveBeenCalled();
    expect(terminalService.onExit).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalledWith(
      JSON.stringify({ type: 'created', terminalId: 'terminal-1' })
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Operation failed: database locked' })
    );
  });

  it('sends structured errors for invalid or failed terminal operations', async () => {
    const workspaceId = 'workspace-1';
    vi.mocked(workspaceDataService.findById).mockResolvedValue({
      id: workspaceId,
      worktreePath: '/tmp/worktree',
    } as never);

    const { terminalService } = createTerminalService();
    terminalService.createTerminal.mockRejectedValueOnce(new Error('creation failed'));
    const logger = createLogger();
    const appContext = {
      services: {
        sessionDataService,
        terminalService,
        workspaceDataService,
        configService: {
          getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin] })),
        },
        createLogger: vi.fn(() => logger),
      },
    } as unknown as AppContext;

    const handler = createTerminalUpgradeHandler(appContext);
    const ws = new MockWebSocket();
    const wss = createWss(ws);
    const request = createRequest();
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL(`http://localhost/terminal?workspaceId=${workspaceId}`),
      wss,
      new WeakMap<WebSocket, boolean>()
    );

    await vi.waitFor(() => {
      expect(wss.handleUpgrade).toHaveBeenCalledTimes(1);
    });

    ws.emit('message', '{invalid-json');
    await Promise.resolve();
    await Promise.resolve();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Invalid message format' })
    );

    ws.emit('message', JSON.stringify({ type: 'unsupported_type' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Invalid message format' })
    );

    vi.mocked(workspaceDataService.findById).mockResolvedValueOnce(null as never);
    ws.emit('message', JSON.stringify({ type: 'create' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Workspace not found or has no worktree' })
    );

    // Force an operation failure branch (non-syntax error).
    vi.mocked(workspaceDataService.findById).mockResolvedValue({
      id: workspaceId,
      worktreePath: '/tmp/worktree',
    } as never);
    terminalService.createTerminal.mockRejectedValueOnce(new Error('creation failed'));
    ws.emit('message', JSON.stringify({ type: 'create', cols: 10, rows: 10 }));
    await Promise.resolve();
    await Promise.resolve();
    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'error', message: 'Operation failed: creation failed' })
      );
    });
  });
});
