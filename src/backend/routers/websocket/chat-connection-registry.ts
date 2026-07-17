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
import { safeSend } from '@/backend/lib/websocket-send';
import {
  CHAT_BROADCAST_EVENT,
  type ChatBroadcastEvent,
  SESSION_OUTBOUND_EVENT,
  type SessionOutboundEvent,
} from '@/backend/services/session';
import type { WebSocketMessage } from '@/shared/acp-protocol';

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

  private chatWsMsgCounter = 0;
  private logger: ChatRegistryLogger = NOOP_LOGGER;
  private debugChatWebSocket = false;

  configure({
    logger,
    debugChatWebSocket,
  }: {
    logger: ChatRegistryLogger;
    debugChatWebSocket: boolean;
  }): void {
    this.logger = logger;
    this.debugChatWebSocket = debugChatWebSocket;
  }

  /**
   * Register a WebSocket connection. Re-registering an existing connection ID
   * (client reconnect) replaces the previous entry and its session
   * subscription.
   */
  register(connectionId: string, info: ConnectionInfo): void {
    this.connections.get(connectionId)?.unsubscribe?.();
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
    this.connections.delete(connectionId);
  }

  get(connectionId: string): ConnectionInfo | undefined {
    return this.connections.get(connectionId)?.info;
  }

  has(connectionId: string): boolean {
    return this.connections.has(connectionId);
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
   * number of sockets the payload was successfully handed to.
   */
  broadcastToSession(dbSessionId: string, payload: WebSocketMessage): number {
    this.chatWsMsgCounter++;
    const msgNum = this.chatWsMsgCounter;

    const sent = this.broadcaster.broadcast(dbSessionId, payload);
    if (sent === 0) {
      if (this.debugChatWebSocket) {
        this.logger.debug(`[Chat WS #${msgNum}] No connections viewing session`, { dbSessionId });
      }
      return 0;
    }

    if (this.debugChatWebSocket) {
      const delta = payload.type === 'session_delta' ? payload.data : undefined;
      this.logger.info(`[Chat WS #${msgNum}] Sent to ${sent} connection(s)`, {
        dbSessionId,
        type: payload.type,
        innerType: delta?.type,
        uuid: delta?.uuid,
      });
    }

    return sent;
  }

  /**
   * Send a payload to every chat connection, regardless of session. Iterates
   * the connection map (not the topic index) because connections without a
   * selected session are not subscribed to any topic.
   */
  broadcastToAll(payload: Record<string, unknown>): void {
    const message = JSON.stringify(payload);
    for (const entry of this.connections.values()) {
      safeSend(entry.info.ws, message, this.logger, 'workspace notification');
    }
  }

  /** Drop all connections and subscriptions. */
  clear(): void {
    for (const entry of this.connections.values()) {
      entry.unsubscribe?.();
    }
    this.connections.clear();
  }

  /** Close all registered sockets before dropping transport-owned references. */
  dispose(): void {
    for (const entry of this.connections.values()) {
      entry.unsubscribe?.();
      entry.info.ws.close();
    }
    this.connections.clear();
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
 * that actually reached at least one client.
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
  });

  const sessionOutboundListener = (event: SessionOutboundEvent) => {
    const sent = registry.broadcastToSession(event.sessionId, event.payload);
    if (sent > 0) {
      sessionFileLogger.log(event.sessionId, 'OUT_TO_CLIENT', event.payload);
    }
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
