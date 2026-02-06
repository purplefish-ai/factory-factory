import { z } from 'zod';
import { ratchetAuditLogAccessor } from '../resource_accessors/ratchet-audit-log.accessor';
import { publicProcedure, router } from './trpc';

export const ratchetAuditLogRouter = router({
  listByWorkspace: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        limit: z.number().min(1).max(500).optional(),
      })
    )
    .query(({ input }) => {
      return ratchetAuditLogAccessor.findByWorkspaceId(input.workspaceId, input.limit ?? 100);
    }),
});
