import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { publicProcedure, router, trustedLocalProcedure } from '@/backend/trpc/trpc';

export const workspaceChildrenRouter = router({
  createChild: trustedLocalProcedure
    .input(
      z.object({
        parentWorkspaceId: z.string(),
        projectId: z.string(),
        name: z.string().min(1),
        description: z.string().optional(),
        initialPrompt: z.string().optional(),
        reportBackOn: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const workspaceId = await ctx.appContext.services.createChildWorkspace(input);
      return { workspaceId };
    }),

  listChildren: publicProcedure
    .input(z.object({ parentWorkspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { workspaceRelationshipsService } = ctx.appContext.services;
      const children = await workspaceRelationshipsService.findChildrenWithStatus(
        input.parentWorkspaceId
      );
      return children.map((child) => ({
        id: child.id,
        name: child.name,
        description: child.description,
        status: child.status,
        prState: child.prState,
        prUrl: child.prUrl,
        cachedKanbanColumn: child.cachedKanbanColumn,
        projectId: child.projectId,
        projectName: child.project.name,
        projectSlug: child.project.slug,
        createdAt: child.createdAt,
      }));
    }),

  getParent: publicProcedure
    .input(z.object({ childWorkspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { workspaceRelationshipsService } = ctx.appContext.services;
      const parent = await workspaceRelationshipsService.findParent(input.childWorkspaceId);
      if (!parent) {
        return null;
      }
      return {
        id: parent.id,
        name: parent.name,
        projectId: parent.projectId,
        projectName: parent.project.name,
        projectSlug: parent.project.slug,
      };
    }),

  sendMessageToParent: publicProcedure
    .input(
      z.object({
        childWorkspaceId: z.string(),
        message: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { deliverWorkspaceNotification, workspaceDataService } = ctx.appContext.services;
      const child = await workspaceDataService.findByIdWithProject(input.childWorkspaceId);
      if (!child) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Workspace not found: ${input.childWorkspaceId}`,
        });
      }
      if (!child.parentWorkspaceId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This workspace has no parent',
        });
      }

      return deliverWorkspaceNotification({
        direction: 'CHILD_TO_PARENT',
        targetWorkspaceId: child.parentWorkspaceId,
        sourceWorkspace: {
          id: child.id,
          name: child.name,
          projectName: child.project.name,
        },
        message: input.message,
        buildUiEvent: ({ sourceWorkspace, message, timestamp }) => ({
          type: 'child_workspace_update',
          childWorkspaceId: sourceWorkspace.id,
          childWorkspaceName: sourceWorkspace.name,
          childProjectName: sourceWorkspace.projectName,
          text: message,
          timestamp,
        }),
      });
    }),

  sendMessageToChild: publicProcedure
    .input(
      z.object({
        parentWorkspaceId: z.string(),
        childWorkspaceId: z.string(),
        message: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { deliverWorkspaceNotification, workspaceDataService } = ctx.appContext.services;
      const child = await workspaceDataService.findByIdWithProject(input.childWorkspaceId);
      if (!child) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Workspace not found: ${input.childWorkspaceId}`,
        });
      }
      if (child.parentWorkspaceId !== input.parentWorkspaceId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'The specified child workspace does not belong to this parent',
        });
      }

      const parent = await workspaceDataService.findByIdWithProject(input.parentWorkspaceId);
      if (!parent) {
        return { delivered: false };
      }

      return deliverWorkspaceNotification({
        direction: 'PARENT_TO_CHILD',
        targetWorkspaceId: child.id,
        sourceWorkspace: {
          id: parent.id,
          name: parent.name,
          projectName: parent.project.name,
        },
        message: input.message,
        buildUiEvent: ({ sourceWorkspace, message, timestamp }) => ({
          type: 'parent_workspace_update',
          parentWorkspaceId: sourceWorkspace.id,
          parentWorkspaceName: sourceWorkspace.name,
          parentProjectName: sourceWorkspace.projectName,
          text: message,
          timestamp,
        }),
      });
    }),

  archiveChild: publicProcedure
    .input(
      z.object({
        parentWorkspaceId: z.string(),
        childWorkspaceId: z.string(),
        commitUncommitted: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { archiveWorkspace, workspaceDataService } = ctx.appContext.services;
      const child = await workspaceDataService.findByIdWithProject(input.childWorkspaceId);
      if (!child) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Workspace not found: ${input.childWorkspaceId}`,
        });
      }
      if (child.parentWorkspaceId !== input.parentWorkspaceId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'The specified child workspace does not belong to this parent',
        });
      }
      return archiveWorkspace(
        child,
        { commitUncommitted: input.commitUncommitted ?? true },
        ctx.appContext.services
      );
    }),

  getPendingNotificationCount: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(({ ctx, input }) =>
      ctx.appContext.services.workspaceNotificationService.countPending(input.workspaceId)
    ),
});
