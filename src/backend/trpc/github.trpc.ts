/**
 * GitHub tRPC Router
 *
 * Provides operations for GitHub issue integration.
 */

import { z } from 'zod';
import { projectAccessor } from '../resource_accessors/project.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { githubCLIService } from '../services/github-cli.service';
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
      const workspace = await workspaceAccessor.findByIdWithProject(input.workspaceId);
      if (!workspace?.project) {
        return false;
      }
      return !!(workspace.project.githubOwner && workspace.project.githubRepo);
    }),

  /**
   * Check if a project has GitHub repo configured.
   * Used to conditionally show the "From GitHub Issues" option in workspace creation.
   */
  hasGitHubRepoForProject: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const project = await projectAccessor.findById(input.projectId);
      if (!project) {
        return false;
      }
      return !!(project.githubOwner && project.githubRepo);
    }),

  /**
   * List open issues for a project's associated repository.
   * Returns empty array if:
   * - GitHub CLI not authenticated
   * - Project doesn't have githubOwner/githubRepo configured
   */
  listIssuesForProject: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      // Check GitHub health first
      const health = await githubCLIService.checkHealth();
      if (!(health.isInstalled && health.isAuthenticated)) {
        return { issues: [], health, error: null, authenticatedUser: null };
      }

      // Get the authenticated username for filtering
      const authenticatedUser = await githubCLIService.getAuthenticatedUsername();

      // Get project to access githubOwner/githubRepo
      const project = await projectAccessor.findById(input.projectId);
      if (!project) {
        return { issues: [], health, error: 'Project not found', authenticatedUser };
      }

      const { githubOwner, githubRepo } = project;
      if (!(githubOwner && githubRepo)) {
        return {
          issues: [],
          health,
          error: 'Project is not linked to a GitHub repository',
          authenticatedUser,
        };
      }

      try {
        const issues = await githubCLIService.listIssues(githubOwner, githubRepo);
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
      const workspace = await workspaceAccessor.findByIdWithProject(input.workspaceId);
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
        const issues = await githubCLIService.listIssues(githubOwner, githubRepo);
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
});
