import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { periodicTaskCadenceSchema, scheduledTimeSchema, timezoneSchema } from './cadence-schemas';
import { publicProcedure, router } from './trpc';

export const periodicTaskRouter = router({
  list: publicProcedure.input(z.object({ projectId: z.string() })).query(({ ctx, input }) => {
    return ctx.appContext.services.periodicTaskService.list(input.projectId);
  }),

  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const { periodicTaskService } = ctx.appContext.services;
    const task = await periodicTaskService.get(input.id);
    if (!task) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Periodic task not found' });
    }
    return task;
  }),

  create: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1),
        prompt: z.string().min(1),
        cadence: periodicTaskCadenceSchema,
        scheduledTime: scheduledTimeSchema,
        timezone: timezoneSchema,
      })
    )
    .mutation(({ ctx, input }) => {
      return ctx.appContext.services.periodicTaskService.create(input);
    }),

  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
        cadence: periodicTaskCadenceSchema.optional(),
        scheduledTime: scheduledTimeSchema,
        timezone: timezoneSchema,
      })
    )
    .mutation(({ ctx, input }) => {
      const { id, ...data } = input;
      return ctx.appContext.services.periodicTaskService.update(id, data);
    }),

  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.appContext.services.periodicTaskService.delete(input.id);
    return { success: true };
  }),

  toggleEnabled: publicProcedure
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .mutation(({ ctx, input }) => {
      return ctx.appContext.services.periodicTaskService.toggleEnabled(input.id, input.enabled);
    }),

  listExecutions: publicProcedure
    .input(
      z.object({ periodicTaskId: z.string(), limit: z.number().int().min(1).max(100).optional() })
    )
    .query(({ ctx, input }) => {
      return ctx.appContext.services.periodicTaskService.listExecutions(
        input.periodicTaskId,
        input.limit ?? 20
      );
    }),

  listExecutionsByPeriodicTaskId: publicProcedure
    .input(z.object({ periodicTaskId: z.string() }))
    .query(({ ctx, input }) => {
      return ctx.appContext.services.periodicTaskService.listExecutionsByPeriodicTaskId(
        input.periodicTaskId
      );
    }),
});
