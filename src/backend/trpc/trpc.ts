import { initTRPC, TRPCError } from '@trpc/server';
import type { Request } from 'express';
import superjson from 'superjson';
import type { AppContext } from '@/backend/app-context';
import { ApplicationError } from '@/backend/lib/application-error';
import {
  isLoopbackRemoteAddress,
  isOriginAllowed,
  isTrustedLocalAddress,
} from '@/backend/lib/request-trust';
import { toTRPCError } from './application-error-mapper';

export { isLoopbackRemoteAddress };

export type RequestTrustInfo = {
  remoteAddress?: string;
  origin?: string;
  isLocal: boolean;
};

/**
 * Context for tRPC procedures.
 * Contains optional project/top-level task scoping from request headers.
 */
export type Context = {
  /** Project ID from X-Project-Id header */
  projectId?: string;
  /** Top-level Task ID from X-Top-Level-Task-Id header */
  topLevelTaskId?: string;
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

/**
 * Creates tRPC context from Express request.
 * Extracts project and top-level task scope from headers.
 */
export const createContext =
  (appContext: AppContext) =>
  ({ req }: { req: Request }): Context => {
    const projectId = req.headers['x-project-id'];
    const topLevelTaskId = req.headers['x-top-level-task-id'];

    return {
      projectId: typeof projectId === 'string' ? projectId : undefined,
      topLevelTaskId: typeof topLevelTaskId === 'string' ? topLevelTaskId : undefined,
      requestTrust: buildRequestTrust(req),
      appContext,
    };
  };

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const middleware = t.middleware;

export const publicProcedure = t.procedure.use(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof ApplicationError) {
    throw toTRPCError(result.error.cause);
  }

  return result;
});

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
