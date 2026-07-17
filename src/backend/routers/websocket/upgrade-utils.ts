import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import type { ApplicationServices } from '@/backend/app-context';
import { toError } from '@/backend/lib/error-utils';
import { isOriginAllowed, isTrustedLocalAddress } from '@/backend/lib/request-trust';
import { FORWARDED_CLIENT_ADDRESS_HEADERS } from '@/shared/proxy-utils';

type WebSocketOriginLogger = Pick<ReturnType<ApplicationServices['createLogger']>, 'warn'>;
type WebSocketUpgradeLogger = Pick<
  ReturnType<ApplicationServices['createLogger']>,
  'warn' | 'error'
>;
type WebSocketOriginConfigService = Pick<ApplicationServices['configService'], 'getCorsConfig'>;

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

export type WebSocketUpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
  wss: WebSocketServer,
  wsAliveMap: WeakMap<WebSocket, boolean>
) => void;

export interface WebSocketUpgradeOpenContext<TAuth, TParam extends string = never> {
  params: Record<TParam, string>;
  url: URL;
  request: IncomingMessage;
  /** Value returned by the `authorize` hook; `undefined` when no hook is set. */
  auth: TAuth;
}

/**
 * Build a WebSocket upgrade handler with the preamble shared by every
 * channel: origin validation, trusted-local validation, required query
 * params, an optional authorization hook, then `handleUpgrade` +
 * `markWebSocketAlive` before handing the socket to `onOpen`.
 *
 * The `authorize` hook runs after validation and before the upgrade. It may
 * return (or resolve) `null` to reject the upgrade, in which case it is
 * responsible for writing a response to the raw socket; any thrown error is
 * logged and answered with a generic 400.
 */
function extractRequiredParams<TParam extends string>(
  url: URL,
  requiredParams: readonly TParam[],
  socket: Duplex,
  logger: WebSocketUpgradeLogger,
  connectionName: string
): Record<TParam, string> | null {
  const params = {} as Record<TParam, string>;
  for (const param of requiredParams) {
    const value = url.searchParams.get(param);
    if (!value) {
      logger.warn(`${connectionName} missing ${param}`);
      sendBadRequest(socket);
      return null;
    }
    params[param] = value;
  }
  return params;
}

/**
 * Run an authorize hook, invoking `onAuthorized` with its non-null result.
 * Synchronous hooks resolve synchronously so the upgrade completes before the
 * caller returns; only genuine promises defer it.
 *
 * `undefined` results fail closed: `null` means the hook rejected and already
 * wrote a response, so an accidental `undefined` (e.g. an implicit-return
 * code path) is treated as an error rather than an authorization. Hooks that
 * need no context value should return `{}`.
 */
function runAuthorize<TAuth>(
  authorize: () => TAuth | null | Promise<TAuth | null>,
  onAuthorized: (auth: TAuth) => void,
  onError: (error: unknown) => void
): void {
  const handleResult = (auth: TAuth | null): void => {
    if (auth === null) {
      return;
    }
    if (auth === undefined) {
      onError(new Error('authorize hook returned undefined'));
      return;
    }
    onAuthorized(auth);
  };

  try {
    const result = authorize();
    if (result instanceof Promise) {
      result.then(handleResult).catch(onError);
    } else {
      handleResult(result);
    }
  } catch (error) {
    onError(error);
  }
}

export function createWebSocketUpgradeHandler<
  TAuth = undefined,
  TParam extends string = never,
>(options: {
  connectionName: string;
  configService: WebSocketOriginConfigService;
  logger: WebSocketUpgradeLogger;
  requiredParams?: readonly TParam[];
  // NonNullable in the return position makes a hook that can return
  // `undefined` a compile-time error; runAuthorize still fails closed at
  // runtime for hooks that bypass the types.
  authorize?: (context: {
    params: Record<TParam, string>;
    url: URL;
    request: IncomingMessage;
    socket: Duplex;
  }) => NonNullable<TAuth> | null | Promise<NonNullable<TAuth> | null>;
  onOpen: (ws: WebSocket, context: WebSocketUpgradeOpenContext<TAuth, TParam>) => void;
}): WebSocketUpgradeHandler {
  const { connectionName, configService, logger, requiredParams, authorize, onOpen } = options;

  return function handleUpgrade(request, socket, head, url, wss, wsAliveMap): void {
    if (!validateWebSocketOrigin({ request, socket, configService, logger, connectionName })) {
      return;
    }

    if (
      !validateTrustedLocalWebSocketRequest({
        request,
        socket,
        configService,
        logger,
        connectionName,
      })
    ) {
      return;
    }

    const params = extractRequiredParams(url, requiredParams ?? [], socket, logger, connectionName);
    if (!params) {
      return;
    }

    const upgrade = (auth: TAuth): void => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        markWebSocketAlive(ws, wsAliveMap);
        onOpen(ws, { params, url, request, auth });
      });
    };

    if (!authorize) {
      upgrade(undefined as TAuth);
      return;
    }

    runAuthorize(
      () => authorize({ params, url, request, socket }),
      upgrade,
      (error) => {
        logger.error(`Failed to authorize ${connectionName} upgrade`, toError(error));
        sendBadRequest(socket, 'Authorization failed');
      }
    );
  };
}
