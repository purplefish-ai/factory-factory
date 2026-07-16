/**
 * Session Event Bus
 *
 * Transport-free outbound event surface for the session domain (ARCH-02,
 * mirroring WorkspaceSnapshotStore). Domain code publishes session-scoped
 * payloads here; the WebSocket adapter in `routers/websocket` owns the socket
 * registry, serialization, and delivery. This keeps `ws` imports out of the
 * session domain entirely.
 *
 * Viewer counts flow the other way: the transport adapter registers a
 * provider so domain code (e.g. session lifecycle cleanup) can ask how many
 * clients are currently viewing a session without knowing about sockets.
 */

import { EventEmitter } from 'node:events';
import type { WebSocketMessage } from '@/shared/acp-protocol';

export const SESSION_OUTBOUND_EVENT = 'session_outbound';
export const CHAT_BROADCAST_EVENT = 'chat_broadcast';

export interface SessionOutboundEvent {
  sessionId: string;
  payload: WebSocketMessage;
}

export interface ChatBroadcastEvent {
  payload: Record<string, unknown>;
}

export type SessionViewerCountProvider = (sessionId: string) => number;

export class SessionEventBus extends EventEmitter {
  private viewerCountProvider: SessionViewerCountProvider | null = null;

  /**
   * Publish a payload to all clients viewing a session. No-op when the
   * session id is null (connection without a selected session).
   */
  publishToSession(sessionId: string | null, payload: WebSocketMessage): void {
    if (!sessionId) {
      return;
    }
    const event: SessionOutboundEvent = { sessionId, payload };
    this.emit(SESSION_OUTBOUND_EVENT, event);
  }

  /** Publish a payload to every connected chat client, regardless of session. */
  publishToAllClients(payload: Record<string, unknown>): void {
    const event: ChatBroadcastEvent = { payload };
    this.emit(CHAT_BROADCAST_EVENT, event);
  }

  /** Called by the transport adapter at startup. Pass null to detach (tests). */
  registerViewerCountProvider(provider: SessionViewerCountProvider | null): void {
    this.viewerCountProvider = provider;
  }

  /**
   * Number of clients currently viewing a session. Returns 0 when no
   * transport adapter is attached.
   */
  countViewers(sessionId: string | null): number {
    if (!sessionId) {
      return 0;
    }
    return this.viewerCountProvider?.(sessionId) ?? 0;
  }
}

export const sessionEventBus = new SessionEventBus();
