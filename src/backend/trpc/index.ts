import { adminRouter } from './admin.trpc.js';
import { decisionLogRouter } from './decision-log.trpc.js';
import { projectRouter } from './project.trpc.js';
import { sessionRouter } from './session.trpc.js';
import { router } from './trpc.js';
import { workspaceRouter } from './workspace.trpc.js';

export const appRouter = router({
  project: projectRouter,
  decisionLog: decisionLogRouter,
  admin: adminRouter,
  workspace: workspaceRouter,
  session: sessionRouter,
});

// Export type for use in frontend
export type AppRouter = typeof appRouter;

export { projectScopedProcedure } from './procedures/index.js';
// Re-export context and procedure helpers
export { createContext, publicProcedure } from './trpc.js';
