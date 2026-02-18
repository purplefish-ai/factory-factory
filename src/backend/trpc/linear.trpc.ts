import { z } from 'zod';
import { linearClientService } from '@/backend/domains/linear';
import { projectManagementService } from '@/backend/domains/workspace';
import { cryptoService } from '@/backend/services/crypto.service';
import { IssueTrackerConfigSchema } from '@/shared/schemas/issue-tracker-config.schema';
import { publicProcedure, router } from './trpc';

/** Look up a project's Linear config and decrypt the API key. Returns null if not configured. */
function getLinearConfig(project: { issueTrackerConfig: unknown }) {
  const parsed = IssueTrackerConfigSchema.safeParse(project.issueTrackerConfig);
  if (!(parsed.success && parsed.data.linear)) {
    return null;
  }
  const { linear } = parsed.data;
  return {
    apiKey: cryptoService.decrypt(linear.apiKey),
    teamId: linear.teamId,
  };
}

export const linearRouter = router({
  /** Validate a Linear API key and list accessible teams in one round-trip. */
  validateKeyAndListTeams: publicProcedure
    .input(z.object({ apiKey: z.string().min(1) }))
    .mutation(({ input }) => {
      return linearClientService.validateKeyAndListTeams(input.apiKey);
    }),

  /** List issues assigned to the current user for a project's configured Linear team. */
  listIssuesForProject: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const project = await projectManagementService.findById(input.projectId);
      if (!project) {
        return { issues: [], error: 'Project not found' };
      }

      const config = getLinearConfig(project);
      if (!config) {
        return { issues: [], error: 'Linear not configured for this project' };
      }

      try {
        const issues = await linearClientService.listMyIssues(config.apiKey, config.teamId);
        return { issues, error: null };
      } catch (err) {
        return {
          issues: [],
          error: err instanceof Error ? err.message : 'Failed to fetch Linear issues',
        };
      }
    }),

  /** Get detailed information for a specific Linear issue. */
  getIssue: publicProcedure
    .input(z.object({ projectId: z.string(), issueId: z.string() }))
    .query(async ({ input }) => {
      const project = await projectManagementService.findById(input.projectId);
      if (!project) {
        return { issue: null, error: 'Project not found' };
      }

      const config = getLinearConfig(project);
      if (!config) {
        return { issue: null, error: 'Linear not configured for this project' };
      }

      try {
        const issue = await linearClientService.getIssue(config.apiKey, input.issueId);
        return { issue, error: null };
      } catch (err) {
        return {
          issue: null,
          error: err instanceof Error ? err.message : 'Failed to fetch Linear issue',
        };
      }
    }),
});
