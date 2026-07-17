import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import type {
  SnapshotChangedEvent,
  SnapshotRemovedEvent,
} from '@/backend/services/workspace-snapshot-store.service';
import {
  SnapshotServerMessageSchema,
  type WorkspaceSnapshotEntry,
} from '@/shared/workspace-snapshot';
import { makeWorkspaceSnapshotEntry } from '@/test-utils/workspace-snapshot';
import {
  createSnapshotsUpgradeHandler,
  resetSnapshotsHandlerStateForTests,
  snapshotConnections,
} from './snapshots.handler';

const allowedOrigin = 'http://localhost:3000';

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
  mockGetByProjectId: vi.fn<() => WorkspaceSnapshotEntry[]>(() => []),
  mockGetCachedReviewCount: vi.fn<() => number | undefined>(() => 5),
  mockRefreshReviewCountIfStale: vi.fn(),
  mockWaitForInProgress: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

vi.mock('@/backend/orchestration/snapshot-reconciliation.orchestrator', () => ({
  snapshotReconciliationService: {
    waitForInProgress: mockWaitForInProgress,
  },
}));

vi.mock('@/backend/services/workspace-snapshot-store.service', () => {
  const { EventEmitter } = require('node:events');
  const emitter = new EventEmitter();
  const originalOn = emitter.on.bind(emitter);

  return {
    SNAPSHOT_CHANGED: 'snapshot_changed',
    SNAPSHOT_REMOVED: 'snapshot_removed',
    workspaceSnapshotStore: {
      getByProjectId: mockGetByProjectId,
      on: vi.fn((event: string, listener: (event: unknown) => unknown) => {
        storeListeners.set(event, listener);
        originalOn(event, listener);
        return emitter;
      }),
      off: vi.fn((event: string, listener: (event: unknown) => unknown) => {
        emitter.off(event, listener);
        return emitter;
      }),
    },
  };
});

vi.mock('@/backend/services/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/services/workspace')>();
  return {
    ...actual,
    workspaceQueryService: {
      ...actual.workspaceQueryService,
      getCachedReviewCount: mockGetCachedReviewCount,
      refreshReviewCountIfStale: mockRefreshReviewCountIfStale,
    },
  };
});

vi.mock('@/backend/app-context', () => ({
  createAppContext: vi.fn(() => ({
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
      configService: {
        getCorsConfig: vi.fn(() => ({ allowedOrigins: [allowedOrigin] })),
      },
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

function makeSnapshotEntry(
  overrides: Partial<WorkspaceSnapshotEntry> = {}
): WorkspaceSnapshotEntry {
  return makeWorkspaceSnapshotEntry({
    computedAt: '2026-07-17T12:00:00.000Z',
    name: 'Visible',
    createdAt: '2026-07-17T11:00:00.000Z',
    ciObservation: 'CHECKS_UNKNOWN',
    fieldTimestamps: {
      workspace: 1,
      pr: 1,
      session: 1,
      ratchet: 1,
      runScript: 1,
      reconciliation: 1,
    },
    ...overrides,
  });
}

function parseSentMessage(ws: MockWebSocket, callIndex = 0) {
  const serialized = ws.send.mock.calls[callIndex]?.[0];
  expect(serialized).toBeTypeOf('string');
  return SnapshotServerMessageSchema.parse(JSON.parse(serialized));
}

// ============================================================================
// Tests
// ============================================================================

describe('createSnapshotsUpgradeHandler', () => {
  beforeEach(() => {
    mockGetCachedReviewCount.mockReturnValue(5);
  });

  afterEach(() => {
    // Clean up connection map between tests
    snapshotConnections.clear();
    resetSnapshotsHandlerStateForTests();
    storeListeners.clear();
    mockWaitForInProgress.mockImplementation(() => Promise.resolve());
  });

  it('sends full snapshot with review count on connect', async () => {
    const visibleEntry = makeSnapshotEntry();
    const testEntries = [
      visibleEntry,
      makeSnapshotEntry({ workspaceId: 'ws-2', name: 'Archiving', status: 'ARCHIVING' }),
      makeSnapshotEntry({ workspaceId: 'ws-3', name: 'Archived', status: 'ARCHIVED' }),
    ];
    mockGetByProjectId.mockReturnValue(testEntries);

    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();

    callHandler(handler, ws, 'proj-1');

    await waitForInitialSnapshot(ws);
    expect(parseSentMessage(ws)).toEqual({
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [visibleEntry],
      reviewCount: 5,
    });
    expect(mockRefreshReviewCountIfStale).toHaveBeenCalled();
  });

  it('omits review count from full snapshot when cache is not populated', async () => {
    mockGetCachedReviewCount.mockReturnValue(undefined);
    const visibleEntry = makeSnapshotEntry();
    mockGetByProjectId.mockReturnValue([visibleEntry]);

    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();

    callHandler(handler, ws, 'proj-1');

    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'snapshot_full',
          projectId: 'proj-1',
          entries: [visibleEntry],
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
      entry: makeSnapshotEntry({ projectId: 'proj-A', name: 'Updated' }),
    };
    await changedListener!(event);

    expect(parseSentMessage(wsA)).toEqual({
      type: 'snapshot_changed',
      workspaceId: 'ws-1',
      entry: event.entry,
      reviewCount: 5,
    });
    expect(wsB.send).not.toHaveBeenCalled();
    expect(mockRefreshReviewCountIfStale).toHaveBeenCalled();
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
      entry: makeSnapshotEntry({ name: 'Updated' }),
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
      entry: makeSnapshotEntry({ name: 'Archiving', status: 'ARCHIVING' }),
    };
    await changedListener!(event);

    expect(parseSentMessage(ws)).toEqual({
      type: 'snapshot_removed',
      workspaceId: 'ws-1',
      reviewCount: 5,
    });
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
    mockGetByProjectId.mockReturnValue([]);

    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();
    callHandler(handler, ws, 'proj-1');

    const changedListener = storeListeners.get('snapshot_changed');
    expect(changedListener).toBeDefined();

    const event: SnapshotChangedEvent = {
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      entry: makeSnapshotEntry({ name: 'Early' }),
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
    mockGetByProjectId.mockReturnValue([makeSnapshotEntry()]);

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
      entry: makeSnapshotEntry({ name: 'Updated' }),
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
      entry: makeSnapshotEntry({ name: 'Updated' }),
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
    mockGetByProjectId.mockReturnValue([makeSnapshotEntry()]);

    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();
    ws.send.mockImplementation(() => {
      throw new Error('socket closing');
    });

    expect(() => callHandler(handler, ws, 'proj-1')).not.toThrow();
    expect(ws.send).toHaveBeenCalled();
  });

  it('cleans up connection set on close', () => {
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws = new MockWebSocket();

    callHandler(handler, ws, 'proj-1');

    expect(snapshotConnections.subscribers('proj-1').has(ws as unknown as WebSocket)).toBe(true);

    // Emit close event
    ws.emit('close');

    // Connection should be removed
    expect(snapshotConnections.hasSubscribers('proj-1')).toBe(false);
  });

  it('retains project entry when other connections remain after close', () => {
    const handler = createSnapshotsUpgradeHandler(createAppContextMock());
    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();

    callHandler(handler, ws1, 'proj-1');
    callHandler(handler, ws2, 'proj-1');

    expect(snapshotConnections.subscriberCount('proj-1')).toBe(2);

    // Close first connection
    ws1.emit('close');

    // Project entry should remain with one connection
    expect(snapshotConnections.subscriberCount('proj-1')).toBe(1);
    expect(snapshotConnections.subscribers('proj-1').has(ws2 as unknown as WebSocket)).toBe(true);
  });
});
