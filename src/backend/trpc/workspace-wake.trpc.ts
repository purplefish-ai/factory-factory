import { z } from 'zod';
import { cadenceSchema, scheduledTimeSchema, timezoneSchema } from './cadence-schemas';
import { publicProcedure, router } from './trpc';

export const workspaceWakeRouter = router({
  get: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ ctx, input }) => {
    return ctx.appContext.services.workspaceWakeService.get(input.workspaceId);
  }),

  set: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        cadence: cadenceSchema,
        prompt: z.string().min(1),
        scheduledTime: scheduledTimeSchema,
        timezone: timezoneSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { workspaceId, ...data } = input;
      const { workspaceWakeService, userSettingsQueryService } = ctx.appContext.services;
      const schedule = await workspaceWakeService.set(workspaceId, data);

      // Wake turns run unattended under the session's existing permission
      // preset; a non-auto-approving preset stalls on the first tool approval
      // with nobody present. Warn at scheduling time, when someone can act.
      const settings = await userSettingsQueryService.get();
      const preset = settings.defaultWorkspacePermissions;
      const permissionWarning =
        preset === 'YOLO'
          ? null
          : `Sessions currently default to the ${preset} permission preset. Wake turns run unattended, so tool-approval prompts will stall with nobody present to answer them. Consider the YOLO preset if this schedule should get work done on its own.`;

      return { schedule, permissionWarning };
    }),

  clear: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.appContext.services.workspaceWakeService.clear(input.workspaceId);
      return { success: true };
    }),
});
