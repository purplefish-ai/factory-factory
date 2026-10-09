/**
 * GitHub tRPC Router
 *
 * Provides operations for GitHub issue integration.
 */

import { z } from 'zod';
import { classifyGitHubCLIError, type GitHubCLIHealthStatus } from '@/backend/services/github';
import { filterIssuesLinkedToActiveWorkspaces } from './issue-filter';
import { publicProcedure, router } from './trpc';

const GITHUB_AUTH_REQUIRED_MESSAGE =
  'GitHub CLI authentication failed. Run `gh auth refresh -h github.com` or `gh auth login` to authenticate.';

function buildAuthRequiredHealth(health: GitHubCLIHealthStatus): GitHubCLIHealthStatus {
  return {
    ...health,
    isInstalled: true,
    isAuthenticated: false,
    error: GITHUB_AUTH_REQUIRED_MESSAGE,
    errorType: 'auth_required',
  };
}

export const githubRouter = router({
  /**
   * List open issues assigned to the current user for a project's repository.
   * Used by the Kanban board to populate the Issues column.
   */
  listIssuesForProject: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { githubCLIService, projectManagementService, workspaceDataService } =
        ctx.appContext.services;
      // Check GitHub health first
      const health = await githubCLIService.checkHealth();
      if (!(health.isInstalled && health.isAuthenticated)) {
        return { issues: [], health, error: null };
      }

      // Get project to access githubOwner/githubRepo
      const project = await projectManagementService.findById(input.projectId);
      if (!project) {
        return { issues: [], health, error: 'Project not found' };
      }

      const { githubOwner, githubRepo } = project;
      if (!(githubOwner && githubRepo)) {
        return {
          issues: [],
          health,
          error: 'Project is not linked to a GitHub repository',
        };
      }

      try {
        // Only fetch issues assigned to the current user (@me)
        const [issues, workspaces] = await Promise.all([
          githubCLIService.listIssues(githubOwner, githubRepo, {
            assignee: '@me',
          }),
          workspaceDataService.findByProjectId(input.projectId),
        ]);
        return {
          issues: filterIssuesLinkedToActiveWorkspaces(
            issues,
            workspaces,
            (workspace) => workspace.githubIssueNumber,
            (issue) => issue.number
          ),
          health,
          error: null,
        };
      } catch (err) {
        if (classifyGitHubCLIError(err) === 'auth_required') {
          return {
            issues: [],
            health: buildAuthRequiredHealth(health),
            error: GITHUB_AUTH_REQUIRED_MESSAGE,
          };
        }

        return {
          issues: [],
          health,
          error: err instanceof Error ? err.message : 'Failed to fetch issues',
        };
      }
    }),

  /**
   * Get detailed information for a specific GitHub issue.
   * Used by the Kanban board to show issue details in the side panel.
   */
  getIssue: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        issueNumber: z.number(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { githubCLIService, projectManagementService } = ctx.appContext.services;
      // Get project to access githubOwner/githubRepo
      const project = await projectManagementService.findById(input.projectId);
      if (!project) {
        return { issue: null, error: 'Project not found' };
      }

      const { githubOwner, githubRepo } = project;
      if (!(githubOwner && githubRepo)) {
        return {
          issue: null,
          error: 'Project is not linked to a GitHub repository',
        };
      }

      try {
        const issue = await githubCLIService.getIssue(githubOwner, githubRepo, input.issueNumber);
        return { issue, error: null };
      } catch (err) {
        return {
          issue: null,
          error: err instanceof Error ? err.message : 'Failed to fetch issue',
        };
      }
    }),
});
