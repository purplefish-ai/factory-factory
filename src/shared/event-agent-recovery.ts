import { z } from 'zod';
import { agentManagementIdSchema } from './agent-management';
import {
  agentClaimResultSchema,
  agentLaunchPhaseSchema,
  agentDeliveryStateSchema,
} from './agent-runtime';
import { initialAttemptSchema } from './event-agent-delivery';
import { eventLaunchPreparationSchema } from './event-agent-preparation';
import { eventChildRestSchema } from './event-child-rest';

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

// Deliberate operator surfaces: history and provenance do not supply send authority.
export const agentRecoveryTargetInputSchema = z.strictObject({
  projectId: agentManagementIdSchema,
  agentId: agentManagementIdSchema,
  runId: agentManagementIdSchema,
});
export const agentRecoveryContextSchema = eventRunRecoveryContextSchema.extend({
  agentId: agentManagementIdSchema,
});
export const agentRecoveryInputSchema = eventRunRecoveryInputSchema.extend({
  agentId: agentManagementIdSchema,
});
const reference = agentRecoveryTargetInputSchema;
export const agentRecoveryRunSchema = z.strictObject({
  status: z.literal('RUNNING'),
  launchPhase: agentLaunchPhaseSchema,
  deliveryState: agentDeliveryStateSchema,
  preparationState: eventLaunchPreparationSchema.shape.state.nullable(),
});
export const agentRecoveryTargetSchema = z.discriminatedUnion('status', [
  reference.extend({
    status: z.literal('AVAILABLE'),
    context: eventRunRecoveryContextSchema,
    run: agentRecoveryRunSchema,
  }),
  reference.extend({
    status: z.literal('UNAVAILABLE'),
    reason: z.enum(['NOT_FOUND', 'NOT_RECOVERABLE', 'INVALID_STORED_DATA']),
  }),
]);
const commonBlocked = z.enum([
  'PREPARATION_CLEANUP_UNCERTAIN',
  'PREVIOUS_WORK_PROOF_UNAVAILABLE',
  'SOURCE_UNAVAILABLE',
  'WORK_PROOF_UNAVAILABLE',
]);
/**
 * Child workspaces that are not at rest. While present, only ABANDON is available;
 * RESOLVE and RETRY report CHILD_WORK_UNPROVEN. `keepsOutcome` says ABANDON (or the
 * deadline) records the run's own completed/failed outcome instead of CANCELLED.
 */
export const agentRecoveryChildHoldSchema = z.strictObject({
  children: eventChildRestSchema.shape.children.max(20),
  heldCount: z.number().int().positive(),
  deadlineAt: z.iso.datetime().nullable(),
  keepsOutcome: z.boolean(),
});
export const agentRecoveryInspectionSchema = reference.extend({
  context: eventRunRecoveryContextSchema,
  run: agentRecoveryRunSchema,
  blocked: commonBlocked.nullable(),
  childHold: agentRecoveryChildHoldSchema.nullable(),
  retryBlocked: z.literal('RESOURCES_UNAVAILABLE').nullable(),
  retryResourcesAvailable: z.boolean(),
  proofAvailable: z.boolean(),
  delivery: z.enum(['UNSENT', 'REACHED_OR_UNCERTAIN']),
});
export const agentRecoveryResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('RESOLVED') }),
  z.strictObject({ status: z.literal('ABANDONED') }),
  z.strictObject({
    status: z.literal('RETRIED'),
    claim: agentClaimResultSchema.options[0],
    attempt: initialAttemptSchema,
  }),
  z.strictObject({
    status: z.literal('BLOCKED'),
    reason: z.enum([
      ...commonBlocked.options,
      'CHILD_WORK_UNPROVEN',
      'RESOURCES_UNAVAILABLE',
      'OWNER_CLOSED',
      'OTHER_OWNER',
      'OWNER_CHANGED',
      'OWNER_UNAVAILABLE',
      'PROOF_OR_OWNERSHIP_UNAVAILABLE',
    ]),
  }),
]);
