import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import type { SnapshotChangedEvent, SnapshotRemovedEvent } from '@/backend/services/workspace';
import {
  createSnapshotsUpgradeHandler,
  disposeSnapshotsHandlerState,
  getSnapshotConnectionsForApplication,
} from './snapshots.handler';

const allowedOrigin = 'http://localhost:3000';
const testApplications = new Set<AppContext>();

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
const {
  storeListeners,
  mockGetByProjectId,
  mockGetCachedReviewCount,
  mockRefreshReviewCountIfStale,
  mockWaitForInProgress,
} = vi.hoisted(() => ({
  storeListeners: new Map<string, (event: unknown) => unknown>(),
  mockGetByProjectId: vi.fn(() => []),
  mockGetCachedReviewCount: vi.fn<() => number | undefined>(() => 5),
  mockRefreshReviewCountIfStale: vi.fn(),
  mockWaitForInProgress: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

const snapshotStoreEmitter = new EventEmitter();
const workspaceSnapshotStore = {
  getByProjectId: mockGetByProjectId,
  on: vi.fn((event: string, listener: (event: unknown) => unknown) => {
    storeListeners.set(event, listener);
    snapshotStoreEmitter.on(event, listener);
    return snapshotStoreEmitter;
  }),
  off: vi.fn((event: string, listener: (event: unknown) => unknown) => {
    snapshotStoreEmitter.off(event, listener);
    return snapshotStoreEmitter;
  }),
};

// ============================================================================
// Helpers
// ============================================================================

function createAppContextMock(
  overrides: { workspaceQueryService?: unknown; workspaceSnapshotStore?: unknown } = {}
): AppContext {
  const application = {
    services: {
      createLogger: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
      configService: {
        getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin] })),
      },
      workspaceQueryService: overrides.workspaceQueryService ?? {
        getCachedReviewCount: mockGetCachedReviewCount,
        refreshReviewCountIfStale: mockRefreshReviewCountIfStale,
      },
      workspaceSnapshotStore: overrides.workspaceSnapshotStore ?? workspaceSnapshotStore,
    },
    lifecycle: {
      snapshotReconciliation: {
        waitForInProgress: mockWaitForInProgress,
      },
    },
  } as unknown as AppContext;
  testApplications.add(application);
  return application;
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
  projectId?: string,
  requestOverrides: { origin?: string; remoteAddress?: string } = {}
) {
  const wss = createWssMock(ws);
  const request = {
    headers: { origin: requestOverrides.origin ?? allowedOrigin },
    socket: { remoteAddress: requestOverrides.remoteAddress ?? '127.0.0.1' },
  } as unknown as IncomingMessage;
  const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
  const wsAliveMap = new WeakMap<WebSocket, boolean>();
  const urlStr = projectId
    ? `http://localhost/snapshots?projectId=${projectId}`
    : 'http://localhost/snapshots';
  const url = new URL(urlStr);

  handler(request, socket, Buffer.alloc(0), url, wss, wsAliveMap);
  return { wss, socket, wsAliveMap };
}

async function waitForInitialSnapshot(ws: MockWebSocket): Promise<void> {
  await vi.waitFor(() => {
    expect(ws.send).toHaveBeenCalled();
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('createSnapshotsUpgradeHandler', () => {
  beforeEach(() => {
    mockGetCachedReviewCount.mockReturnValue(5);
  });

  afterEach(() => {
    for (const application of testApplications) {
      disposeSnapshotsHandlerState(application);
    }
    testApplications.clear();
    storeListeners.clear();
    mockWaitForInProgress.mockImplementation(() => Promise.resolve());
  });

  it('sends full snapshot with review count on connect', async () => {
    const visibleEntry = {
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      name: 'Visible',
      status: 'READY',
    };
    const testEntries = [
      visibleEntry,
      { workspaceId: 'ws-2', projectId: 'proj-1', name: 'Archiving', status: 'ARCHIVING' },
      { workspaceId: 'ws-3', projectId: 'proj-1', name: 'Archived', status: 'ARCHIVED' },
    ];
    mockGetByProjectId.mockReturnValue(testEntries as never);

    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();

    callHandler(handler, ws, 'proj-1');

    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'snapshot_full',
          projectId: 'proj-1',
          entries: [visibleEntry],
          reviewCount: 5,
        })
      );
    });
    expect(mockRefreshReviewCountIfStale).toHaveBeenCalled();
  });

  it('omits review count from full snapshot when cache is not populated', async () => {
    mockGetCachedReviewCount.mockReturnValue(undefined);
    mockGetByProjectId.mockReturnValue([
      {
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        name: 'Visible',
        status: 'READY',
      },
    ] as never);

    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();

    callHandler(handler, ws, 'proj-1');

    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'snapshot_full',
          projectId: 'proj-1',
          entries: [
            {
              workspaceId: 'ws-1',
              projectId: 'proj-1',
              name: 'Visible',
              status: 'READY',
            },
          ],
        })
      );
    });
    expect(mockRefreshReviewCountIfStale).toHaveBeenCalled();
  });

  it('rejects connection without projectId', () => {
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();
    const { socket } = callHandler(handler, ws);

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('400 Bad Request'));
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('rejects unauthorized origins before subscription setup and projectId checks', () => {
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();
    const { wss, socket } = callHandler(handler, ws, undefined, {
      origin: 'https://attacker.example',
    });

    expect(storeListeners.size).toBe(0);
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Unauthorized origin'));
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('rejects untrusted local requests before subscription setup', () => {
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();
    const { wss, socket } = callHandler(handler, ws, 'proj-1', {
      remoteAddress: '203.0.113.10',
    });

    expect(storeListeners.size).toBe(0);
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('routes snapshot_changed with review count to correct project clients', async () => {
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());

    const wsA = new MockWebSocket();
    const wsB = new MockWebSocket();

    callHandler(handler, wsA, 'proj-A');
    callHandler(handler, wsB, 'proj-B');

    await waitForInitialSnapshot(wsA);
    await waitForInitialSnapshot(wsB);

    // Clear send calls from full snapshot on connect
    wsA.send.mockClear();
    wsB.send.mockClear();

    const changedListener = storeListeners.get('snapshot_changed');
    expect(changedListener).toBeDefined();

    const event: SnapshotChangedEvent = {
      workspaceId: 'ws-1',
      projectId: 'proj-A',
      entry: {
        workspaceId: 'ws-1',
        projectId: 'proj-A',
        name: 'Updated',
        status: 'READY',
      } as never,
    };
    await changedListener!(event);

    expect(wsA.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry: event.entry,
        reviewCount: 5,
      })
    );
    expect(wsB.send).not.toHaveBeenCalled();
    expect(mockRefreshReviewCountIfStale).toHaveBeenCalled();
  });

  it('keeps snapshot delta dependencies scoped to each application', async () => {
    const listenersA = new Map<string, (event: unknown) => unknown>();
    const listenersB = new Map<string, (event: unknown) => unknown>();
    const createStore = (listeners: Map<string, (event: unknown) => unknown>) => ({
      getByProjectId: vi.fn(() => [
        {
          workspaceId: 'baseline',
          projectId: 'project',
          name: 'Baseline',
          status: 'READY',
        },
      ]),
      on: vi.fn((event: string, listener: (event: unknown) => unknown) => {
        listeners.set(event, listener);
      }),
      off: vi.fn(),
    });
    const queryA = {
      getCachedReviewCount: vi.fn(() => 11),
      refreshReviewCountIfStale: vi.fn(),
    };
    const queryB = {
      getCachedReviewCount: vi.fn(() => 22),
      refreshReviewCountIfStale: vi.fn(),
    };
    const handlerA = createSnapshotsUpgradeHandler(
      createAppContextMock({
        workspaceQueryService: queryA,
        workspaceSnapshotStore: createStore(listenersA),
      })
    );
    const handlerB = createSnapshotsUpgradeHandler(
      createAppContextMock({
        workspaceQueryService: queryB,
        workspaceSnapshotStore: createStore(listenersB),
      })
    );
    const wsA = new MockWebSocket();
    const wsB = new MockWebSocket();

    callHandler(handlerA, wsA, 'project-a');
    callHandler(handlerB, wsB, 'project-b');
    await waitForInitialSnapshot(wsA);
    await waitForInitialSnapshot(wsB);
    wsA.send.mockClear();
    wsB.send.mockClear();
    queryA.getCachedReviewCount.mockClear();
    queryB.getCachedReviewCount.mockClear();

    const changedListenerB = listenersB.get('snapshot_changed');
    expect(changedListenerB).toBeDefined();
    await changedListenerB!({
      workspaceId: 'workspace-b',
      projectId: 'project-b',
      entry: {
        workspaceId: 'workspace-b',
        projectId: 'project-b',
        name: 'B',
        status: 'READY',
      },
    });

    expect(wsB.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'snapshot_changed',
        workspaceId: 'workspace-b',
        entry: {
          workspaceId: 'workspace-b',
          projectId: 'project-b',
          name: 'B',
          status: 'READY',
        },
        reviewCount: 22,
      })
    );
    expect(wsA.send).not.toHaveBeenCalled();
    expect(queryA.getCachedReviewCount).not.toHaveBeenCalled();
  });

  it('omits review count from snapshot_changed when cache is not populated', async () => {
    mockGetCachedReviewCount.mockReturnValue(undefined);
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();

    callHandler(handler, ws, 'proj-1');
    await waitForInitialSnapshot(ws);
    ws.send.mockClear();

    const changedListener = storeListeners.get('snapshot_changed');
    expect(changedListener).toBeDefined();

    const event: SnapshotChangedEvent = {
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      entry: {
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        name: 'Updated',
        status: 'READY',
      } as never,
    };
    await changedListener!(event);

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry: event.entry,
      })
    );
    expect(mockRefreshReviewCountIfStale).toHaveBeenCalled();
  });

  it('routes ARCHIVING snapshot_changed as snapshot_removed with review count', async () => {
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();

    callHandler(handler, ws, 'proj-1');
    await waitForInitialSnapshot(ws);
    ws.send.mockClear();

    const changedListener = storeListeners.get('snapshot_changed');
    expect(changedListener).toBeDefined();

    const event: SnapshotChangedEvent = {
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      entry: {
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        name: 'Archiving',
        status: 'ARCHIVING',
      } as never,
    };
    await changedListener!(event);

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'snapshot_removed',
        workspaceId: 'ws-1',
        reviewCount: 5,
      })
    );
  });

  it('sends snapshot_removed with review count to project clients', async () => {
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();

    callHandler(handler, ws, 'proj-1');
    await waitForInitialSnapshot(ws);
    ws.send.mockClear();

    const removedListener = storeListeners.get('snapshot_removed');
    expect(removedListener).toBeDefined();

    const event: SnapshotRemovedEvent = {
      workspaceId: 'ws-1',
      projectId: 'proj-1',
    };
    await removedListener!(event);

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'snapshot_removed',
        workspaceId: 'ws-1',
        reviewCount: 5,
      })
    );
  });

  it('buffers deltas emitted before snapshot_full and flushes them after it', async () => {
    let resolveWait: (() => void) | undefined;
    mockWaitForInProgress.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveWait = resolve;
      })
    );
    mockGetByProjectId.mockReturnValue([] as never);

    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();
    callHandler(handler, ws, 'proj-1');

    const changedListener = storeListeners.get('snapshot_changed');
    expect(changedListener).toBeDefined();

    const event: SnapshotChangedEvent = {
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      entry: {
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        name: 'Early',
        status: 'READY',
      } as never,
    };
    await changedListener!(event);

    // The client has no baseline yet, so the delta must not be sent.
    expect(ws.send).not.toHaveBeenCalled();

    resolveWait?.();

    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalledTimes(2);
    });

    expect(ws.send.mock.calls[0]?.[0]).toContain('"type":"snapshot_full"');
    // Replayed deltas omit reviewCount so a count computed before the
    // baseline cannot overwrite the newer one carried by snapshot_full.
    expect(ws.send.mock.calls[1]?.[0]).toBe(
      JSON.stringify({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry: event.entry,
      })
    );
  });

  it('keeps buffering deltas when the snapshot_full send fails', async () => {
    mockGetByProjectId.mockReturnValue([
      {
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        name: 'Visible',
        status: 'READY',
      },
    ] as never);

    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();
    ws.send.mockImplementation(() => {
      throw new Error('socket closing');
    });

    callHandler(handler, ws, 'proj-1');
    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalledTimes(1);
    });

    const changedListener = storeListeners.get('snapshot_changed');
    expect(changedListener).toBeDefined();

    await changedListener!({
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      entry: {
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        name: 'Updated',
        status: 'READY',
      } as never,
    });

    // The baseline never reached the client, so deltas must stay buffered
    // rather than being sent (or flushed) without a snapshot_full first.
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('does not send to non-OPEN sockets', async () => {
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();

    callHandler(handler, ws, 'proj-1');
    await waitForInitialSnapshot(ws);
    ws.send.mockClear();

    // Set socket to CLOSED state
    ws.readyState = WS_READY_STATE.CLOSED;

    const changedListener = storeListeners.get('snapshot_changed');
    await changedListener!({
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      entry: { workspaceId: 'ws-1', status: 'READY' },
    });

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('continues snapshot_changed fan-out when one client send throws', async () => {
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const throwingWs = new MockWebSocket();
    const healthyWs = new MockWebSocket();

    callHandler(handler, throwingWs, 'proj-1');
    callHandler(handler, healthyWs, 'proj-1');

    await waitForInitialSnapshot(throwingWs);
    await waitForInitialSnapshot(healthyWs);
    throwingWs.send.mockClear();
    healthyWs.send.mockClear();

    throwingWs.send.mockImplementation(() => {
      throw new Error('socket closing');
    });

    const changedListener = storeListeners.get('snapshot_changed');
    expect(changedListener).toBeDefined();

    const event: SnapshotChangedEvent = {
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      entry: {
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        name: 'Updated',
        status: 'READY',
      } as never,
    };
    expect(() => changedListener!(event)).not.toThrow();

    expect(healthyWs.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry: event.entry,
        reviewCount: 5,
      })
    );
  });

  it('continues snapshot_removed fan-out when one client send throws', async () => {
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const throwingWs = new MockWebSocket();
    const healthyWs = new MockWebSocket();

    callHandler(handler, throwingWs, 'proj-1');
    callHandler(handler, healthyWs, 'proj-1');

    await waitForInitialSnapshot(throwingWs);
    await waitForInitialSnapshot(healthyWs);
    throwingWs.send.mockClear();
    healthyWs.send.mockClear();

    throwingWs.send.mockImplementation(() => {
      throw new Error('socket closing');
    });

    const removedListener = storeListeners.get('snapshot_removed');
    expect(removedListener).toBeDefined();

    const event: SnapshotRemovedEvent = {
      workspaceId: 'ws-1',
      projectId: 'proj-1',
    };
    expect(() => removedListener!(event)).not.toThrow();

    expect(healthyWs.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'snapshot_removed',
        workspaceId: 'ws-1',
        reviewCount: 5,
      })
    );
  });

  it('does not throw out of the upgrade callback when the initial snapshot send throws', () => {
    mockGetByProjectId.mockReturnValue([
      {
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        name: 'Visible',
        status: 'READY',
      },
    ] as never);

    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();
    ws.send.mockImplementation(() => {
      throw new Error('socket closing');
    });

    expect(() => callHandler(handler, ws, 'proj-1')).not.toThrow();
    expect(ws.send).toHaveBeenCalled();
  });

  it('cleans up connection set on close', () => {
    const application = createAppContextMock();
    const handler = createSnapshotsUpgradeHandler(application);
    const connections = getSnapshotConnectionsForApplication(application);
    const ws = new MockWebSocket();

    callHandler(handler, ws, 'proj-1');

    expect(connections?.subscribers('proj-1').has(ws as unknown as WebSocket)).toBe(true);

    // Emit close event
    ws.emit('close');

    // Connection should be removed
    expect(connections?.hasSubscribers('proj-1')).toBe(false);
  });

  it('retains project entry when other connections remain after close', () => {
    const application = createAppContextMock();
    const handler = createSnapshotsUpgradeHandler(application);
    const connections = getSnapshotConnectionsForApplication(application);
    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();

    callHandler(handler, ws1, 'proj-1');
    callHandler(handler, ws2, 'proj-1');

    expect(connections?.subscriberCount('proj-1')).toBe(2);

    // Close first connection
    ws1.emit('close');

    // Project entry should remain with one connection
    expect(connections?.subscriberCount('proj-1')).toBe(1);
    expect(connections?.subscribers('proj-1').has(ws2 as unknown as WebSocket)).toBe(true);
  });

  it('disposes store listeners and per-application connection state idempotently', () => {
    const application = createAppContextMock();
    const handler = createSnapshotsUpgradeHandler(application);
    callHandler(handler, new MockWebSocket(), 'proj-1');

    expect(snapshotStoreEmitter.listenerCount('snapshot_changed')).toBe(1);
    expect(snapshotStoreEmitter.listenerCount('snapshot_removed')).toBe(1);
    expect(getSnapshotConnectionsForApplication(application)).toBeDefined();

    disposeSnapshotsHandlerState(application);
    disposeSnapshotsHandlerState(application);

    expect(snapshotStoreEmitter.listenerCount('snapshot_changed')).toBe(0);
    expect(snapshotStoreEmitter.listenerCount('snapshot_removed')).toBe(0);
    expect(getSnapshotConnectionsForApplication(application)).toBeUndefined();

    const restartedHandler = createSnapshotsUpgradeHandler(application);
    callHandler(restartedHandler, new MockWebSocket(), 'proj-1');
    expect(snapshotStoreEmitter.listenerCount('snapshot_changed')).toBe(1);
    expect(snapshotStoreEmitter.listenerCount('snapshot_removed')).toBe(1);
  });
});
