import { z } from 'zod';

/** Local runtime facts, independent of any event/run ownership or settlement. */
const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim(), 'Must be nonblank and unpadded');
export const providerSourceSchema = z.strictObject({
  version: z.literal(1),
  provider: z.enum(['CLAUDE', 'CODEX']),
  providerSessionId: id,
  runtimeIncarnationId: id,
  lifecycleGeneration: z.number().int().nonnegative(),
});
export type ProviderSource = z.infer<typeof providerSourceSchema>;
export const runtimeStopEvidenceSchema = z.strictObject({
  version: z.literal(1),
  cause: z.enum([
    'USER_STOP',
    'SHUTDOWN',
    'TIMEOUT',
    'UNEXPECTED_EXIT',
    'SYSTEM_STOP',
    'SESSION_CLOSED',
    'WORKSPACE_ARCHIVED',
  ]),
  source: providerSourceSchema.nullable(),
  status: z.enum(['LOCAL_RUNTIME_GROUP_STOPPED', 'UNKNOWN']),
  observedAt: z.iso.datetime(),
});
export type RuntimeStopEvidence = z.infer<typeof runtimeStopEvidenceSchema>;
