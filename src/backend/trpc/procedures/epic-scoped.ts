import { TRPCError } from '@trpc/server';
import { middleware, publicProcedure } from '../trpc.js';

/**
 * Middleware that validates epic context is present.
 * Requires X-Epic-Id header to be set on the request.
 * Also validates that project context is present (epics belong to projects).
 */
const requiresEpic = middleware(({ ctx, next }) => {
  if (!ctx.projectId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Project scope required. Set X-Project-Id header.',
    });
  }

  if (!ctx.epicId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Epic scope required. Set X-Epic-Id header.',
    });
  }

  return next({
    ctx: {
      ...ctx,
      projectId: ctx.projectId,
      epicId: ctx.epicId,
    },
  });
});

/**
 * Procedure that requires epic context.
 * Use for endpoints that should be scoped to a specific epic.
 */
export const epicScopedProcedure = publicProcedure.use(requiresEpic);
