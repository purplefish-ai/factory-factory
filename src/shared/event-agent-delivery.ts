import { z } from 'zod';
import {
  providerSourceSchema,
  runtimeStopEvidenceSchema,
  type ProviderSource,
  type RuntimeStopEvidence,
} from './acp-protocol/runtime-observation';
export {
  providerSourceSchema,
  runtimeStopEvidenceSchema,
  type ProviderSource,
  type RuntimeStopEvidence,
} from './acp-protocol/runtime-observation';
import { eventAgentExecutionSchema, eventLaunchIdentifierSchema as id } from './event-agent-launch';
import { eventWorkProofSchema } from './event-agent-work';
import { eventChildRestProofSchema } from './event-child-rest';

export const initialAttemptSchema = z.strictObject({
  runId: id,
  sessionId: id,
  messageId: id,
  sendAttemptId: id,
  workerGeneration: z.number().int().positive(),
  attemptGeneration: z.number().int().positive(),
});
export type InitialAttempt = z.infer<typeof initialAttemptSchema>;
export type ExpectedEventRuntime = {
  attempt: InitialAttempt;
  source: ProviderSource;
  assertCurrent(): void;
};
export const initialOutcomeSchema = z
  .strictObject({
    source: providerSourceSchema,
    stopReason: z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']),
    result: z.enum(['COMPLETED', 'FAILED', 'CANCELLED']),
  })
  .refine(
    ({ result, stopReason }) =>
      result === 'FAILED' || (result === 'CANCELLED') === (stopReason === 'cancelled'),
    'Inconsistent terminal outcome'
  );
export type InitialOutcome = z.infer<typeof initialOutcomeSchema>;
/** Last explicit decision, separate from the provider's immutable response. */
export const eventRunResolutionSchema = z.strictObject({
  action: z.enum(['RESOLVE', 'ABANDON', 'RETRY']),
  attempt: initialAttemptSchema,
  outcome: initialOutcomeSchema.optional(),
  stop: runtimeStopEvidenceSchema,
  work: eventWorkProofSchema,
  resolvedAt: z.iso.datetime(),
});
export type EventRunResolution = z.infer<typeof eventRunResolutionSchema>;
/** Why recovery could not prove the run's own work stopped (the common recovery blocks). */
export const unprovenStopReasonSchema = z.enum([
  'PREPARATION_CLEANUP_UNCERTAIN',
  'PREVIOUS_WORK_PROOF_UNAVAILABLE',
  'SOURCE_UNAVAILABLE',
  'WORK_PROOF_UNAVAILABLE',
]);
export type UnprovenStopReason = z.infer<typeof unprovenStopReasonSchema>;
/**
 * A person ended the run although its stop could not be proven. It records no
 * stop or work proof: any `stop` beside it is only what was actually observed.
 */
export const unprovenAbandonSchema = z.strictObject({
  version: z.literal(1),
  attempt: initialAttemptSchema,
  reason: unprovenStopReasonSchema,
  decidedAt: z.iso.datetime(),
});
export const initialDeliveryEvidenceSchema = z.strictObject({
  version: z.literal(1),
  attempt: initialAttemptSchema,
  source: providerSourceSchema.optional(),
  outcome: initialOutcomeSchema.optional(),
  stop: runtimeStopEvidenceSchema.optional(),
  work: eventWorkProofSchema.optional(),
  resolution: eventRunResolutionSchema.optional(),
  unprovenAbandon: unprovenAbandonSchema.optional(),
  /** Child observation that let settlement or ABANDON finish the run. */
  children: eventChildRestProofSchema.optional(),
});
export type InitialDeliveryEvidence = z.infer<typeof initialDeliveryEvidenceSchema>;
export const initialDeliveryFenceSchema = z.strictObject({
  attempt: initialAttemptSchema,
  state: z.enum(['PENDING', 'SENDING', 'ACCEPTED', 'FINISHED', 'AMBIGUOUS']),
  execution: eventAgentExecutionSchema,
  evidence: initialDeliveryEvidenceSchema.nullable(),
});
export type InitialDeliveryFence = z.infer<typeof initialDeliveryFenceSchema>;
/** Injected by orchestration. Reads must also cover FINISHED attempts after restart. */
export interface InitialDeliveryOwnerPort {
  /**
   * Null when the run no longer exists: it was deleted with its automation,
   * which requires every run to be finished, so the session is ordinary.
   */
  readFence(runId: string, sessionId: string): Promise<InitialDeliveryFence | null>;
  beforeSend(attempt: InitialAttempt, source: ProviderSource): Promise<void>;
  outcome(attempt: InitialAttempt, outcome: InitialOutcome): Promise<void>;
  ambiguous(attempt: InitialAttempt): Promise<void>;
  stop(attempt: InitialAttempt, evidence: RuntimeStopEvidence): Promise<void>;
}
