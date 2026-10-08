import { z } from 'zod';

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
});
const facts = { target: prTargetSchema, observation: prObservationSchema };
export const prMonitoringEventPayloadSchema = z.discriminatedUnion('kind', [
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
  z.strictObject({
    kind: z.literal('MONITORING_ENABLED'),
    workspaceId: z.string().min(1),
    bindingRevision: z.number().int().nonnegative(),
    replyToPrComments: z.boolean(),
  }),
]);
export const prDeliveryRequestSchema = z.strictObject({
  workspaceId: z.string().min(1),
  prId: z.string().min(1).nullable(),
  bindingRevision: z.number().int().nonnegative(),
});
export type PRTarget = z.infer<typeof prTargetSchema>;
export type PRObservation = z.infer<typeof prObservationSchema>;
export type PRMonitoringEventPayload = z.infer<typeof prMonitoringEventPayloadSchema>;
export type PRDeliveryRequest = z.infer<typeof prDeliveryRequestSchema>;
