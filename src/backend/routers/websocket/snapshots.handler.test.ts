import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants';
import type { SnapshotChangedEvent, SnapshotRemovedEvent } from '@/backend/services';
import { createSnapshotsUpgradeHandler, snapshotConnections } from './snapshots.handler';

// ============================================================================
// Mocks
// ============================================================================

class MockWebSocket extends EventEmitter {
  readyState: number = WS_READY_STATE.OPEN;
  send = vi.fn();
  close = vi.fn();
  terminate = vi.fn();
}

// Use vi.hoisted so these are available inside hoisted vi.mock factories
const { storeListeners, mockGetByProjectId, mockSendBadRequest } = vi.hoisted(() => ({
  storeListeners: new Map<string, (event: unknown) => void>(),
  mockGetByProjectId: vi.fn(() => []),
  mockSendBadRequest: vi.fn(),
}));

vi.mock('@/backend/services', () => {
  const { EventEmitter } = require('node:events');
  const emitter = new EventEmitter();
  const originalOn = emitter.on.bind(emitter);

  return {
    SNAPSHOT_CHANGED: 'snapshot_changed',
    SNAPSHOT_REMOVED: 'snapshot_removed',
    workspaceSnapshotStore: {
      getByProjectId: mockGetByProjectId,
      on: vi.fn((event: string, listener: (event: unknown) => void) => {
        storeListeners.set(event, listener);
        originalOn(event, listener);
        return emitter;
      }),
    },
  };
});

vi.mock('./upgrade-utils', () => ({
  getOrCreateConnectionSet: vi.fn(
    (map: Map<string, Set<WebSocket>>, key: string): Set<WebSocket> => {
      const existing = map.get(key);
      if (existing) {
        return existing;
      }
      const created = new Set<WebSocket>();
      map.set(key, created);
      return created;
    }
  ),
  markWebSocketAlive: vi.fn(),
  sendBadRequest: mockSendBadRequest,
}));

vi.mock('@/backend/app-context', () => ({
  createAppContext: vi.fn(() => ({
    services: {
      createLogger: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
    },
  })),
}));

// ============================================================================
// Helpers
// ============================================================================

function createAppContextMock(): AppContext {
  return {
    services: {
      createLogger: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
    },
  } as unknown as AppContext;
}

function createWssMock(ws: MockWebSocket): WebSocketServer {
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

function callHandler(
  handler: ReturnType<typeof createSnapshotsUpgradeHandler>,
  ws: MockWebSocket,
  projectId?: string
) {
  const wss = createWssMock(ws);
  const request = {} as IncomingMessage;
  const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
  const wsAliveMap = new WeakMap<WebSocket, boolean>();
  const urlStr = projectId
    ? `http://localhost/snapshots?projectId=${projectId}`
    : 'http://localhost/snapshots';
  const url = new URL(urlStr);

  handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);
  return { wss, socket, wsAliveMap };
}

// ============================================================================
// Tests
// ============================================================================

describe('createSnapshotsUpgradeHandler', () => {
  afterEach(() => {
    // Clean up connection map between tests
    snapshotConnections.clear();
  });

  it('sends full snapshot on connect', () => {
    const testEntries = [
      { workspaceId: 'ws-1', projectId: 'proj-1', name: 'Test' },
      { workspaceId: 'ws-2', projectId: 'proj-1', name: 'Test 2' },
    ];
    mockGetByProjectId.mockReturnValue(testEntries as never);

    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();

    callHandler(handler, ws, 'proj-1');

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: testEntries,
      })
    );
  });

  it('rejects connection without projectId', () => {
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();
    const { socket } = callHandler(handler, ws);

    expect(mockSendBadRequest).toHaveBeenCalledWith(socket);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('routes snapshot_changed to correct project clients', () => {
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());

    const wsA = new MockWebSocket();
    const wsB = new MockWebSocket();

    callHandler(handler, wsA, 'proj-A');
    callHandler(handler, wsB, 'proj-B');

    // Clear send calls from full snapshot on connect
    wsA.send.mockClear();
    wsB.send.mockClear();

    const changedListener = storeListeners.get('snapshot_changed');
    expect(changedListener).toBeDefined();

    const event: SnapshotChangedEvent = {
      workspaceId: 'ws-1',
      projectId: 'proj-A',
      entry: { workspaceId: 'ws-1', projectId: 'proj-A', name: 'Updated' } as never,
    };
    changedListener!(event);

    expect(wsA.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry: event.entry,
      })
    );
    expect(wsB.send).not.toHaveBeenCalled();
  });

  it('sends snapshot_removed to project clients', () => {
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();

    callHandler(handler, ws, 'proj-1');
    ws.send.mockClear();

    const removedListener = storeListeners.get('snapshot_removed');
    expect(removedListener).toBeDefined();

    const event: SnapshotRemovedEvent = {
      workspaceId: 'ws-1',
      projectId: 'proj-1',
    };
    removedListener!(event);

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'snapshot_removed',
        workspaceId: 'ws-1',
      })
    );
  });

  it('does not send to non-OPEN sockets', () => {
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();

    callHandler(handler, ws, 'proj-1');
    ws.send.mockClear();

    // Set socket to CLOSED state
    ws.readyState = WS_READY_STATE.CLOSED;

    const changedListener = storeListeners.get('snapshot_changed');
    changedListener!({
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      entry: { workspaceId: 'ws-1' },
    });

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('cleans up connection set on close', () => {
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();

    callHandler(handler, ws, 'proj-1');

    expect(snapshotConnections.get('proj-1')?.has(ws as unknown as WebSocket)).toBe(true);

    // Emit close event
    ws.emit('close');

    // Connection should be removed
    expect(snapshotConnections.has('proj-1')).toBe(false);
  });

  it('retains project entry when other connections remain after close', () => {
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();

    callHandler(handler, ws1, 'proj-1');
    callHandler(handler, ws2, 'proj-1');

    expect(snapshotConnections.get('proj-1')?.size).toBe(2);

    // Close first connection
    ws1.emit('close');

    // Project entry should remain with one connection
    expect(snapshotConnections.get('proj-1')?.size).toBe(1);
    expect(snapshotConnections.get('proj-1')?.has(ws2 as unknown as WebSocket)).toBe(true);
  });
});
