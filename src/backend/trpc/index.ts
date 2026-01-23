import { router } from './trpc';
import { epicRouter } from './epic.trpc';
import { taskRouter } from './task.trpc';
import { agentRouter } from './agent.trpc';
import { mailRouter } from './mail.trpc';
import { decisionLogRouter } from './decision-log.trpc';

export const appRouter = router({
  epic: epicRouter,
  task: taskRouter,
  agent: agentRouter,
  mail: mailRouter,
  decisionLog: decisionLogRouter,
});

// Export type for use in frontend
export type AppRouter = typeof appRouter;

// Re-export context and procedure helpers
export { createContext } from './trpc';
