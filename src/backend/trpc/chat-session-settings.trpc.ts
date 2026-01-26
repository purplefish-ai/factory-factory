import { z } from 'zod';
import { chatSessionSettingsAccessor } from '../resource_accessors/chat-session-settings.accessor.js';
import { publicProcedure, router } from './trpc.js';

export const chatSessionSettingsRouter = router({
  // Get settings for a session (creates default if not exists)
  get: publicProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input }) => {
      return await chatSessionSettingsAccessor.getOrCreate(input.sessionId);
    }),

  // Update settings for a session
  update: publicProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        selectedModel: z.string().nullable().optional(),
        thinkingEnabled: z.boolean().optional(),
        planModeEnabled: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { sessionId, ...data } = input;
      return await chatSessionSettingsAccessor.update(sessionId, data);
    }),
});
