import { z } from 'zod';
import { initialAttemptSchema, initialDeliveryFenceSchema } from './event-agent-delivery';
import { eventLaunchPreparationSchema } from './event-agent-preparation';

export const workspaceRetryAvailabilitySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('AVAILABLE') }),
  z.object({
    status: z.literal('BLOCKED'),
    reason: z.enum([
      'NOT_RETRYABLE',
      'RETRY_LIMIT',
      'INITIAL_PENDING',
      'PREPARATION_INCOMPLETE',
      'INITIAL_UNRESOLVED',
      'INITIAL_ACTIVE',
      'AUTHORITY_UNAVAILABLE',
    ]),
    explanation: z.string().max(500),
  }),
]);
export type WorkspaceRetryAvailability = z.infer<typeof workspaceRetryAvailabilitySchema>;

/** Internal captured owner context, never a transport permit or public history DTO. */
export const workspaceRetryContextSchema = z.object({
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
  initialMessageId: z.string().min(1),
  fence: initialDeliveryFenceSchema,
  preparation: eventLaunchPreparationSchema.nullable(),
});
export type WorkspaceRetryContext = z.infer<typeof workspaceRetryContextSchema>;
export interface WorkspaceInitGuard {
  readonly context: WorkspaceRetryContext;
  check(): Promise<void>;
  revoke(): void;
  /** Synchronous local admission/revocation check at the actual effect or commit boundary. */
  assertCurrent(): void;
}

const rowSchema = z.object({
  id: z.string(),
  reservedWorkspaceId: z.string(),
  reservedSessionId: z.string(),
  workspaceId: z.string().nullable(),
  initialMessageId: z.string(),
  workerGeneration: z.number(),
  attemptGeneration: z.number(),
  effectiveExecution: z.unknown(),
  launchPreparation: z.unknown(),
  agentDefinition: z.object({ projectId: z.string() }),
  initialDelivery: z.object({
    state: z.string(),
    attemptGeneration: z.number(),
    messageId: z.string(),
    sendAttemptId: z.string(),
    evidence: z.unknown(),
  }),
});
/** Both resource owners validate foreign read facts without transferring write ownership. */
export function parseWorkspaceRetryContext(
  input: unknown,
  target: { projectId: string; workspaceId: string; runId: string }
): WorkspaceRetryContext {
  const run = rowSchema.parse(input);
  if (
    run.id !== target.runId ||
    run.agentDefinition.projectId !== target.projectId ||
    run.reservedWorkspaceId !== target.workspaceId ||
    (run.workspaceId !== null && run.workspaceId !== target.workspaceId) ||
    run.initialDelivery.attemptGeneration !== run.attemptGeneration
  ) {
    throw new Error('Event workspace retry identity changed');
  }
  const attempt = initialAttemptSchema.parse({
    runId: run.id,
    sessionId: run.reservedSessionId,
    workerGeneration: run.workerGeneration,
    attemptGeneration: run.attemptGeneration,
    messageId: run.initialDelivery.messageId,
    sendAttemptId: run.initialDelivery.sendAttemptId,
  });
  const context = workspaceRetryContextSchema.parse({
    projectId: target.projectId,
    workspaceId: target.workspaceId,
    initialMessageId: run.initialMessageId,
    fence: {
      attempt,
      state: run.initialDelivery.state,
      execution: run.effectiveExecution,
      evidence: run.initialDelivery.evidence,
    },
    preparation: run.launchPreparation,
  });
  const recorded = context.fence.evidence?.attempt;
  if (
    recorded &&
    (recorded.runId !== attempt.runId ||
      recorded.sessionId !== attempt.sessionId ||
      recorded.attemptGeneration !== attempt.attemptGeneration ||
      recorded.messageId !== attempt.messageId ||
      recorded.sendAttemptId !== attempt.sendAttemptId)
  ) {
    throw new Error('Event delivery evidence identity changed');
  }
  return context;
}
