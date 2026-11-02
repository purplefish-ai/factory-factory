/**
 * Generic topic-based WebSocket broadcaster.
 *
 * Centralizes the "topic → sockets, iterate, OPEN-check, send, prune on
 * close" pattern previously hand-rolled by the chat, terminal, and snapshots
 * registries. Fan-out cost is O(subscribers of the topic), not O(all
 * connections), because sockets are indexed by topic key.
 *
 * Sends use an injected delivery policy (safeSend by default). Stateful
 * channels retire slow viewers without interrupting healthy subscribers.
 */

import type { WebSocket } from 'ws';
import { safeSend } from './websocket-send';

interface BroadcastLogger {
  error(message: string, error: Error): void;
}

const EMPTY_SET: ReadonlySet<WebSocket> = new Set();

export class TopicBroadcaster<TKey = string> {
  private readonly topics = new Map<TKey, Set<WebSocket>>();

  constructor(
    private readonly logger: BroadcastLogger,
    private readonly defaultDescription = 'WebSocket message'
  ) {}

  /**
   * Subscribe a socket to a topic. Returns a disposer that removes the
   * subscription again, dropping the topic (and firing `onEmpty`) once the
   * last socket for that topic is gone. Disposing twice is a no-op.
   *
   * A socket must be subscribed to a given topic at most once: membership is
   * Set-based, so a second subscribe for the same (topic, socket) pair hands
   * out a disposer aliasing the same membership, and disposing either removes
   * the socket.
   */
  subscribe(topic: TKey, ws: WebSocket, onEmpty?: () => void): () => void {
    let sockets = this.topics.get(topic);
    if (!sockets) {
      sockets = new Set();
      this.topics.set(topic, sockets);
    }
    sockets.add(ws);

    // Without this flag, a stale disposer would remove a later subscription
    // of the same socket to the same topic.
    let disposed = false;
    return () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const current = this.topics.get(topic);
      if (!current?.delete(ws)) {
        return;
      }
      if (current.size === 0) {
        this.topics.delete(topic);
        onEmpty?.();
      }
    };
  }

  subscriberCount(topic: TKey): number {
    return this.topics.get(topic)?.size ?? 0;
  }

  hasSubscribers(topic: TKey): boolean {
    return this.subscriberCount(topic) > 0;
  }

  /**
   * Live view of a topic's subscribers, for fan-outs that need per-socket
   * decisions (e.g. buffering). Do not mutate.
   */
  subscribers(topic: TKey): ReadonlySet<WebSocket> {
    return this.topics.get(topic) ?? EMPTY_SET;
  }

  /**
   * Send a payload to every subscriber of a topic. Non-string payloads are
   * serialized once. Returns the number of sockets the message was
   * successfully handed to.
   */
  broadcast(topic: TKey, payload: unknown): number {
    return this.broadcastWith(topic, payload, (ws, message) =>
      safeSend(ws, message, this.logger, this.defaultDescription)
    );
  }

  /** Channel-owned admission, with shared serialization and subscriber isolation. */
  broadcastWith(
    topic: TKey,
    payload: unknown,
    send: (ws: WebSocket, message: string) => boolean
  ): number {
    const sockets = this.topics.get(topic);
    if (!sockets || sockets.size === 0) {
      return 0;
    }

    const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
    let sent = 0;
    for (const ws of sockets) {
      if (send(ws, message)) {
        sent++;
      }
    }
    return sent;
  }

  /** Remove all subscriptions. Intended for tests. */
  clear(): void {
    this.topics.clear();
  }
}
