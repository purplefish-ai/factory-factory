import { z } from 'zod';
import { linearClientService } from '@/backend/domains/linear';
import { publicProcedure, router } from './trpc';

export const linearRouter = router({
  /** Validate a Linear API key by checking viewer identity. */
  validateApiKey: publicProcedure
    .input(z.object({ apiKey: z.string().min(1) }))
    .mutation(({ input }) => {
      return linearClientService.validateApiKey(input.apiKey);
    }),

  /** List teams accessible with the given API key. */
  listTeams: publicProcedure
    .input(z.object({ apiKey: z.string().min(1) }))
    .mutation(({ input }) => {
      return linearClientService.listTeams(input.apiKey);
    }),
});
