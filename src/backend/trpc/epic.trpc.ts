import { EpicState } from '@prisma/client';
import { z } from 'zod';
import { inngest } from '../inngest/client';
import { epicAccessor } from '../resource_accessors/epic.accessor';
import { publicProcedure, router } from './trpc';

export const epicRouter = router({
  // List all epics with optional filtering
  list: publicProcedure
    .input(
      z
        .object({
          state: z.nativeEnum(EpicState).optional(),
          limit: z.number().min(1).max(100).optional(),
          offset: z.number().min(0).optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      return epicAccessor.list(input);
    }),

  // Get epic by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const epic = await epicAccessor.findById(input.id);
    if (!epic) {
      throw new Error(`Epic not found: ${input.id}`);
    }
    return epic;
  }),

  // Create a new epic
  create: publicProcedure
    .input(
      z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        design: z.string().optional(),
        linearIssueId: z.string().optional(),
        linearIssueUrl: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Generate a local ID if Linear integration not used
      const linearIssueId = input.linearIssueId || `local-${Date.now()}`;
      const linearIssueUrl = input.linearIssueUrl || '';

      const epic = await epicAccessor.create({
        linearIssueId,
        linearIssueUrl,
        title: input.title,
        description: input.description
          ? `${input.description}\n\n---\n\n${input.design || ''}`
          : input.design || '',
        state: EpicState.PLANNING,
      });

      // Fire epic.created event to trigger supervisor creation
      await inngest.send({
        name: 'epic.created',
        data: {
          epicId: epic.id,
          linearIssueId: epic.linearIssueId,
          title: epic.title,
        },
      });

      return epic;
    }),

  // Update an epic
  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        state: z.nativeEnum(EpicState).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...updates } = input;

      // If completing, set completedAt
      const updateData = {
        ...updates,
        completedAt: updates.state === EpicState.COMPLETED ? new Date() : undefined,
      };

      const epic = await epicAccessor.update(id, updateData);

      // Fire epic.updated event
      await inngest.send({
        name: 'epic.updated',
        data: {
          epicId: epic.id,
          state: epic.state,
        },
      });

      return epic;
    }),

  // Delete an epic
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    return epicAccessor.delete(input.id);
  }),

  // Get summary stats for dashboard
  getStats: publicProcedure.query(async () => {
    const epics = await epicAccessor.list();

    const byState: Record<EpicState, number> = {
      PLANNING: 0,
      IN_PROGRESS: 0,
      BLOCKED: 0,
      COMPLETED: 0,
      CANCELLED: 0,
    };

    epics.forEach((epic) => {
      byState[epic.state]++;
    });

    return {
      total: epics.length,
      byState,
    };
  }),
});
