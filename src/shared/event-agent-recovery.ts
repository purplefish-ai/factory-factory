import { z } from 'zod';
import { agentClaimResultSchema } from './agent-runtime';
import { initialAttemptSchema } from './event-agent-delivery';

export const eventRunRecoveryContextSchema = z.strictObject({
  projectId: z.string().min(1).max(256),
  claim: agentClaimResultSchema.options[0],
  attempt: initialAttemptSchema,
});
export const eventRunRecoveryInputSchema = eventRunRecoveryContextSchema.extend({
  action: z.enum(['RESOLVE', 'ABANDON', 'RETRY']),
});
export type EventRunRecoveryContext = z.infer<typeof eventRunRecoveryContextSchema>;
export type EventRunRecoveryInput = z.infer<typeof eventRunRecoveryInputSchema>;
