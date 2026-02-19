import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { sessionDataService } from '@/backend/domains/session';
import { workspaceDataService } from '@/backend/domains/workspace';
import { createTerminalUpgradeHandler, terminalConnections } from './terminal.handler';

const mockClearTerminalPid = vi.fn();

vi.mock('@/backend/domains/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/domains/session')>();
  return {
    ...actual,
    sessionDataService: {
      ...actual.sessionDataService,
      clearTerminalPid: (...args: unknown[]) => mockClearTerminalPid(...args),
      createTerminalSession: vi.fn(),
    },
  };
});

vi.mock('@/backend/domains/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/domains/workspace')>();
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
    getTerminalsForWorkspace: vi.fn(() => []),
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

describe('createTerminalUpgradeHandler', () => {
  beforeEach(() => {
    terminalConnections.clear();
    vi.clearAllMocks();
    mockClearTerminalPid.mockResolvedValue(undefined);
  });

  it('rejects upgrades without workspaceId', () => {
    const { terminalService } = createTerminalService();
    const logger = createLogger();
    const appContext = {
      services: {
        terminalService,
        createLogger: vi.fn(() => logger),
      },
    } as unknown as AppContext;
    const handler = createTerminalUpgradeHandler(appContext);

    const request = {} as IncomingMessage;
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

  it('keeps existing connections streaming when a new client connects', () => {
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
        terminalService,
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

    const request = {} as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();
    const url = new URL(`http://localhost/terminal?workspaceId=${workspaceId}`);

    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);
    handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);

    const listeners = outputListeners.get(terminalId);
    expect(listeners?.size).toBe(2);

    for (const listener of listeners ?? []) {
      listener('live output');
    }

    const outputMessage = JSON.stringify({
      type: 'output',
      terminalId,
      data: 'live output',
    });
    expect(ws1.send).toHaveBeenCalledWith(outputMessage);
    expect(ws2.send).toHaveBeenCalledWith(outputMessage);
    expect(terminalConnections.get(workspaceId)?.size).toBe(2);
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
        terminalService,
        createLogger: vi.fn(() => logger),
      },
    } as unknown as AppContext;

    const handler = createTerminalUpgradeHandler(appContext);
    const ws = new MockWebSocket();
    const wss = createWss(ws);
    const request = {} as IncomingMessage;
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
    ws.emit('message', JSON.stringify({ type: 'ping' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(terminalService.writeToTerminal).toHaveBeenCalledWith(
      workspaceId,
      'terminal-1',
      'echo hello\n'
    );
    expect(terminalService.resizeTerminal).toHaveBeenCalledWith(workspaceId, 'terminal-1', 100, 30);
    expect(terminalService.setActiveTerminal).toHaveBeenCalledWith(workspaceId, 'terminal-1');
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }));

    for (const callback of outputListeners.get('terminal-1') ?? []) {
      callback('stdout');
    }
    for (const callback of exitListeners.get('terminal-1') ?? []) {
      callback(0);
    }
    await Promise.resolve();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'output', terminalId: 'terminal-1', data: 'stdout' })
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'exit', terminalId: 'terminal-1', exitCode: 0 })
    );
    expect(mockClearTerminalPid).toHaveBeenCalledWith('terminal-1');

    ws.emit('message', JSON.stringify({ type: 'destroy', terminalId: 'terminal-1' }));
    await Promise.resolve();
    expect(terminalService.destroyTerminal).toHaveBeenCalledWith(workspaceId, 'terminal-1');
  });

  it('sends structured errors for invalid or failed terminal operations', async () => {
    const workspaceId = 'workspace-1';
    vi.mocked(workspaceDataService.findById).mockResolvedValue(null as never);

    const { terminalService } = createTerminalService();
    terminalService.createTerminal.mockRejectedValueOnce(new Error('creation failed'));
    const logger = createLogger();
    const appContext = {
      services: {
        terminalService,
        createLogger: vi.fn(() => logger),
      },
    } as unknown as AppContext;

    const handler = createTerminalUpgradeHandler(appContext);
    const ws = new MockWebSocket();
    const wss = createWss(ws);
    const request = {} as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL(`http://localhost/terminal?workspaceId=${workspaceId}`),
      wss,
      new WeakMap<WebSocket, boolean>()
    );

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
