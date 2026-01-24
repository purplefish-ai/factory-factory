import { initTRPC } from '@trpc/server';
import superjson from 'superjson';

// Context for tRPC procedures
export type Context = Record<string, never>;

export const createContext = (): Context => {
  return {} as Context;
};

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;
