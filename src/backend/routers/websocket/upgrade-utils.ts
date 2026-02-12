import type { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';

export function sendBadRequest(socket: Duplex, message?: string): void {
  const body = message ? `\r\n\r\n${message}` : '\r\n\r\n';
  socket.write(`HTTP/1.1 400 Bad Request${body}`);
  socket.destroy();
}

export function markWebSocketAlive(ws: WebSocket, wsAliveMap: WeakMap<WebSocket, boolean>): void {
  wsAliveMap.set(ws, true);
  ws.on('pong', () => wsAliveMap.set(ws, true));
}

export function getOrCreateConnectionSet<TKey>(
  map: Map<TKey, Set<WebSocket>>,
  key: TKey
): Set<WebSocket> {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }

  const created = new Set<WebSocket>();
  map.set(key, created);
  return created;
}
