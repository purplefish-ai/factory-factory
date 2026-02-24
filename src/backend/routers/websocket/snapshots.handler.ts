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

let storeSubscriptionActive = false;

function isHiddenWorkspaceStatus(status: WorkspaceStatus): boolean {
  return status === WorkspaceStatus.ARCHIVING || status === WorkspaceStatus.ARCHIVED;
}

function ensureStoreSubscription(
  connections: SnapshotConnectionsMap,
  logger: ReturnType<AppContext['services']['createLogger']>
): void {
  if (storeSubscriptionActive) {
    return;
  }
  storeSubscriptionActive = true;

  workspaceSnapshotStore.on(SNAPSHOT_CHANGED, (event: SnapshotChangedEvent) => {
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
  });

  workspaceSnapshotStore.on(SNAPSHOT_REMOVED, (event: SnapshotRemovedEvent) => {
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
  });

  logger.info('Snapshot WebSocket store subscription active');
}

// ============================================================================
// Upgrade Handler
// ============================================================================

export function createSnapshotsUpgradeHandler(appContext: AppContext) {
  const logger = appContext.services.createLogger('snapshots-handler');

  ensureStoreSubscription(snapshotConnections, logger);

  return function handleSnapshotsUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
    wss: WebSocketServer,
    wsAliveMap: WeakMap<WebSocket, boolean>
  ): void {
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
      getOrCreateConnectionSet(snapshotConnections, projectId).add(ws);

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

        const connections = snapshotConnections.get(projectId);
        if (connections) {
          connections.delete(ws);
          if (connections.size === 0) {
            snapshotConnections.delete(projectId);
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
