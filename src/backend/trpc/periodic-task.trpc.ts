import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { publicProcedure, router } from './trpc';

const scheduledTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be a valid HH:MM time (00:00–23:59)')
  .nullable()
  .optional();

const timezoneSchema = z
  .string()
  .refine(
    (tz) => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Must be a valid IANA timezone (e.g. America/New_York)' }
  )
  .nullable()
  .optional();

export const periodicTaskRouter = router({
  list: publicProcedure.input(z.object({ projectId: z.string() })).query(({ ctx, input }) => {
    return ctx.appContext.services.periodicTaskAccessor.listByProject(input.projectId);
  }),

  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const { periodicTaskAccessor } = ctx.appContext.services;
    const task = await periodicTaskAccessor.findById(input.id);
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
        cadence: z.enum(['EVERY_MINUTE', 'EVERY_FIVE_MINUTES', 'DAILY', 'WEEKLY', 'MONTHLY']),
        scheduledTime: scheduledTimeSchema,
        timezone: timezoneSchema,
      })
    )
    .mutation(({ ctx, input }) => {
      return ctx.appContext.services.periodicTaskAccessor.create(input);
    }),

  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
        cadence: z
          .enum(['EVERY_MINUTE', 'EVERY_FIVE_MINUTES', 'DAILY', 'WEEKLY', 'MONTHLY'])
          .optional(),
        scheduledTime: scheduledTimeSchema,
        timezone: timezoneSchema,
      })
    )
    .mutation(({ ctx, input }) => {
      const { id, ...data } = input;
      return ctx.appContext.services.periodicTaskAccessor.update(id, data);
    }),

  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.appContext.services.periodicTaskAccessor.delete(input.id);
    return { success: true };
  }),

  toggleEnabled: publicProcedure
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .mutation(({ ctx, input }) => {
      return ctx.appContext.services.periodicTaskAccessor.toggleEnabled(input.id, input.enabled);
    }),

  listExecutions: publicProcedure
    .input(
      z.object({ periodicTaskId: z.string(), limit: z.number().int().min(1).max(100).optional() })
    )
    .query(({ ctx, input }) => {
      return ctx.appContext.services.periodicTaskAccessor.listExecutions(
        input.periodicTaskId,
        input.limit ?? 20
      );
    }),

  listExecutionsByPeriodicTaskId: publicProcedure
    .input(z.object({ periodicTaskId: z.string() }))
    .query(({ ctx, input }) => {
      return ctx.appContext.services.periodicTaskAccessor.listExecutionsByWorkspacePeriodicTask(
        input.periodicTaskId
      );
    }),
});
