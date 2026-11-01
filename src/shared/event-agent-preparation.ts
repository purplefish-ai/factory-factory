import { z } from 'zod';

/** PENDING proves unsent, not absence of processes started during preparation. */
export const eventLaunchPreparationSchema = z.strictObject({
  version: z.literal(1),
  state: z.enum(['SAFE', 'SETUP', 'STARTUP', 'UNKNOWN']),
  setupStartedAt: z.iso.datetime().nullable(),
});
export type EventLaunchPreparation = z.infer<typeof eventLaunchPreparationSchema>;

const transientCode = z.object({
  code: z.enum(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'EBUSY', 'SQLITE_BUSY']),
  retryAfterMs: z.unknown().optional(),
});
/** Known transport/busy failures only. Human diagnostic text never controls retries. */
export function classifyEventPreparationFailure(error: unknown): {
  category: 'TRANSIENT' | 'UNKNOWN';
  retryAfterMs?: number;
} {
  const transient = transientCode.safeParse(error);
  if (!transient.success) {
    return { category: 'UNKNOWN' };
  }
  const hint = z.number().finite().nonnegative().safeParse(transient.data.retryAfterMs);
  return { category: 'TRANSIENT', ...(hint.success ? { retryAfterMs: hint.data } : {}) };
}
