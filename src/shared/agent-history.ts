import { z } from 'zod';
import { agentManagementIdSchema } from './agent-management';
import {
  agentDeliveryStateSchema,
  agentEvaluationStatusSchema,
  agentLaunchPhaseSchema,
  agentRunResultSchema,
} from './agent-runtime';
import { eventLaunchPreparationSchema } from './event-agent-preparation';
import { agentRunStatusSchema } from './schemas/agent-definition.schema';

const id = agentManagementIdSchema;
const time = z.iso.datetime().nullable();
const reason = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,99}$/)
  .nullable();
export const agentRunHistorySchema = z.strictObject({
  id,
  agentId: id,
  triggerId: id.nullable(),
  eventId: id.nullable(),
  createdAt: z.iso.datetime(),
  startedAt: time,
  completedAt: time,
  status: agentRunStatusSchema,
  launchPhase: agentLaunchPhaseSchema,
  reasonCode: reason,
  attemptCount: z.number().int().nonnegative(),
  attemptGeneration: z.number().int().positive(),
  nextAttemptAt: time,
  expiresAt: time,
  setupDeadlineAt: time,
  turnDeadlineAt: time,
  preparation: eventLaunchPreparationSchema.nullable(),
  delivery: z
    .strictObject({
      state: agentDeliveryStateSchema,
      sendingAt: time,
      acceptedAt: time,
      finishedAt: time,
    })
    .nullable(),
  initialOutcome: z
    .strictObject({
      result: z.enum(['COMPLETED', 'FAILED', 'CANCELLED']),
      stopReason: z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']),
    })
    .nullable(),
  result: agentRunResultSchema.nullable(),
  reservedWorkspaceId: id.nullable(),
  reservedSessionId: id.nullable(),
  workspaceId: id.nullable(),
  workspaceState: z.enum(['UNRESERVED', 'RESERVED', 'LIVE', 'DELETED']),
});
export const agentEvaluationHistorySchema = z.strictObject({
  id,
  eventId: id,
  triggerId: id,
  runId: id.nullable(),
  createdAt: z.iso.datetime(),
  status: agentEvaluationStatusSchema,
  reasonCode: reason,
  explanation: z.string().max(500),
  definitionRevision: z.number().int().positive(),
  triggerRevision: z.number().int().positive(),
  activationGeneration: z.number().int().nonnegative(),
  attemptCount: z.number().int().nonnegative(),
  nextAttemptAt: time,
  expiresAt: z.iso.datetime(),
});
export const agentRunPageSchema = z.strictObject({
  items: z.array(agentRunHistorySchema).max(100),
  nextCursor: z.string().nullable(),
});
export const agentEvaluationPageSchema = z.strictObject({
  items: z.array(agentEvaluationHistorySchema).max(100),
  nextCursor: z.string().nullable(),
});
export const retainedEventOriginSchema = z.strictObject({
  projectId: id,
  workspaceId: id,
  runId: id,
  workspaceState: z.enum(['LIVE', 'DELETED']),
});
export const agentWorkspaceOriginSchema = z
  .strictObject({ origin: retainedEventOriginSchema, run: agentRunHistorySchema.nullable() })
  .nullable();
