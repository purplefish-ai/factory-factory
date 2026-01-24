import { initTRPC } from '@trpc/server';
import type { Request } from 'express';
import superjson from 'superjson';

/**
 * Context for tRPC procedures.
 * Contains optional project/top-level task scoping from request headers.
 */
type Context = {
  /** Project ID from X-Project-Id header */
  projectId?: string;
  /** Top-level Task ID from X-Top-Level-Task-Id header */
  topLevelTaskId?: string;
};

/**
 * Creates tRPC context from Express request.
 * Extracts project and top-level task scope from headers.
 */
export const createContext = ({ req }: { req: Request }): Context => {
  const projectId = req.headers['x-project-id'];
  const topLevelTaskId = req.headers['x-top-level-task-id'];

  return {
    projectId: typeof projectId === 'string' ? projectId : undefined,
    topLevelTaskId: typeof topLevelTaskId === 'string' ? topLevelTaskId : undefined,
  };
};

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;
