/**
 * GitHub tRPC Router
 *
 * Provides operations for GitHub issue integration.
 */

import { z } from 'zod';
import { githubCLIService } from '../services/github-cli.service';
import { projectManagementService } from '../services/project-management.service';
import { workspaceDataService } from '../services/workspace-data.service';
import { publicProcedure, router } from './trpc';

export const githubRouter = router({
  /**
   * Check if GitHub CLI is installed and authenticated.
   */
  checkHealth: publicProcedure.query(() => {
    return githubCLIService.checkHealth();
  }),

  /**
   * Check if a workspace's project has GitHub repo configured.
   * Used to conditionally show the "Link GitHub Issue" button.
   */
  hasGitHubRepo: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const workspace = await workspaceDataService.findByIdWithProject(input.workspaceId);
      if (!workspace?.project) {
        return false;
      }
      return !!(workspace.project.githubOwner && workspace.project.githubRepo);
    }),

  /**
   * List open issues for a workspace's associated repository.
   * Returns empty array if:
   * - GitHub CLI not authenticated
   * - Project doesn't have githubOwner/githubRepo configured
   */
  listIssuesForWorkspace: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      // Check GitHub health first
      const health = await githubCLIService.checkHealth();
      if (!(health.isInstalled && health.isAuthenticated)) {
        return { issues: [], health, error: null, authenticatedUser: null };
      }

      // Get the authenticated username for filtering
      const authenticatedUser = await githubCLIService.getAuthenticatedUsername();

      // Get workspace with project to access githubOwner/githubRepo
      const workspace = await workspaceDataService.findByIdWithProject(input.workspaceId);
      if (!workspace?.project) {
        return { issues: [], health, error: 'Workspace or project not found', authenticatedUser };
      }

      const { githubOwner, githubRepo } = workspace.project;
      if (!(githubOwner && githubRepo)) {
        return {
          issues: [],
          health,
          error: 'Project is not linked to a GitHub repository',
          authenticatedUser,
        };
      }

      try {
        const issues = await githubCLIService.listIssues(githubOwner, githubRepo, {});
        return { issues, health, error: null, authenticatedUser };
      } catch (err) {
        return {
          issues: [],
          health,
          error: err instanceof Error ? err.message : 'Failed to fetch issues',
          authenticatedUser,
        };
      }
    }),

  /**
   * List open issues assigned to the current user for a project's repository.
   * Used by the Kanban board to populate the Issues column.
   */
  listIssuesForProject: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
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
        const issues = await githubCLIService.listIssues(githubOwner, githubRepo, {
          assignee: '@me',
        });
        return { issues, health, error: null };
      } catch (err) {
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
    .query(async ({ input }) => {
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
