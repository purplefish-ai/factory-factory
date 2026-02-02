/**
 * Events Hub Service
 *
 * Manages connections for the global /events WebSocket and broadcasts
 * snapshot updates to interested clients.
 */

import type { WebSocket } from 'ws';
import { WS_READY_STATE } from '../constants';
import { createLogger } from './logger.service';

const logger = createLogger('events-hub');

export interface EventsConnectionInfo {
  ws: WebSocket;
  projectId?: string;
  workspaceId?: string;
}

export interface PublishSnapshotOptions {
  /** Snapshot message type (e.g., project_summary, workspace_init_status) */
  type: string;
  /** Snapshot payload */
  payload: object;
  /** Cache key used for change detection */
  cacheKey: string;
  /** Optional filter: only send to connections for this project */
  projectId?: string;
  /** Optional filter: only send to connections for this workspace */
  workspaceId?: string;
  /** Optional target WebSocket for one-off sends (e.g., initial snapshot) */
  targetWs?: WebSocket;
}

class EventsHubService {
  private connections = new Map<WebSocket, EventsConnectionInfo>();
  private lastSnapshots = new Map<string, string>();

  addConnection(info: EventsConnectionInfo): void {
    this.connections.set(info.ws, info);
  }

  removeConnection(ws: WebSocket): void {
    this.connections.delete(ws);
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  getSubscribedProjectIds(): Set<string> {
    const ids = new Set<string>();
    for (const info of this.connections.values()) {
      if (info.projectId) {
        ids.add(info.projectId);
      }
    }
    return ids;
  }

  getSubscribedWorkspaceIds(): Set<string> {
    const ids = new Set<string>();
    for (const info of this.connections.values()) {
      if (info.workspaceId) {
        ids.add(info.workspaceId);
      }
    }
    return ids;
  }

  sendToConnection(ws: WebSocket, message: object): void {
    if (ws.readyState !== WS_READY_STATE.OPEN) {
      return;
    }
    ws.send(JSON.stringify(message));
  }

  publishSnapshot(options: PublishSnapshotOptions): void {
    const { type, payload, cacheKey, projectId, workspaceId, targetWs } = options;
    if (!this.shouldPublish(cacheKey, payload, targetWs)) {
      return;
    }

    const message = { type, ...(payload as Record<string, unknown>) };

    if (targetWs) {
      this.sendToConnection(targetWs, message);
      return;
    }

    for (const info of this.connections.values()) {
      this.sendSnapshotToConnection(info, message, { type, projectId, workspaceId });
    }
  }

  private shouldPublish(cacheKey: string, payload: object, targetWs?: WebSocket) {
    if (targetWs) {
      return true;
    }

    const serialized = JSON.stringify(payload);
    const previous = this.lastSnapshots.get(cacheKey);
    if (previous === serialized) {
      return false;
    }
    this.lastSnapshots.set(cacheKey, serialized);
    return true;
  }

  private sendSnapshotToConnection(
    info: EventsConnectionInfo,
    message: object,
    options: { type: string; projectId?: string; workspaceId?: string }
  ) {
    if (options.projectId && info.projectId !== options.projectId) {
      return;
    }
    if (options.workspaceId && info.workspaceId !== options.workspaceId) {
      return;
    }
    if (info.ws.readyState !== WS_READY_STATE.OPEN) {
      return;
    }
    try {
      info.ws.send(JSON.stringify(message));
    } catch (error) {
      logger.debug('Failed to send snapshot to connection', {
        error: error instanceof Error ? error.message : String(error),
        type: options.type,
      });
    }
  }
}

export const eventsHubService = new EventsHubService();
