/**
 * Chat Connection Service
 *
 * Manages WebSocket connection tracking and message forwarding for chat sessions.
 * Responsible for:
 * - Tracking active WebSocket connections by connection ID
 * - Forwarding messages to all connections viewing a specific session
 */

import type { WebSocket } from 'ws';
import { WS_READY_STATE } from '@/backend/constants';
import { configService } from '@/backend/services/config.service';
import { createLogger } from '@/backend/services/logger.service';
import { sessionFileLogger } from '@/backend/services/session-file-logger.service';

const logger = createLogger('chat-connection');

const DEBUG_CHAT_WS = configService.getDebugConfig().chatWebSocket;

// ============================================================================
// Types
// ============================================================================

export interface ConnectionInfo {
  ws: WebSocket;
  dbSessionId: string | null;
  workingDir: string;
}

// ============================================================================
// Service
// ============================================================================

class ChatConnectionService {
  private connections = new Map<string, ConnectionInfo>();

  /** DOM-04: Message counter moved from module scope into class instance. */
  private chatWsMsgCounter = 0;

  /**
   * Register a new WebSocket connection.
   */
  register(connectionId: string, info: ConnectionInfo): void {
    this.connections.set(connectionId, info);
  }

  /**
   * Unregister a WebSocket connection.
   */
  unregister(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  /**
   * Get connection info by ID.
   */
  get(connectionId: string): ConnectionInfo | undefined {
    return this.connections.get(connectionId);
  }

  /**
   * Check if a connection exists.
   */
  has(connectionId: string): boolean {
    return this.connections.has(connectionId);
  }

  /**
   * Get all connections (for iteration).
   */
  values(): IterableIterator<ConnectionInfo> {
    return this.connections.values();
  }

  /**
   * Forward a message to all connections viewing a specific session.
   * Optionally excludes a specific WebSocket (e.g., the sender).
   */
  forwardToSession(dbSessionId: string | null, data: unknown, exclude?: WebSocket): void {
    // Skip if no session (connection exists but no session selected yet)
    if (!dbSessionId) {
      return;
    }

    this.chatWsMsgCounter++;
    const msgNum = this.chatWsMsgCounter;

    let connectionCount = 0;
    for (const info of this.connections.values()) {
      if (
        info.dbSessionId === dbSessionId &&
        info.ws.readyState === WS_READY_STATE.OPEN &&
        info.ws !== exclude
      ) {
        connectionCount++;
      }
    }

    if (connectionCount === 0) {
      if (DEBUG_CHAT_WS) {
        logger.debug(`[Chat WS #${msgNum}] No connections viewing session`, { dbSessionId });
      }
      return;
    }

    if (DEBUG_CHAT_WS) {
      const dataObj = data as { type?: string; data?: { type?: string; uuid?: string } };
      logger.info(`[Chat WS #${msgNum}] Sending to ${connectionCount} connection(s)`, {
        dbSessionId,
        type: dataObj.type,
        innerType: dataObj.data?.type,
        uuid: dataObj.data?.uuid,
      });
    }

    sessionFileLogger.log(dbSessionId, 'OUT_TO_CLIENT', data);

    const json = JSON.stringify(data);
    for (const info of this.connections.values()) {
      if (
        info.dbSessionId === dbSessionId &&
        info.ws.readyState === WS_READY_STATE.OPEN &&
        info.ws !== exclude
      ) {
        info.ws.send(json);
      }
    }
  }
}

export const chatConnectionService = new ChatConnectionService();
