import { adminRouter } from './admin.trpc';
import { adversarialReviewRouter } from './adversarial-review.trpc';
import { agentRouter } from './agent.trpc';
import { closedSessionsRouter } from './closed-sessions.trpc';
import { codexAccountsRouter } from './codex-accounts.trpc';
import { decisionLogRouter } from './decision-log.trpc';
import { githubRouter } from './github.trpc';
import { linearRouter } from './linear.trpc';
import { periodicTaskRouter } from './periodic-task.trpc';
import { prReviewRouter } from './pr-review.trpc';
import { projectRouter } from './project.trpc';
import { searchRouter } from './search.trpc';
import { sessionRouter } from './session.trpc';
import { slackRouter } from './slack.trpc';
import { router } from './trpc';
import { userSettingsRouter } from './user-settings.trpc';
import { voiceRouter } from './voice.trpc';
import { workspaceRouter } from './workspace.trpc';

export const appRouter = router({
  agent: agentRouter,
  project: projectRouter,
  decisionLog: decisionLogRouter,
  admin: adminRouter,
  adversarialReview: adversarialReviewRouter,
  workspace: workspaceRouter,
  session: sessionRouter,
  codexAccounts: codexAccountsRouter,
  search: searchRouter,
  closedSessions: closedSessionsRouter,
  prReview: prReviewRouter,
  userSettings: userSettingsRouter,
  github: githubRouter,
  linear: linearRouter,
  periodicTask: periodicTaskRouter,
  voice: voiceRouter,
  slack: slackRouter,
});

// Export type for use in frontend
export type AppRouter = typeof appRouter;

// Re-export context and procedure helpers
export { createContext, publicProcedure } from './trpc';
