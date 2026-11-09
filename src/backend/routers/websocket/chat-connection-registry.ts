/**
 * Chat Connection Registry (WebSocket adapter)
 *
 * Transport-side counterpart of the session domain's `sessionEventBus`
 * (ARCH-02: domain emits events, the adapter owns sockets). Responsible for:
 * - Tracking chat WebSocket connections by connection ID
 * - Maintaining a per-session topic index so fan-out is O(viewers), not
 *   O(all connections)
 * - Serializing and delivering session-scoped payloads published by the
 *   session domain, including OUT_TO_CLIENT session file logging
 * - Answering viewer-count queries from the domain via the event bus
 */

import type { WebSocket } from 'ws';
import type { Application, ApplicationServices } from '@/backend/app-context';
import { TopicBroadcaster } from '@/backend/lib/topic-broadcaster';
import {
  MAX_WEBSOCKET_STATEFUL_FRAME_BYTES,
  MAX_WEBSOCKET_STATEFUL_BACKLOG_BYTES,
  sendStateful,
} from '@/backend/lib/websocket-send';
import {
  CHAT_BROADCAST_EVENT,
  type ChatBroadcastEvent,
  SESSION_OUTBOUND_EVENT,
  type SessionOutboundEvent,
} from '@/backend/services/session';
import type { WebSocketMessage } from '@/shared/acp-protocol';
import type { SessionReplayChunk } from '@/shared/acp-protocol/protocol/replay-frame-schema';
import { ChatReplayDelivery } from './chat-replay-delivery';

type ChatRegistryLogger = Pick<
  ReturnType<ApplicationServices['createLogger']>,
  'debug' | 'error' | 'info'
>;

const NOOP_LOGGER: ChatRegistryLogger = {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
};

// ============================================================================
// Types
// ============================================================================

export interface ConnectionInfo {
  readonly ws: WebSocket;
  readonly dbSessionId: string | null;
  readonly workingDir: string | null;
}

interface ConnectionEntry {
  info: ConnectionInfo;
  /** Disposer for the per-session topic subscription; null when no session. */
  unsubscribe: (() => void) | null;
}

// ============================================================================
// Registry
// ============================================================================

export class ChatConnectionRegistry {
  private readonly connections = new Map<string, ConnectionEntry>();
  /** Per-session socket index; topics are DB session ids. */
  private readonly broadcaster = new TopicBroadcaster<string>(
    { error: (...args) => this.logger.error(...args) },
    'chat session message'
  );

  private readonly activeReplays = new WeakMap<WebSocket, ChatReplayDelivery>();
  private readonly incompleteLoads = new WeakSet<WebSocket>();
  private readonly incomingReplays = new Map<string, { id: string; loadRequestId?: string }>();
  private readonly blockedBaselines = new WeakSet<WebSocket>();
  private readonly pendingReplays = new WeakMap<WebSocket, { loadRequestId: string }>();
  private readonly expectedReplays = new WeakMap<WebSocket, string | undefined>();
  private maxFrameBytes = MAX_WEBSOCKET_STATEFUL_FRAME_BYTES;
  private chatWsMsgCounter = 0;
  private logger: ChatRegistryLogger = NOOP_LOGGER;
  private debugChatWebSocket = false;

  configure({
    logger,
    debugChatWebSocket,
    maxFrameBytes = MAX_WEBSOCKET_STATEFUL_FRAME_BYTES,
  }: {
    logger: ChatRegistryLogger;
    debugChatWebSocket: boolean;
    maxFrameBytes?: number;
  }): void {
    this.maxFrameBytes = maxFrameBytes;
    this.logger = logger;
    this.debugChatWebSocket = debugChatWebSocket;
  }

  /**
   * Register a WebSocket connection. Re-registering an existing connection ID
   * (client reconnect) replaces the previous entry and its session
   * subscription.
   */
  register(connectionId: string, info: ConnectionInfo): void {
    const previous = this.connections.get(connectionId);
    previous?.unsubscribe?.();
    if (previous && previous.info.ws !== info.ws) {
      this.releaseViewer(previous.info.ws);
    }
    this.connections.set(connectionId, {
      info,
      unsubscribe: info.dbSessionId ? this.broadcaster.subscribe(info.dbSessionId, info.ws) : null,
    });
  }

  unregister(connectionId: string): void {
    const entry = this.connections.get(connectionId);
    if (!entry) {
      return;
    }
    entry.unsubscribe?.();
    this.releaseViewer(entry.info.ws);
    this.connections.delete(connectionId);
  }

  private releaseViewer(ws: WebSocket): void {
    this.activeReplays.get(ws)?.cancel();
    this.activeReplays.delete(ws);
    this.pendingReplays.delete(ws);
    this.expectedReplays.delete(ws);
    this.incompleteLoads.delete(ws);
    this.blockedBaselines.delete(ws);
  }

  get(connectionId: string): ConnectionInfo | undefined {
    return this.connections.get(connectionId)?.info;
  }

  has(connectionId: string): boolean {
    return this.connections.has(connectionId);
  }

  /** Correlate a load to its requesting viewer without changing normal replay fan-out. */
  expectReplay(ws: WebSocket, loadRequestId?: string): void {
    const active = this.activeReplays.get(ws);
    const old = this.incompleteLoads.has(ws)
      ? this.expectedReplays.get(ws)
      : (active?.loadRequestId ?? this.pendingReplays.get(ws)?.loadRequestId);
    const hadPending =
      this.incompleteLoads.has(ws) || active !== undefined || this.pendingReplays.has(ws);
    if (hadPending && old !== loadRequestId) {
      if (old !== undefined) {
        this.sendLoadError(ws, old, 409, 'A newer load superseded this request.');
      }
      active?.cancel();
      this.activeReplays.delete(ws);
      this.pendingReplays.delete(ws);
      this.blockedBaselines.add(ws);
    }
    this.incompleteLoads.add(ws);
    this.expectedReplays.set(ws, loadRequestId);
  }

  /** Count connections currently viewing a specific DB session. */
  countViewers(dbSessionId: string | null): number {
    if (!dbSessionId) {
      return 0;
    }
    return this.broadcaster.subscriberCount(dbSessionId);
  }

  /**
   * Forward a payload to all connections viewing a session. Returns the
   * number of viewer writes admitted. onWritten observes a successful local write.
   */
  broadcastToSession(
    dbSessionId: string,
    payload: WebSocketMessage,
    onWritten?: () => void
  ): number {
    this.chatWsMsgCounter++;
    const msgNum = this.chatWsMsgCounter;

    const baseline = payload.type === 'session_replay_batch' || payload.type === 'session_snapshot';
    let recorded = false;
    const written = () => {
      if (!recorded) {
        recorded = true;
        onWritten?.();
      }
    };
    if (payload.type === 'session_replay_chunk' && payload.index === 0) {
      this.incomingReplays.set(dbSessionId, {
        id: payload.replayId,
        loadRequestId:
          payload.loadRequestId ??
          (payload.encoding === 'events' ? payload.batch?.loadRequestId : undefined),
      });
    }
    const incoming = this.incomingReplays.get(dbSessionId);
    const sent = this.broadcaster.broadcastWith(dbSessionId, payload, (ws, message) => {
      if (payload.type === 'session_replay_chunk') {
        return this.sendChunk(ws, payload, message, incoming, written);
      }
      if (payload.type === 'error' && payload.code === 413 && payload.loadRequestId) {
        if (this.expectedReplays.get(ws) !== payload.loadRequestId) {
          return false;
        }
        this.blockedBaselines.add(ws);
        this.incompleteLoads.delete(ws);
        return this.write(ws, message, written);
      }
      const active = this.activeReplays.get(ws);
      if (active) {
        return this.enqueueAfterReplay(
          active,
          message,
          written,
          baseline && payload.loadRequestId !== undefined
        );
      }
      if (baseline) {
        return this.sendBaseline(ws, message, payload.loadRequestId, written);
      }
      return !this.blockedBaselines.has(ws) && this.write(ws, message, written);
    });
    if (payload.type === 'session_replay_chunk' && payload.index === payload.total - 1) {
      this.incomingReplays.delete(dbSessionId);
    }
    if (sent === 0) {
      if (this.debugChatWebSocket) {
        this.logger.debug(`[Chat WS #${msgNum}] No viewer writes admitted`, { dbSessionId });
      }
      return 0;
    }

    if (this.debugChatWebSocket) {
      const delta = payload.type === 'session_delta' ? payload.data : undefined;
      this.logger.info(`[Chat WS #${msgNum}] Queued for ${sent} connection(s)`, {
        dbSessionId,
        type: payload.type,
        innerType: delta?.type,
      });
    }

    return sent;
  }

  private enqueueAfterReplay(
    active: ChatReplayDelivery,
    message: string,
    written: () => void,
    correlatedBaseline: boolean
  ): boolean {
    // This viewer already has its authoritative response in progress.
    // Correlated baselines are retries or belong to another viewer.
    return !correlatedBaseline && active.enqueueTail(message, written);
  }

  private sendBaseline(
    ws: WebSocket,
    message: string,
    loadRequestId: string | undefined,
    written: () => void
  ): boolean {
    const ownLoad = this.expectedReplays.get(ws) === loadRequestId;
    const bytes = Buffer.byteLength(message);
    // A peer discards another viewer's correlated replay. Do not pressure it
    // with a large authoritative frame that it cannot use.
    if (loadRequestId && !ownLoad && bytes > MAX_WEBSOCKET_STATEFUL_BACKLOG_BYTES) {
      return false;
    }
    if (loadRequestId && this.pendingReplays.get(ws)?.loadRequestId === loadRequestId) {
      return false;
    }
    if (this.blockedBaselines.has(ws) && !ownLoad) {
      return false;
    }
    if (bytes > this.maxFrameBytes) {
      this.blockedBaselines.add(ws);
      this.incompleteLoads.delete(ws);
      this.sendLoadError(
        ws,
        loadRequestId,
        413,
        'Session replay exceeds WEBSOCKET_MAX_FRAME_BYTES; increase the configured limit and reconnect.'
      );
      return false;
    }
    return this.enqueueBaseline(ws, message, loadRequestId, ownLoad, written);
  }

  private enqueueBaseline(
    ws: WebSocket,
    message: string,
    loadRequestId: string | undefined,
    ownLoad: boolean,
    written: () => void
  ): boolean {
    const pending =
      loadRequestId && Buffer.byteLength(message) > MAX_WEBSOCKET_STATEFUL_BACKLOG_BYTES
        ? { loadRequestId }
        : undefined;
    const clearPending = () => {
      if (this.pendingReplays.get(ws) === pending) {
        this.pendingReplays.delete(ws);
      }
    };
    if (pending) {
      this.pendingReplays.set(ws, pending);
    }
    const sent = sendStateful(ws, message, this.logger, 'chat replay', {
      allowLargeFrame: true,
      maxFrameBytes: this.maxFrameBytes,
      onFlushed: (error) => {
        clearPending();
        if (!error) {
          written();
        }
      },
    });
    if (!sent) {
      clearPending();
    }
    if (sent && ownLoad) {
      this.blockedBaselines.delete(ws);
      this.expectedReplays.delete(ws);
      this.incompleteLoads.delete(ws);
    }
    return sent;
  }

  private write(ws: WebSocket, message: string, written: () => void): boolean {
    return sendStateful(ws, message, this.logger, 'chat session message', {
      onFlushed: (error) => {
        if (!error) {
          written();
        }
      },
    });
  }

  private sendLoadError(
    ws: WebSocket,
    loadRequestId: string | undefined,
    code: number,
    message: string
  ): void {
    sendStateful(
      ws,
      JSON.stringify({ type: 'error', code, loadRequestId, message }),
      this.logger,
      'chat load error'
    );
  }

  private sendChunk(
    ws: WebSocket,
    frame: SessionReplayChunk,
    message: string,
    incoming: { id: string; loadRequestId?: string } | undefined,
    written: () => void
  ): boolean {
    if (!incoming || incoming.id !== frame.replayId) {
      return false;
    }
    const requestId = incoming.loadRequestId;
    if (this.expectedReplays.get(ws) !== requestId) {
      return false;
    }
    let delivery = this.activeReplays.get(ws);
    if (delivery && delivery.first.replayId !== frame.replayId) {
      return false;
    }
    if (!delivery) {
      if (frame.index !== 0) {
        return false;
      }
      if (frame.byteLength > this.maxFrameBytes) {
        this.blockedBaselines.add(ws);
        this.incompleteLoads.delete(ws);
        this.sendLoadError(
          ws,
          requestId,
          413,
          'Session replay exceeds WEBSOCKET_MAX_FRAME_BYTES; increase the configured limit and reconnect.'
        );
        return false;
      }
      const current = new ChatReplayDelivery(
        ws,
        frame,
        requestId,
        this.logger,
        () => {
          if (this.activeReplays.get(ws) !== current) {
            return;
          }
          this.activeReplays.delete(ws);
          this.blockedBaselines.delete(ws);
          this.expectedReplays.delete(ws);
          this.incompleteLoads.delete(ws);
        },
        () => {
          if (this.activeReplays.get(ws) === current) {
            this.activeReplays.delete(ws);
          }
        }
      );
      delivery = current;
      this.activeReplays.set(ws, current);
    }
    return delivery.append(frame, message, written);
  }

  /**
   * Send a payload to every chat connection, regardless of session. Iterates
   * the connection map (not the topic index) because connections without a
   * selected session are not subscribed to any topic.
   */
  broadcastToAll(payload: Record<string, unknown>): void {
    const message = JSON.stringify(payload);
    for (const entry of this.connections.values()) {
      sendStateful(entry.info.ws, message, this.logger, 'workspace notification');
    }
  }

  /** Drop all connections and subscriptions. */
  clear(): void {
    for (const entry of this.connections.values()) {
      entry.unsubscribe?.();
      this.releaseViewer(entry.info.ws);
    }
    this.connections.clear();
    this.incomingReplays.clear();
  }

  /** Close all registered sockets before dropping transport-owned references. */
  dispose(): void {
    for (const entry of this.connections.values()) {
      entry.unsubscribe?.();
      this.releaseViewer(entry.info.ws);
      entry.info.ws.close();
    }
    this.connections.clear();
    this.incomingReplays.clear();
  }
}

const applicationChatConnectionRegistries = new WeakMap<Application, ChatConnectionRegistry>();

export function getChatConnectionRegistryForApplication(
  application: Application
): ChatConnectionRegistry {
  const existing = applicationChatConnectionRegistries.get(application);
  if (existing) {
    return existing;
  }
  const registry = new ChatConnectionRegistry();
  applicationChatConnectionRegistries.set(application, registry);
  return registry;
}

// ============================================================================
// Event Bus Wiring
// ============================================================================

type ChatTransportDeps = Pick<
  ApplicationServices,
  'configService' | 'createLogger' | 'sessionEventBus' | 'sessionFileLogger'
>;

interface ChatTransportAttachment {
  readonly deps: ChatTransportDeps;
  readonly sessionOutboundListener: (event: SessionOutboundEvent) => void;
  readonly chatBroadcastListener: (event: ChatBroadcastEvent) => void;
}

const chatTransportAttachments = new WeakMap<ChatConnectionRegistry, ChatTransportAttachment>();

export function detachChatTransport(registry: ChatConnectionRegistry): void {
  const attachment = chatTransportAttachments.get(registry);
  if (!attachment) {
    registry.dispose();
    return;
  }
  const { sessionEventBus } = attachment.deps;
  sessionEventBus.off(SESSION_OUTBOUND_EVENT, attachment.sessionOutboundListener);
  sessionEventBus.off(CHAT_BROADCAST_EVENT, attachment.chatBroadcastListener);
  sessionEventBus.registerViewerCountProvider(null);
  chatTransportAttachments.delete(registry);
  registry.dispose();
}

/**
 * Subscribe a transport-owned registry to an application's session event bus
 * and register the viewer-count provider. Repeated attachment with the same
 * dependency identities is idempotent; a different graph is rebound safely.
 *
 * OUT_TO_CLIENT session file logging lives here rather than in the registry
 * so it uses the app context's `sessionFileLogger`; it records only payloads
 * successfully written to at least one local socket (not a peer receipt).
 */
export function attachChatTransport(
  deps: ChatTransportDeps,
  registry: ChatConnectionRegistry
): void {
  const existing = chatTransportAttachments.get(registry);
  if (
    existing?.deps.configService === deps.configService &&
    existing.deps.createLogger === deps.createLogger &&
    existing.deps.sessionEventBus === deps.sessionEventBus &&
    existing.deps.sessionFileLogger === deps.sessionFileLogger
  ) {
    return;
  }
  if (existing) {
    detachChatTransport(registry);
  }
  const { configService, createLogger, sessionEventBus, sessionFileLogger } = deps;
  registry.configure({
    logger: createLogger('chat-connection'),
    debugChatWebSocket: configService.getDebugConfig().chatWebSocket,
    maxFrameBytes: configService.getWebSocketConfig().maxFrameBytes,
  });

  const sessionOutboundListener = (event: SessionOutboundEvent) => {
    registry.broadcastToSession(event.sessionId, event.payload, () => {
      sessionFileLogger.log(event.sessionId, 'OUT_TO_CLIENT', event.payload);
    });
  };
  const chatBroadcastListener = (event: ChatBroadcastEvent) => {
    registry.broadcastToAll(event.payload);
  };

  sessionEventBus.on(SESSION_OUTBOUND_EVENT, sessionOutboundListener);
  sessionEventBus.on(CHAT_BROADCAST_EVENT, chatBroadcastListener);
  sessionEventBus.registerViewerCountProvider((sessionId) => registry.countViewers(sessionId));
  chatTransportAttachments.set(registry, {
    deps,
    sessionOutboundListener,
    chatBroadcastListener,
  });
}

export function disposeChatTransportForApplication(application: Application): void {
  const registry = applicationChatConnectionRegistries.get(application);
  if (!registry) {
    return;
  }
  detachChatTransport(registry);
  applicationChatConnectionRegistries.delete(application);
}
