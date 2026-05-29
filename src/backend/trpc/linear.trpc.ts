import { z } from 'zod';
import { cryptoService } from '@/backend/services/crypto.service';
import { linearClientService } from '@/backend/services/linear';
import { projectManagementService, workspaceDataService } from '@/backend/services/workspace';
import { WorkspaceStatus } from '@/shared/core';
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

function filterIssuesLinkedToActiveWorkspaces<TIssue extends { id: string }>(
  issues: TIssue[],
  workspaces: Array<{
    linearIssueId: string | null;
    status: WorkspaceStatus;
  }>
): TIssue[] {
  const linkedIssueIds = new Set(
    workspaces
      .filter(
        (workspace) =>
          workspace.status !== WorkspaceStatus.ARCHIVING &&
          workspace.status !== WorkspaceStatus.ARCHIVED
      )
      .map((workspace) => workspace.linearIssueId)
      .filter((issueId): issueId is string => issueId !== null)
  );

  if (linkedIssueIds.size === 0) {
    return issues;
  }

  return issues.filter((issue) => !linkedIssueIds.has(issue.id));
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
        const [issues, workspaces] = await Promise.all([
          linearClientService.listMyIssues(config.apiKey, config.teamId),
          workspaceDataService.findByProjectId(input.projectId),
        ]);
        return { issues: filterIssuesLinkedToActiveWorkspaces(issues, workspaces), error: null };
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
