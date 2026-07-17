import { initTRPC, TRPCError } from '@trpc/server';
import type { Request } from 'express';
import superjson from 'superjson';
import type { AppContext } from '@/backend/app-context';
import {
  isLoopbackRemoteAddress,
  isOriginAllowed,
  isTrustedLocalAddress,
} from '@/backend/lib/request-trust';

export { isLoopbackRemoteAddress };

export type RequestTrustInfo = {
  remoteAddress?: string;
  origin?: string;
  isLocal: boolean;
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
    isLocal: isLoopbackRemoteAddress(remoteAddress),
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
});

export const router = t.router;
export const publicProcedure = t.procedure;

function isTrustedLocalContext(ctx: Context): boolean {
  // In-process callers, including tests and orchestration code using createCaller,
  // do not cross the HTTP trust boundary.
  if (!ctx.requestTrust) {
    return true;
  }

  const corsConfig = ctx.appContext.services.configService.getCorsConfig();
  const isLocal =
    ctx.requestTrust.isLocal ||
    isTrustedLocalAddress(ctx.requestTrust.remoteAddress, corsConfig.trustedLocalCidrs);
  if (!isLocal) {
    return false;
  }

  if (!ctx.requestTrust.origin) {
    return true;
  }

  return isOriginAllowed(ctx.requestTrust.origin, corsConfig.allowedOrigins);
}

/**
 * Procedure for mutations that can create workspaces, write executable config,
 * or trigger local command execution. HTTP callers must be local and use an
 * allowed browser origin when an Origin header is present.
 */
export const trustedLocalProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!isTrustedLocalContext(ctx)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This action is only available from a trusted local Factory Factory client.',
    });
  }

  return next();
});
