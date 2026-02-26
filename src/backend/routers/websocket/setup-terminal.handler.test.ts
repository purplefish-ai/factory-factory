import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';

const mockPtyWrite = vi.fn();
const mockPtyResize = vi.fn();
const mockPtyKill = vi.fn();
const mockPtySpawn = vi.fn();

let onDataCallback: ((data: string) => void) | null = null;
let onExitCallback: ((event: { exitCode: number }) => void) | null = null;

vi.mock('node:module', () => ({
  createRequire: () => (id: string) => {
    if (id === 'node-pty') {
      return {
        spawn: mockPtySpawn,
      };
    }
    throw new Error(`Unexpected require: ${id}`);
  },
}));

import { createSetupTerminalUpgradeHandler } from './setup-terminal.handler';

class MockWebSocket extends EventEmitter {
  readyState: number = WS_READY_STATE.OPEN;
  send = vi.fn();
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockPty() {
  return {
    onData: vi.fn((callback: (data: string) => void) => {
      onDataCallback = callback;
    }),
    onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
      onExitCallback = callback;
    }),
    write: mockPtyWrite,
    resize: mockPtyResize,
    kill: mockPtyKill,
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

describe('createSetupTerminalUpgradeHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onDataCallback = null;
    onExitCallback = null;
    mockPtySpawn.mockReturnValue(createMockPty());
  });

  it('creates terminal and routes lifecycle messages', () => {
    const logger = createLogger();
    const configService = {
      getShellPath: vi.fn(() => '/bin/zsh'),
      getChildProcessEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
    };
    const appContext = {
      services: {
        createLogger: vi.fn(() => logger),
        configService,
      },
    } as unknown as AppContext;

    const handler = createSetupTerminalUpgradeHandler(appContext);
    const ws = new MockWebSocket();
    const wss = createWss(ws);
    const request = {} as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL('http://localhost/setup-terminal'),
      wss,
      wsAliveMap
    );

    ws.emit('message', JSON.stringify({ type: 'create', cols: 120, rows: 40 }));

    expect(mockPtySpawn).toHaveBeenCalledWith(
      '/bin/zsh',
      [],
      expect.objectContaining({
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        env: expect.objectContaining({
          PATH: '/usr/bin',
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        }),
      })
    );
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'created' }));

    onDataCallback?.('hello from shell');
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'output', data: 'hello from shell' })
    );

    ws.emit('message', JSON.stringify({ type: 'input', data: 'echo hi\n' }));
    expect(mockPtyWrite).toHaveBeenCalledWith('echo hi\n');

    ws.emit('message', JSON.stringify({ type: 'resize', cols: 150, rows: 50 }));
    expect(mockPtyResize).toHaveBeenCalledWith(150, 50);

    ws.emit('message', JSON.stringify({ type: 'ping' }));
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }));

    ws.emit('message', JSON.stringify({ type: 'create' }));
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Terminal already exists' })
    );

    onExitCallback?.({ exitCode: 9 });
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'exit', exitCode: 9 }));

    ws.emit('message', JSON.stringify({ type: 'create' }));
    expect(mockPtySpawn).toHaveBeenCalledTimes(2);
  });

  it('rejects messages that fail schema validation', () => {
    const logger = createLogger();
    const configService = {
      getShellPath: vi.fn(() => '/bin/zsh'),
      getChildProcessEnv: vi.fn(() => ({})),
    };
    const appContext = {
      services: {
        createLogger: vi.fn(() => logger),
        configService,
      },
    } as unknown as AppContext;

    const handler = createSetupTerminalUpgradeHandler(appContext);
    const ws = new MockWebSocket();
    const wss = createWss(ws);
    const request = {} as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL('http://localhost/setup-terminal'),
      wss,
      wsAliveMap
    );

    ws.emit('message', JSON.stringify({ type: 'resize', cols: '120', rows: 40 }));

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Invalid message format' })
    );
    expect(logger.warn).toHaveBeenCalledWith('Invalid setup terminal message format', {
      errors: expect.any(Array),
    });
  });

  it('reports runtime parsing/spawn failures and cleans up on close', () => {
    const logger = createLogger();
    const configService = {
      getShellPath: vi.fn(() => '/bin/zsh'),
      getChildProcessEnv: vi.fn(() => ({})),
    };
    const appContext = {
      services: {
        createLogger: vi.fn(() => logger),
        configService,
      },
    } as unknown as AppContext;

    const handler = createSetupTerminalUpgradeHandler(appContext);
    const ws = new MockWebSocket();
    const wss = createWss(ws);
    const request = {} as IncomingMessage;
    const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
    const wsAliveMap = new WeakMap<WebSocket, boolean>();

    handler(
      request,
      socket,
      Buffer.alloc(0),
      new URL('http://localhost/setup-terminal'),
      wss,
      wsAliveMap
    );

    ws.emit('message', '{');
    expect(logger.error).toHaveBeenCalledWith('Error in setup terminal', expect.any(SyntaxError));
    expect(ws.send).toHaveBeenCalledWith(
      expect.stringMatching(/^{"type":"error","message":".+"}$/)
    );

    mockPtySpawn.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    ws.emit('message', JSON.stringify({ type: 'create' }));
    expect(logger.error).toHaveBeenCalledWith(
      'Error in setup terminal',
      expect.objectContaining({ message: 'spawn failed' })
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'spawn failed' })
    );

    ws.emit('message', JSON.stringify({ type: 'create' }));
    ws.emit('close');
    expect(mockPtyKill).toHaveBeenCalledTimes(1);

    ws.emit('error', new Error('socket error'));
    expect(logger.error).toHaveBeenCalledWith(
      'Setup terminal WebSocket error',
      expect.objectContaining({ message: 'socket error' })
    );

    ws.readyState = WS_READY_STATE.CLOSED;
    const sentBeforeClosed = ws.send.mock.calls.length;
    ws.emit('message', JSON.stringify({ type: 'ping' }));
    ws.emit('message', JSON.stringify({ type: 'resize', cols: '120', rows: 40 }));
    onDataCallback?.('ignored output');
    expect(ws.send).toHaveBeenCalledTimes(sentBeforeClosed);
  });
});
