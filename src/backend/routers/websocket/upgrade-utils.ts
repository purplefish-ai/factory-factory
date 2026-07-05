import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';
import type { AppServices } from '@/backend/app-context';
import { isOriginAllowed, isTrustedLocalAddress } from '@/backend/lib/request-trust';

type WebSocketOriginLogger = Pick<ReturnType<AppServices['createLogger']>, 'warn'>;
type WebSocketOriginConfigService = Pick<AppServices['configService'], 'getCorsConfig'>;

const FORWARDED_CLIENT_ADDRESS_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-real-ip',
  'x-client-ip',
  'cf-connecting-ip',
  'true-client-ip',
] as const;

function getForwardedClientAddressHeaders(request: IncomingMessage): string[] {
  return FORWARDED_CLIENT_ADDRESS_HEADERS.filter((header) => request.headers[header] !== undefined);
}

export function sendBadRequest(socket: Duplex, message?: string): void {
  const body = message ? `\r\n\r\n${message}` : '\r\n\r\n';
  socket.write(`HTTP/1.1 400 Bad Request${body}`);
  socket.destroy();
}

export function sendForbidden(socket: Duplex, message?: string): void {
  const body = message ? `\r\n\r\n${message}` : '\r\n\r\n';
  socket.write(`HTTP/1.1 403 Forbidden${body}`);
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
  const corsConfig = configService.getCorsConfig();
  if (corsConfig.disabled) {
    return true;
  }

  const origin = request.headers?.origin;
  if (!origin) {
    logger.warn(`Rejected ${connectionName} connection without Origin header`);
    sendBadRequest(socket, 'Missing Origin header');
    return false;
  }

  if (!isOriginAllowed(origin, corsConfig.allowedOrigins)) {
    logger.warn(`Rejected ${connectionName} connection from unauthorized origin`, { origin });
    sendBadRequest(socket, 'Unauthorized origin');
    return false;
  }

  return true;
}

export function validateTrustedLocalWebSocketRequest({
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
  const remoteAddress = request.socket.remoteAddress;
  const corsConfig = configService.getCorsConfig();
  if (!isTrustedLocalAddress(remoteAddress, corsConfig.trustedLocalCidrs)) {
    logger.warn(`Rejected ${connectionName} connection from untrusted remote address`, {
      remoteAddress,
    });
    sendForbidden(socket, 'Untrusted remote address');
    return false;
  }

  const forwardedClientAddressHeaders = getForwardedClientAddressHeaders(request);
  if (forwardedClientAddressHeaders.length > 0) {
    logger.warn(`Rejected ${connectionName} connection with forwarded client address headers`, {
      forwardedClientAddressHeaders,
      remoteAddress,
    });
    sendForbidden(socket, 'Forwarded WebSocket upgrades are not trusted');
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
