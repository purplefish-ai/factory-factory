import { adminRouter } from './admin.trpc';
import { decisionLogRouter } from './decision-log.trpc';
import { prReviewRouter } from './pr-review.trpc';
import { projectRouter } from './project.trpc';
import { sessionRouter } from './session.trpc';
import { router } from './trpc';
import { userSettingsRouter } from './user-settings.trpc';
import { workspaceRouter } from './workspace.trpc';

export const appRouter = router({
  project: projectRouter,
  decisionLog: decisionLogRouter,
  admin: adminRouter,
  workspace: workspaceRouter,
  session: sessionRouter,
  prReview: prReviewRouter,
  userSettings: userSettingsRouter,
});

// Export type for use in frontend
export type AppRouter = typeof appRouter;

export { projectScopedProcedure } from './procedures/index';
// Re-export context and procedure helpers
export { createContext, publicProcedure } from './trpc';
