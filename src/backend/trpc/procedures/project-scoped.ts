import { TRPCError } from '@trpc/server';
import { middleware, publicProcedure } from '@/backend/trpc/trpc';

/**
 * Middleware that validates project context is present.
 * Requires X-Project-Id header to be set on the request.
 */
const requiresProject = middleware(({ ctx, next }) => {
  if (!ctx.projectId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Project scope required. Set X-Project-Id header.',
    });
  }

  return next({
    ctx: {
      ...ctx,
      projectId: ctx.projectId,
    },
  });
});

/**
 * Procedure that requires project context.
 * Use for endpoints that should be scoped to a specific project.
 */
export const projectScopedProcedure = publicProcedure.use(requiresProject);
