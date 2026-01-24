import { TaskState } from '@prisma-gen/client';
import { z } from 'zod';
import { inngest } from '../inngest/client';
import { taskAccessor } from '../resource_accessors/task.accessor.js';
import { projectScopedProcedure } from './procedures/project-scoped.js';
import { publicProcedure, router } from './trpc';

/**
 * Epic router - now operates on top-level Tasks (parentId = null).
 * "Epics" are simply top-level tasks in the unified Task model.
 */
export const epicRouter = router({
  // List all top-level tasks (formerly epics) with optional filtering (scoped to project from context)
  list: projectScopedProcedure
    .input(
      z
        .object({
          state: z.nativeEnum(TaskState).optional(),
          limit: z.number().min(1).max(100).optional(),
          offset: z.number().min(0).optional(),
        })
        .optional()
    )
    .query(({ ctx, input }) => {
      return taskAccessor.list({
        ...input,
        projectId: ctx.projectId,
        isTopLevel: true, // Only top-level tasks (formerly epics)
      });
    }),

  // Get top-level task (epic) by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const task = await taskAccessor.findById(input.id);
    if (!task) {
      throw new Error(`Epic not found: ${input.id}`);
    }
    // Verify it's a top-level task
    if (task.parentId !== null) {
      throw new Error(`Task ${input.id} is not a top-level task (epic)`);
    }
    return task;
  }),

  // Create a new top-level task (epic) (scoped to project from context)
  create: projectScopedProcedure
    .input(
      z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        design: z.string().optional(),
        linearIssueId: z.string().optional(),
        linearIssueUrl: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Generate a local ID if Linear integration not used
      const linearIssueId = input.linearIssueId || `local-${Date.now()}`;
      const linearIssueUrl = input.linearIssueUrl || '';

      const task = await taskAccessor.create({
        projectId: ctx.projectId,
        parentId: null, // Top-level task (epic)
        linearIssueId,
        linearIssueUrl,
        title: input.title,
        description: input.description
          ? `${input.description}\n\n---\n\n${input.design || ''}`
          : input.design || '',
        state: TaskState.PLANNING,
      });

      // Fire task.top_level.created event to trigger supervisor creation
      await inngest.send({
        name: 'task.top_level.created',
        data: {
          taskId: task.id,
          linearIssueId: task.linearIssueId || '',
          title: task.title,
        },
      });

      return task;
    }),

  // Update a top-level task (epic)
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

      // Fire task.top_level.updated event
      await inngest.send({
        name: 'task.top_level.updated',
        data: {
          taskId: task.id,
          state: task.state,
        },
      });

      return task;
    }),

  // Delete a top-level task (epic)
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) => {
    return taskAccessor.delete(input.id);
  }),

  // Get summary stats for dashboard (scoped to project from context)
  getStats: projectScopedProcedure.query(async ({ ctx }) => {
    const topLevelTasks = await taskAccessor.list({
      projectId: ctx.projectId,
      isTopLevel: true,
    });

    // Use TaskState values that are relevant for top-level tasks
    const byState: Partial<Record<TaskState, number>> = {
      PLANNING: 0,
      PLANNED: 0,
      IN_PROGRESS: 0,
      BLOCKED: 0,
      COMPLETED: 0,
      CANCELLED: 0,
    };

    for (const task of topLevelTasks) {
      byState[task.state] = (byState[task.state] ?? 0) + 1;
    }

    return {
      total: topLevelTasks.length,
      byState,
    };
  }),
});
