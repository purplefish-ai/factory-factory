import { z } from 'zod';
import { prMonitoringEventPayloadSchema, prObservationSchema } from './pr-event.schema';

const date = z.iso.datetime();
export const prMonitoringBackupSchema = z.strictObject({
  enabled: z.boolean(),
  recipientSessionId: z.string().nullable(),
  bindingRevision: z.number().int().nonnegative(),
  eventEpoch: z.number().int().nonnegative(),
  deliveryPauseReason: z.string().nullable(),
  legacySessionIds: z.array(z.string()).default([]),
  lastCheckedAt: date.nullable(),
});
export const prEventBackupSchema = z
  .strictObject({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    prId: z.string().nullable(),
    kind: z.string(),
    deduplicationKey: z.string().min(1),
    payload: prMonitoringEventPayloadSchema,
    state: z.enum(['PENDING', 'DISPATCHING', 'DELIVERED', 'SUPERSEDED', 'CANCELLED']),
    attempts: z.number().int().nonnegative(),
    deliveryId: z.string().nullable(),
    deliverySessionId: z.string().nullable(),
    deliveryBindingRevision: z.number().int().nonnegative().nullable(),
    deliveryText: z.string().nullable(),
    claimedAt: date.nullable(),
    deliveredAt: date.nullable(),
    createdAt: date,
  })
  .refine((e) => e.kind === e.payload.kind, 'Event kind disagrees with payload');
export const prAssociationBackupSchema = z.strictObject({
  id: z.string().min(1),
  url: z.url(),
  number: z.number().int().nullable(),
  title: z.string().nullable(),
  headRefName: z.string().nullable(),
  baseRefName: z.string().nullable(),
  state: z.enum(['NONE', 'DRAFT', 'OPEN', 'CHANGES_REQUESTED', 'APPROVED', 'MERGED', 'CLOSED']),
  reviewState: z.string().nullable(),
  ciStatus: z.enum(['UNKNOWN', 'PENDING', 'SUCCESS', 'FAILURE']),
  hasMergeConflict: z.boolean(),
  syncedAt: date.nullable(),
  detachedAt: date.nullable(),
  revision: z.number().int().nonnegative(),
  observation: prObservationSchema.nullable().default(null),
  observationEpoch: z.number().int().nonnegative().default(0),
  transitionSequence: z.number().int().nonnegative().default(0),
  ciFailedAt: date.nullable(),
  ciLastNotifiedAt: date.nullable(),
  reviewLastCheckedAt: date.nullable(),
  reviewLastCommentId: z.string().nullable(),
});
export const prDiscoveryBackupSchema = z.strictObject({
  lastCheckedAt: date.nullable(),
  retryCount: z.number().int().nonnegative(),
  nextCheckAt: date.nullable(),
});
