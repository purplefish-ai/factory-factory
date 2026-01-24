import { TRPCError } from '@trpc/server';
import { middleware, publicProcedure } from '../trpc.js';

/**
 * Middleware that validates top-level task context is present.
 * Requires X-Top-Level-Task-Id header to be set on the request.
 * Also validates that project context is present (top-level tasks belong to projects).
 */
const requiresTopLevelTask = middleware(({ ctx, next }) => {
  if (!ctx.projectId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Project scope required. Set X-Project-Id header.',
    });
  }

  if (!ctx.topLevelTaskId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Top-level task scope required. Set X-Top-Level-Task-Id header.',
    });
  }

  return next({
    ctx: {
      ...ctx,
      projectId: ctx.projectId,
      topLevelTaskId: ctx.topLevelTaskId,
    },
  });
});

/**
 * Procedure that requires top-level task context.
 * Use for endpoints that should be scoped to a specific top-level task.
 */
export const topLevelTaskScopedProcedure = publicProcedure.use(requiresTopLevelTask);
