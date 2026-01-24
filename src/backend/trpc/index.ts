import { adminRouter } from './admin.trpc.js';
import { agentRouter } from './agent.trpc.js';
import { decisionLogRouter } from './decision-log.trpc.js';
import { mailRouter } from './mail.trpc.js';
import { projectRouter } from './project.trpc.js';
import { taskRouter } from './task.trpc.js';
import { router } from './trpc.js';

export const appRouter = router({
  project: projectRouter,
  task: taskRouter,
  agent: agentRouter,
  mail: mailRouter,
  decisionLog: decisionLogRouter,
  admin: adminRouter,
});

// Export type for use in frontend
export type AppRouter = typeof appRouter;

export { projectScopedProcedure } from './procedures/index.js';
// Re-export context and procedure helpers
export { createContext, publicProcedure } from './trpc.js';
