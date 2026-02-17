import { z } from 'zod';
import { linearClientService } from '@/backend/domains/linear';
import { publicProcedure, router } from './trpc';

export const linearRouter = router({
  /** Validate a Linear API key and list accessible teams in one round-trip. */
  validateKeyAndListTeams: publicProcedure
    .input(z.object({ apiKey: z.string().min(1) }))
    .mutation(({ input }) => {
      return linearClientService.validateKeyAndListTeams(input.apiKey);
    }),
});
