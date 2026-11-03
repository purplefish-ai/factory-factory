import { publicProcedure, router } from './trpc';

export const portShareRouter = router({
  /** Whether `/proxy/<port>` links can share loopback ports (only under `ff tailscale`). */
  getStatus: publicProcedure.query(({ ctx }) => ({
    available: ctx.appContext.services.portShareService.isAvailable(),
  })),
});
