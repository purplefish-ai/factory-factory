import { TaskState } from '@prisma-gen/client';
import { z } from 'zod';
import { taskAccessor } from '../resource_accessors/task.accessor.js';
import { projectScopedProcedure } from './procedures/project-scoped.js';
import { publicProcedure, router } from './trpc';

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

  // Update a task (admin use)
  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        state: z.nativeEnum(TaskState).optional(),
      })
    )
    .mutation(({ input }) => {
      const { id, ...updates } = input;

      // If completing, set completedAt
      const updateData = {
        ...updates,
        completedAt: updates.state === TaskState.COMPLETED ? new Date() : undefined,
      };

      return taskAccessor.update(id, updateData);
    }),

  // Get summary stats for dashboard (scoped to project from context)
  getStats: projectScopedProcedure.query(async ({ ctx }) => {
    const tasks = await taskAccessor.list({ projectId: ctx.projectId });

    const byState: Record<TaskState, number> = {
      PLANNING: 0,
      PLANNED: 0,
      PENDING: 0,
      ASSIGNED: 0,
      IN_PROGRESS: 0,
      REVIEW: 0,
      BLOCKED: 0,
      COMPLETED: 0,
      FAILED: 0,
      CANCELLED: 0,
    };

    tasks.forEach((task) => {
      byState[task.state]++;
    });

    return {
      total: tasks.length,
      byState,
    };
  }),
});
