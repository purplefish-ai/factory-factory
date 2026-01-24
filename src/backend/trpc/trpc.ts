import { initTRPC } from '@trpc/server';
import type { Request } from 'express';
import superjson from 'superjson';

/**
 * Context for tRPC procedures.
 * Contains optional project/epic scoping from request headers.
 */
export type Context = {
  /** Project ID from X-Project-Id header */
  projectId?: string;
  /** Epic ID from X-Epic-Id header */
  epicId?: string;
};

/**
 * Creates tRPC context from Express request.
 * Extracts project and epic scope from headers.
 */
export const createContext = ({ req }: { req: Request }): Context => {
  const projectId = req.headers['x-project-id'];
  const epicId = req.headers['x-epic-id'];

  return {
    projectId: typeof projectId === 'string' ? projectId : undefined,
    epicId: typeof epicId === 'string' ? epicId : undefined,
  };
};

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;
