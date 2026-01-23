import { TaskState } from '@prisma-gen/client';
import { z } from 'zod';
import { taskAccessor } from '../resource_accessors/task.accessor';
import { publicProcedure, router } from './trpc';

export const taskRouter = router({
  // List all tasks with optional filtering
  list: publicProcedure
    .input(
      z
        .object({
          epicId: z.string().optional(),
          state: z.nativeEnum(TaskState).optional(),
          assignedAgentId: z.string().optional(),
          limit: z.number().min(1).max(100).optional(),
          offset: z.number().min(0).optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      return taskAccessor.list(input);
    }),

  // Get task by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const task = await taskAccessor.findById(input.id);
    if (!task) {
      throw new Error(`Task not found: ${input.id}`);
    }
    return task;
  }),

  // Get tasks by epic ID
  listByEpic: publicProcedure.input(z.object({ epicId: z.string() })).query(async ({ input }) => {
    return taskAccessor.findByEpicId(input.epicId);
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
    .mutation(async ({ input }) => {
      const { id, ...updates } = input;

      // If completing, set completedAt
      const updateData = {
        ...updates,
        completedAt: updates.state === TaskState.COMPLETED ? new Date() : undefined,
      };

      return taskAccessor.update(id, updateData);
    }),

  // Get summary stats for dashboard
  getStats: publicProcedure.query(async () => {
    const tasks = await taskAccessor.list();

    const byState: Record<TaskState, number> = {
      PENDING: 0,
      ASSIGNED: 0,
      IN_PROGRESS: 0,
      REVIEW: 0,
      BLOCKED: 0,
      COMPLETED: 0,
      FAILED: 0,
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
