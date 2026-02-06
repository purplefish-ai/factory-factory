/**
 * Plan tRPC Router
 *
 * Endpoints for reading plan file content and creating tickets from plans.
 */

import { z } from 'zod';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { planFileService } from '../services/plan-file.service';
import { ticketService } from '../services/ticket.service';
import { publicProcedure, router } from './trpc';

export const planRouter = router({
  /**
   * Get the plan content for a session.
   * Reads the plan file from disk using the session's planFilePath.
   */
  getPlanContent: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input }) => {
      const session = await claudeSessionAccessor.findById(input.sessionId);
      if (!session?.planFilePath) {
        return null;
      }

      const worktreePath = session.workspace?.worktreePath;
      if (!worktreePath) {
        return null;
      }

      return planFileService.getPlanContent(worktreePath, session.planFilePath);
    }),

  /**
   * List existing plan files in a workspace's planning/ directory.
   */
  listPlanFiles: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const workspace = await workspaceAccessor.findById(input.workspaceId);
      if (!workspace?.worktreePath) {
        return [];
      }

      return planFileService.listPlanFiles(workspace.worktreePath);
    }),

  /**
   * Create a GitHub issue from plan content.
   */
  createTicket: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        title: z.string().min(1),
        body: z.string(),
        labels: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const workspace = await workspaceAccessor.findById(input.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${input.workspaceId}`);
      }

      const project = await import('../db').then(({ prisma }) =>
        prisma.project.findUnique({ where: { id: workspace.projectId } })
      );

      if (!(project?.githubOwner && project?.githubRepo)) {
        throw new Error('Project does not have GitHub owner/repo configured');
      }

      return ticketService.createIssue({
        owner: project.githubOwner,
        repo: project.githubRepo,
        title: input.title,
        body: input.body,
        labels: input.labels,
      });
    }),
});
