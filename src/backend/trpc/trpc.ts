import { initTRPC } from '@trpc/server';
import superjson from 'superjson';

// Context for tRPC procedures
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Context {
  // Future: add user auth context here
}

export const createContext = (): Context => {
  return {};
};

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;
