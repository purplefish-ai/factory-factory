/**
 * Events WebSocket Handler
 *
 * Provides a global /events WebSocket for snapshot updates.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import { eventsHubService } from '../../services/events-hub.service';
import { eventsPollerService } from '../../services/events-poller.service';
import { eventsSnapshotService } from '../../services/events-snapshot.service';
import { createLogger } from '../../services/logger.service';

const logger = createLogger('events-ws');

export function handleEventsUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
  wss: WebSocketServer,
  wsAliveMap: WeakMap<WebSocket, boolean>
): void {
  const projectId = url.searchParams.get('projectId') || undefined;
  const workspaceId = url.searchParams.get('workspaceId') || undefined;
  const scopes = parseScopes(url.searchParams.get('scope'));

  wss.handleUpgrade(request, socket, head, (ws) => {
    wsAliveMap.set(ws, true);
    ws.on('pong', () => wsAliveMap.set(ws, true));

    eventsHubService.addConnection({ ws, projectId, workspaceId, scopes });

    void sendInitialSnapshots(ws, projectId, workspaceId);

    ws.on('close', () => {
      eventsHubService.removeConnection(ws);
    });

    ws.on('error', (error) => {
      logger.debug('Events WebSocket error', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

function parseScopes(value: string | null): Set<string> {
  if (!value) {
    return new Set();
  }
  return new Set(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

async function sendInitialSnapshots(
  ws: WebSocket,
  projectId?: string,
  workspaceId?: string
): Promise<void> {
  await Promise.all([
    sendInitialProjectSummary(ws, projectId),
    sendInitialWorkspaceInit(ws, workspaceId),
  ]);
}

async function sendInitialProjectSummary(ws: WebSocket, projectId?: string): Promise<void> {
  if (!projectId) {
    return;
  }
  try {
    const snapshot = await eventsSnapshotService.getProjectSummarySnapshot(
      projectId,
      eventsPollerService.getReviewCount()
    );
    eventsHubService.sendToConnection(ws, snapshot);
  } catch (error) {
    logger.debug('Failed to send project summary snapshot', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function sendInitialWorkspaceInit(ws: WebSocket, workspaceId?: string): Promise<void> {
  if (!workspaceId) {
    return;
  }
  try {
    const snapshot = await eventsSnapshotService.getWorkspaceInitStatusSnapshot(workspaceId);
    if (snapshot) {
      eventsHubService.sendToConnection(ws, snapshot);
    }
  } catch (error) {
    logger.debug('Failed to send workspace init status snapshot', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
