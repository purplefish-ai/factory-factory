import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';
import type { AppServices } from '@/backend/app-context';
import { isOriginAllowed } from '@/backend/lib/request-trust';

type WebSocketOriginLogger = Pick<ReturnType<AppServices['createLogger']>, 'warn'>;
type WebSocketOriginConfigService = Pick<AppServices['configService'], 'getCorsConfig'>;

export function sendBadRequest(socket: Duplex, message?: string): void {
  const body = message ? `\r\n\r\n${message}` : '\r\n\r\n';
  socket.write(`HTTP/1.1 400 Bad Request${body}`);
  socket.destroy();
}

export function validateWebSocketOrigin({
  request,
  socket,
  configService,
  logger,
  connectionName,
}: {
  request: IncomingMessage;
  socket: Duplex;
  configService: WebSocketOriginConfigService;
  logger: WebSocketOriginLogger;
  connectionName: string;
}): boolean {
  const origin = request.headers?.origin;
  if (!origin) {
    logger.warn(`Rejected ${connectionName} connection without Origin header`);
    sendBadRequest(socket, 'Missing Origin header');
    return false;
  }

  const allowedOrigins = configService.getCorsConfig().allowedOrigins;
  if (!isOriginAllowed(origin, allowedOrigins)) {
    logger.warn(`Rejected ${connectionName} connection from unauthorized origin`, { origin });
    sendBadRequest(socket, 'Unauthorized origin');
    return false;
  }

  return true;
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
