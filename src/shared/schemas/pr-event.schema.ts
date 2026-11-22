import { z } from 'zod';

export const prDeliveryModeSchema = z.enum(['MAIN', 'DEDICATED']);

/** `WorkspacePREvent.state`. Delivery members project their delivery's state on read. */
export const prEventStateSchema = z.enum([
  'PENDING',
  'DISPATCHING',
  'DELIVERED',
  'SUPERSEDED',
  'CANCELLED',
]);
/**
 * `WorkspacePRDelivery.state`. `BLOCKED` quarantines inconsistent or held receipt
 * evidence and holds every later claim for its workspace. `DISMISSED` is a
 * `BLOCKED` delivery the user explicitly discarded: its evidence stays verbatim,
 * its unsettled members read as `CANCELLED` (settled ones keep their state), and
 * it no longer holds claims. Unknown persisted states hold claims and fail reads.
 */
export const prDeliveryStateSchema = z.enum([
  ...prEventStateSchema.options,
  'BLOCKED',
  'DISMISSED',
]);

/**
 * `WorkspacePRMonitoring.deliveryPauseReason` values delivery writes. Each one
 * clears on an explicit resume or the recipient's next turn, so no pause is a
 * dead end. `INVALID_EVENT` is no longer written (delivery discards a fact it
 * cannot render instead) and stays so that rows paused by earlier builds resume.
 */
export const prPauseReasonSchema = z.enum([
  'USER_STOPPED',
  'SESSION_FAILED',
  'RESUME_FAILED',
  'DELIVERY_FAILED',
  'RECEIPT_UNAVAILABLE',
  'INVALID_EVENT',
]);

export const prTargetSchema = z.strictObject({
  workspaceId: z.string().min(1),
  prId: z.string().min(1),
});
export const prCheckSchema = z.strictObject({
  identity: z.string().min(1),
  attempt: z.number().int().positive().nullable(),
  name: z.string(),
  workflowName: z.string().nullable(),
  status: z.string(),
  conclusion: z.string().nullable(),
  detailsUrl: z.url().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});
export const prReviewSchema = z.strictObject({
  identity: z.string().min(1),
  contentHash: z.string().min(1),
  author: z.string(),
  body: z.string(),
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  url: z.url(),
  activityAt: z.iso.datetime(),
});
export const prObservationSchema = z.strictObject({
  url: z.url(),
  title: z.string().nullable().optional(),
  repository: z.string().min(1),
  number: z.number().int().positive(),
  headSha: z.string().min(1),
  headBranch: z.string(),
  baseBranch: z.string(),
  observedAt: z.iso.datetime(),
  prState: z.enum(['DRAFT', 'OPEN', 'CHANGES_REQUESTED', 'APPROVED', 'MERGED', 'CLOSED']),
  ciStatus: z.enum(['UNKNOWN', 'PENDING', 'SUCCESS', 'FAILURE']),
  reviewState: z.string().nullable(),
  hasMergeConflict: z.boolean(),
  checks: z.array(prCheckSchema),
  actionableReviews: z.array(prReviewSchema),
  reviewsComplete: z.boolean(),
  resolvedReviewIds: z.array(z.string()).optional(),
  /**
   * Reducer memory, set only on the stored observation of a failing PR: when
   * this failure (same head and failing checks) was first observed, and whether
   * it has been announced. A fetch never sets it; a stored failure without it
   * predates the field and counts as announced.
   */
  ciFailure: z.strictObject({ since: z.iso.datetime(), announced: z.boolean() }).optional(),
});
const facts = { target: prTargetSchema, observation: prObservationSchema };
export const prFactPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('CI_FAILED'), ...facts }),
  z.strictObject({ kind: z.literal('CI_RECOVERED'), ...facts }),
  z.strictObject({
    kind: z.literal('REVIEW_FEEDBACK'),
    ...facts,
    reviews: z.array(prReviewSchema),
  }),
  z.strictObject({ kind: z.literal('CONFLICT_DETECTED'), ...facts }),
  z.strictObject({ kind: z.literal('CONFLICT_CLEARED'), ...facts }),
  z.strictObject({ kind: z.literal('PR_MERGED'), ...facts }),
  z.strictObject({ kind: z.literal('PR_CLOSED'), ...facts }),
]);
export const prMonitoringControlPayloadSchema = z.strictObject({
  kind: z.literal('MONITORING_ENABLED'),
  workspaceId: z.string().min(1),
  bindingRevision: z.number().int().nonnegative(),
  replyToPrComments: z.boolean(),
});
// The durable ledger keeps its existing wire format for backups and frozen retries.
export const prMonitoringEventPayloadSchema = z.union([
  prFactPayloadSchema,
  prMonitoringControlPayloadSchema,
]);
export const prDeliveryRequestSchema = z.strictObject({
  deliveryMode: prDeliveryModeSchema.optional(),
  workspaceId: z.string().min(1),
  prId: z.string().min(1).nullable(),
  bindingRevision: z.number().int().nonnegative(),
});
export type PRTarget = z.infer<typeof prTargetSchema>;
export type PRObservation = z.infer<typeof prObservationSchema>;
export type PRFactPayload = z.infer<typeof prFactPayloadSchema>;
export type PRMonitoringControlPayload = z.infer<typeof prMonitoringControlPayloadSchema>;
export type PRMonitoringEventPayload = z.infer<typeof prMonitoringEventPayloadSchema>;
export type PRDeliveryRequest = z.infer<typeof prDeliveryRequestSchema>;
export type PRDeliveryState = z.infer<typeof prDeliveryStateSchema>;
export type PRPauseReason = z.infer<typeof prPauseReasonSchema>;
