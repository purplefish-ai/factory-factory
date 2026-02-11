import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants';
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

describe('createTerminalUpgradeHandler', () => {
  beforeEach(() => {
    terminalConnections.clear();
    vi.clearAllMocks();
    mockClearTerminalPid.mockResolvedValue(undefined);
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
});
