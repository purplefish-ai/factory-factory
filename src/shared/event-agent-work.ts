import { z } from 'zod';
import { providerSourceSchema } from './acp-protocol/runtime-observation';

/** Supported live FF tracking, not a claim about arbitrary remote effects. */
export const eventWorkProofSchema = z.strictObject({
  version: z.literal(1),
  source: providerSourceSchema,
  revision: z.number().int().nonnegative(),
  coverageGeneration: z.number().int().nonnegative(),
  mode: z.enum(['LIVE', 'STOPPED']),
  observedAt: z.iso.datetime(),
});
export type EventWorkProof = z.infer<typeof eventWorkProofSchema>;
