import { initTRPC, TRPCError } from '@trpc/server';
import type { Request } from 'express';
import superjson from 'superjson';
import type { AppContext } from '@/backend/app-context';
import { ApplicationError } from '@/backend/lib/application-error';
import {
  isBrowserOriginAllowed,
  isHostHeaderAllowed,
  isLoopbackBindHost,
  isLoopbackRemoteAddress,
  isTrustedLocalAddress,
} from '@/backend/lib/request-trust';
import { FORWARDED_CLIENT_ADDRESS_HEADERS } from '@/shared/proxy-utils';
import { toTRPCError } from './application-error-mapper';

export { isLoopbackRemoteAddress };

export type RequestTrustInfo = {
  remoteAddress?: string;
  origin?: string;
  /** `Host` header, checked against DNS rebinding when bound to loopback. */
  host?: string;
  /** Local port the connection arrived on: the port the server bound. */
  localPort?: number;
  isLocal: boolean;
  hasForwardedClientAddressHeaders?: boolean;
};

/** Context for tRPC procedures. */
export type Context = {
  /** Request trust metadata for privileged state-changing procedures */
  requestTrust?: RequestTrustInfo;
  /** App-level services and config */
  appContext: AppContext;
};

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function buildRequestTrust(req: Request): RequestTrustInfo {
  const remoteAddress = req.ip ?? req.socket.remoteAddress;
  return {
    remoteAddress,
    origin: getHeaderValue(req.headers.origin),
    host: req.headers.host,
    localPort: req.socket.localPort,
    isLocal: isLoopbackRemoteAddress(remoteAddress),
    hasForwardedClientAddressHeaders: FORWARDED_CLIENT_ADDRESS_HEADERS.some(
      (header) => req.headers[header] !== undefined
    ),
  };
}

/** Creates tRPC context from an Express request. */
export const createContext =
  (appContext: AppContext) =>
  ({ req }: { req: Request }): Context => ({
    requestTrust: buildRequestTrust(req),
    appContext,
  });

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const applicationError = error.cause instanceof ApplicationError ? error.cause : undefined;
    return {
      ...shape,
      data: {
        ...shape.data,
        applicationErrorKind: applicationError?.kind ?? null,
      },
    };
  },
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;

function isAllowedBrowserContext(ctx: Context): boolean {
  // In-process callers do not cross the HTTP trust boundary.
  if (!ctx.requestTrust) {
    return true;
  }

  const { configService } = ctx.appContext.services;
  const corsConfig = configService.getCorsConfig();
  // The flag already admits every Origin, so a rebound Host adds no exposure.
  if (corsConfig.disableCorsChecks) {
    return true;
  }

  const { origin, host, localPort } = ctx.requestTrust;
  if (origin !== undefined && !isBrowserOriginAllowed(origin, corsConfig, localPort)) {
    return false;
  }

  return (
    host === undefined ||
    isHostHeaderAllowed(host, corsConfig.allowedOrigins) ||
    !isLoopbackBindHost(configService.getBackendHost())
  );
}

/**
 * Applies the browser boundary WebSocket upgrades use to every HTTP procedure:
 * a request carrying an `Origin` header must come from an allowed origin, and
 * a loopback-bound server only answers loopback or allowed-origin `Host`
 * names, so neither a cross-site page nor a DNS-rebound one can call the API.
 * Clients that send no `Origin` (CLI tools, agent MCP servers, same-origin
 * GETs) are unaffected; `DISABLE_CORS_CHECKS` turns both checks off.
 */
function assertAllowedBrowserContext(ctx: Context): void {
  if (!isAllowedBrowserContext(ctx)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Requests from this browser origin are not allowed.',
    });
  }
}

const applicationErrorProcedure = t.procedure.use(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof ApplicationError) {
    throw toTRPCError(result.error.cause);
  }

  return result;
});

export const publicProcedure = applicationErrorProcedure.use(({ ctx, next }) => {
  assertAllowedBrowserContext(ctx);
  return next();
});

function isTrustedLocalContext(ctx: Context): boolean {
  // In-process callers, including tests and orchestration code using createCaller,
  // do not cross the HTTP trust boundary.
  if (!ctx.requestTrust) {
    return true;
  }

  const corsConfig = ctx.appContext.services.configService.getCorsConfig();
  // A local tunnel connects over loopback too. Match the WebSocket trust
  // boundary before allowing Origin-less clients or applying CORS overrides.
  if (ctx.requestTrust.hasForwardedClientAddressHeaders && !corsConfig.trustProxyHeaders) {
    return false;
  }

  const isLocal =
    ctx.requestTrust.isLocal ||
    isTrustedLocalAddress(ctx.requestTrust.remoteAddress, corsConfig.trustedLocalCidrs);
  if (!isLocal) {
    return false;
  }

  if (!ctx.requestTrust.origin) {
    return true;
  }

  return isBrowserOriginAllowed(ctx.requestTrust.origin, corsConfig, ctx.requestTrust.localPort);
}

/**
 * Procedure for mutations that can create workspaces, write executable config,
 * or trigger local command execution. HTTP callers must be local and use an
 * allowed browser origin when an Origin header is present. Forwarded requests
 * also require an authenticated proxy that strips client-address headers, or
 * the explicit trusted-proxy configuration.
 */
export function assertTrustedLocalContext(ctx: Context): void {
  if (!isTrustedLocalContext(ctx)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This action is only available from a trusted local Factory Factory client.',
    });
  }
}

// The trusted-local check runs first so its error explains an Origin
// rejection; the browser check then adds the DNS-rebinding Host guard.
export const trustedLocalProcedure = applicationErrorProcedure.use(({ ctx, next }) => {
  assertTrustedLocalContext(ctx);
  assertAllowedBrowserContext(ctx);
  return next();
});
