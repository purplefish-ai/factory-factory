import { z } from 'zod';

const historyReplayEndSchema = z.object({
  sessionUpdate: z.literal('session_info_update'),
  _meta: z.object({
    jetbrains: z.object({ air: z.object({ loadReplayEnd: z.literal(true) }) }),
  }),
});

export function isAcpHistoryReplayEnd(update: { sessionUpdate?: unknown }): boolean {
  return (
    update.sessionUpdate === 'session_info_update' &&
    historyReplayEndSchema.safeParse(update).success
  );
}
