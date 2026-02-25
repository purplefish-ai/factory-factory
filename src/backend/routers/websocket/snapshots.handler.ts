/**
 * Snapshots WebSocket Handler
 *
 * Handles WebSocket connections for streaming workspace snapshot changes
 * to clients in real time, scoped by project ID. On connect, sends the
 * full project snapshot. On subsequent changes, pushes per-workspace deltas.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import { type AppContext, createAppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import {
  SNAPSHOT_CHANGED,
  SNAPSHOT_REMOVED,
  type SnapshotChangedEvent,
  type SnapshotRemovedEvent,
  workspaceSnapshotStore,
} from '@/backend/services/workspace-snapshot-store.service';
import { WorkspaceStatus } from '@/shared/core';
import { getOrCreateConnectionSet, markWebSocketAlive, sendBadRequest } from './upgrade-utils';

// ============================================================================
// Types
// ============================================================================

/**
 * Map of project ID to set of WebSocket connections
 */
export type SnapshotConnectionsMap = Map<string, Set<WebSocket>>;

// ============================================================================
// State
// ============================================================================

export const snapshotConnections: SnapshotConnectionsMap = new Map();

// ============================================================================
// Store Event Fan-Out
// ============================================================================

class SnapshotStoreSubscriptionState {
  private active = false;
  private snapshotChangedListener: ((event: SnapshotChangedEvent) => void) | null = null;
  private snapshotRemovedListener: ((event: SnapshotRemovedEvent) => void) | null = null;

  ensure(
    connections: SnapshotConnectionsMap,
    logger: ReturnType<AppContext['services']['createLogger']>
  ): void {
    if (this.active) {
      return;
    }

    const changedListener = (event: SnapshotChangedEvent) => {
      const projectClients = connections.get(event.projectId);
      if (!projectClients || projectClients.size === 0) {
        return;
      }

      const message = JSON.stringify(
        isHiddenWorkspaceStatus(event.entry.status)
          ? {
              type: 'snapshot_removed',
              workspaceId: event.workspaceId,
            }
          : {
              type: 'snapshot_changed',
              workspaceId: event.workspaceId,
              entry: event.entry,
            }
      );

      for (const ws of projectClients) {
        if (ws.readyState === WS_READY_STATE.OPEN) {
          ws.send(message);
        }
      }
    };

    const removedListener = (event: SnapshotRemovedEvent) => {
      const projectClients = connections.get(event.projectId);
      if (!projectClients || projectClients.size === 0) {
        return;
      }

      const message = JSON.stringify({
        type: 'snapshot_removed',
        workspaceId: event.workspaceId,
      });

      for (const ws of projectClients) {
        if (ws.readyState === WS_READY_STATE.OPEN) {
          ws.send(message);
        }
      }
    };

    workspaceSnapshotStore.on(SNAPSHOT_CHANGED, changedListener);
    workspaceSnapshotStore.on(SNAPSHOT_REMOVED, removedListener);

    this.snapshotChangedListener = changedListener;
    this.snapshotRemovedListener = removedListener;
    this.active = true;

    logger.info('Snapshot WebSocket store subscription active');
  }

  reset(): void {
    const storeWithOff = workspaceSnapshotStore as typeof workspaceSnapshotStore & {
      off?: (event: string, listener: (...args: unknown[]) => unknown) => unknown;
    };
    if (typeof storeWithOff.off === 'function') {
      if (this.snapshotChangedListener) {
        storeWithOff.off(SNAPSHOT_CHANGED, this.snapshotChangedListener);
      }
      if (this.snapshotRemovedListener) {
        storeWithOff.off(SNAPSHOT_REMOVED, this.snapshotRemovedListener);
      }
    }

    this.snapshotChangedListener = null;
    this.snapshotRemovedListener = null;
    this.active = false;
  }
}

const defaultSnapshotStoreSubscriptionState = new SnapshotStoreSubscriptionState();

function isHiddenWorkspaceStatus(status: WorkspaceStatus): boolean {
  return status === WorkspaceStatus.ARCHIVING || status === WorkspaceStatus.ARCHIVED;
}

export function resetSnapshotsHandlerStateForTests(): void {
  snapshotConnections.clear();
  defaultSnapshotStoreSubscriptionState.reset();
}

// ============================================================================
// Upgrade Handler
// ============================================================================

export function createSnapshotsUpgradeHandler(
  appContext: AppContext,
  options: {
    connections?: SnapshotConnectionsMap;
    subscriptionState?: SnapshotStoreSubscriptionState;
  } = {}
) {
  const logger = appContext.services.createLogger('snapshots-handler');
  const connections = options.connections ?? snapshotConnections;
  const subscriptionState = options.subscriptionState ?? defaultSnapshotStoreSubscriptionState;

  return function handleSnapshotsUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
    wss: WebSocketServer,
    wsAliveMap: WeakMap<WebSocket, boolean>
  ): void {
    subscriptionState.ensure(connections, logger);

    const projectId = url.searchParams.get('projectId');

    if (!projectId) {
      logger.warn('Snapshots WebSocket missing projectId');
      sendBadRequest(socket);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      logger.info('Snapshots WebSocket connection established', { projectId });

      markWebSocketAlive(ws, wsAliveMap);

      // Add to connection set FIRST (before sending full snapshot)
      getOrCreateConnectionSet(connections, projectId).add(ws);

      // Send full project snapshot (WSKT-02, WSKT-05)
      const entries = workspaceSnapshotStore
        .getByProjectId(projectId)
        .filter((entry) => !isHiddenWorkspaceStatus(entry.status));
      ws.send(
        JSON.stringify({
          type: 'snapshot_full',
          projectId,
          entries,
        })
      );

      ws.on('close', () => {
        logger.info('Snapshots WebSocket connection closed', { projectId });

        const projectConnections = connections.get(projectId);
        if (projectConnections) {
          projectConnections.delete(ws);
          if (projectConnections.size === 0) {
            connections.delete(projectId);
          }
        }
      });

      ws.on('error', (error) => {
        logger.error('Snapshots WebSocket error', error);
      });
    });
  };
}

export const handleSnapshotsUpgrade = createSnapshotsUpgradeHandler(createAppContext());
