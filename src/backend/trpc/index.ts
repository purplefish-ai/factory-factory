import { adminRouter } from './admin.trpc';
import { agentRouter } from './agent.trpc';
import { decisionLogRouter } from './decision-log.trpc';
import { epicRouter } from './epic.trpc';
import { mailRouter } from './mail.trpc';
import { projectRouter } from './project.trpc';
import { taskRouter } from './task.trpc';
import { router } from './trpc';

export const appRouter = router({
  project: projectRouter,
  epic: epicRouter,
  task: taskRouter,
  agent: agentRouter,
  mail: mailRouter,
  decisionLog: decisionLogRouter,
  admin: adminRouter,
});

// Export type for use in frontend
export type AppRouter = typeof appRouter;

export {
  epicScopedProcedure,
  projectScopedProcedure,
  topLevelTaskScopedProcedure,
} from './procedures/index.js';
// Re-export context and procedure helpers
export { createContext, publicProcedure } from './trpc';
