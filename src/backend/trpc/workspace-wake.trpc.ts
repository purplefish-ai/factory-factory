import { z } from 'zod';
import { getWorkflowPermissionPreset } from '@/backend/services/session';
import { cadenceSchema, scheduledTimeSchema, timezoneSchema } from './cadence-schemas';
import { router, trustedLocalProcedure } from './trpc';

function isAutoApprovingPreset(preset: string): boolean {
  return preset === 'YOLO' || preset === 'RELAXED';
}

export const workspaceWakeRouter = router({
  get: trustedLocalProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(({ ctx, input }) => {
      return ctx.appContext.services.workspaceWakeService.get(input.workspaceId);
    }),

  set: trustedLocalProcedure
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
      const { workspaceWakeService, userSettingsQueryService, sessionDataService } =
        ctx.appContext.services;

      // Wake turns run unattended under the resumed session's existing
      // permission preset; a non-auto-approving preset stalls on the first
      // tool approval with nobody present. Resolve that preset and warn at
      // scheduling time, when someone can act, before persisting the
      // schedule so a settings lookup failure doesn't leave a saved
      // schedule unreported.
      const settings = await userSettingsQueryService.get();
      const sessions = await sessionDataService.findAgentSessionsByWorkspaceId(workspaceId);
      const mostRecentSession = [...sessions].sort(
        (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
      )[0];
      const preset = mostRecentSession
        ? getWorkflowPermissionPreset(mostRecentSession.workflow, settings)
        : settings.defaultWorkspacePermissions;
      const permissionWarning = isAutoApprovingPreset(preset)
        ? null
        : `The session that will be resumed defaults to the ${preset} permission preset. Wake turns run unattended, so tool-approval prompts will stall with nobody present to answer them. Consider the YOLO preset if this schedule should get work done on its own.`;

      const schedule = await workspaceWakeService.set(workspaceId, data);

      return { schedule, permissionWarning };
    }),

  clear: trustedLocalProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.appContext.services.workspaceWakeService.clear(input.workspaceId);
      return { success: true };
    }),
});
