import { TaskState } from '@prisma-gen/client';
import { z } from 'zod';
import { inngest } from '../inngest/client.js';
import { taskAccessor } from '../resource_accessors/task.accessor.js';
import { projectScopedProcedure } from './procedures/project-scoped.js';
import { publicProcedure, router } from './trpc.js';

export const taskRouter = router({
  // List all tasks with optional filtering (scoped to project from context)
  list: projectScopedProcedure
    .input(
      z
        .object({
          parentId: z.string().nullable().optional(),
          state: z.nativeEnum(TaskState).optional(),
          assignedAgentId: z.string().optional(),
          isTopLevel: z.boolean().optional(),
          limit: z.number().min(1).max(100).optional(),
          offset: z.number().min(0).optional(),
        })
        .optional()
    )
    .query(({ ctx, input }) => {
      return taskAccessor.list({
        ...input,
        projectId: ctx.projectId,
      });
    }),

  // Get task by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const task = await taskAccessor.findById(input.id);
    if (!task) {
      throw new Error(`Task not found: ${input.id}`);
    }
    return task;
  }),

  // Get tasks by parent ID (children of a task)
  listByParent: publicProcedure.input(z.object({ parentId: z.string() })).query(({ input }) => {
    return taskAccessor.findByParentId(input.parentId);
  }),

  // Create a new task (scoped to project from context)
  // If parentId is null/undefined, creates a top-level task and fires task.top_level.created event
  // If parentId is provided, creates a child task and fires task.created event
  create: projectScopedProcedure
    .input(
      z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        design: z.string().optional(),
        parentId: z.string().nullable().optional(),
        linearIssueId: z.string().optional(),
        linearIssueUrl: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const isTopLevel = input.parentId === null || input.parentId === undefined;

      // Generate a local ID if Linear integration not used
      const linearIssueId = input.linearIssueId || `local-${Date.now()}`;
      const linearIssueUrl = input.linearIssueUrl || '';

      const task = await taskAccessor.create({
        projectId: ctx.projectId,
        parentId: input.parentId || null,
        linearIssueId,
        linearIssueUrl,
        title: input.title,
        description: input.description
          ? `${input.description}\n\n---\n\n${input.design || ''}`
          : input.design || '',
        state: isTopLevel ? TaskState.PLANNING : TaskState.PENDING,
      });

      // Fire appropriate event based on task type
      if (isTopLevel) {
        await inngest.send({
          name: 'task.top_level.created',
          data: {
            taskId: task.id,
            linearIssueId: task.linearIssueId || '',
            title: task.title,
          },
        });
      } else if (task.parentId) {
        await inngest.send({
          name: 'task.created',
          data: {
            taskId: task.id,
            parentId: task.parentId,
            linearIssueId: task.linearIssueId || '',
            title: task.title,
          },
        });
      }

      return task;
    }),

  // Update a task
  // Fires task.top_level.updated event if updating a top-level task
  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        state: z.nativeEnum(TaskState).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...updates } = input;

      // If completing, set completedAt
      const updateData = {
        ...updates,
        completedAt: updates.state === TaskState.COMPLETED ? new Date() : undefined,
      };

      const task = await taskAccessor.update(id, updateData);

      // Fire task.top_level.updated event if this is a top-level task
      if (task.parentId === null) {
        await inngest.send({
          name: 'task.top_level.updated',
          data: {
            taskId: task.id,
            state: task.state,
          },
        });
      }

      return task;
    }),

  // Delete a task
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) => {
    return taskAccessor.delete(input.id);
  }),

  // Get summary stats for dashboard (scoped to project from context)
  // If isTopLevel is true, returns stats for top-level tasks only
  // Otherwise returns stats for all tasks
  getStats: projectScopedProcedure
    .input(
      z
        .object({
          isTopLevel: z.boolean().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const tasks = await taskAccessor.list({
        projectId: ctx.projectId,
        isTopLevel: input?.isTopLevel,
      });

      // Initialize all TaskState values for completeness
      const byState: Record<TaskState, number> = {
        [TaskState.PLANNING]: 0,
        [TaskState.PLANNED]: 0,
        [TaskState.PENDING]: 0,
        [TaskState.ASSIGNED]: 0,
        [TaskState.IN_PROGRESS]: 0,
        [TaskState.REVIEW]: 0,
        [TaskState.BLOCKED]: 0,
        [TaskState.COMPLETED]: 0,
        [TaskState.FAILED]: 0,
        [TaskState.CANCELLED]: 0,
      };

      for (const task of tasks) {
        byState[task.state]++;
      }

      return {
        total: tasks.length,
        byState,
      };
    }),
});
