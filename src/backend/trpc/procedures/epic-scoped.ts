import { TRPCError } from '@trpc/server';
import { middleware, publicProcedure } from '../trpc.js';

/**
 * Middleware that validates top-level task (epic) context is present.
 * Requires X-Epic-Id header to be set on the request.
 * Also validates that project context is present (top-level tasks belong to projects).
 *
 * Note: "Epic" is now a top-level Task (parentId = null) in the unified Task model.
 * The header name is kept as X-Epic-Id for backward compatibility.
 */
const requiresTopLevelTask = middleware(({ ctx, next }) => {
  if (!ctx.projectId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Project scope required. Set X-Project-Id header.',
    });
  }

  if (!ctx.epicId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Top-level task (epic) scope required. Set X-Epic-Id header.',
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
 * Procedure that requires top-level task (epic) context.
 * Use for endpoints that should be scoped to a specific top-level task.
 *
 * @deprecated Use topLevelTaskScopedProcedure instead. This alias is kept for backward compatibility.
 */
export const epicScopedProcedure = publicProcedure.use(requiresTopLevelTask);

/**
 * Procedure that requires top-level task context.
 * Use for endpoints that should be scoped to a specific top-level task (formerly called "epic").
 */
export const topLevelTaskScopedProcedure = epicScopedProcedure;
