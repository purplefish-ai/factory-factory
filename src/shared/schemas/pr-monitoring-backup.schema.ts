import { z } from 'zod';
import {
  prDeliveryModeSchema,
  prMonitoringEventPayloadSchema,
  prObservationSchema,
} from './pr-event.schema';

const date = z.iso.datetime();
export const prMonitoringBackupSchema = z.strictObject({
  enabled: z.boolean(),
  deliveryMode: prDeliveryModeSchema.default('MAIN'),
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
    deliveryId: z.string().min(1).nullable(),
    deliverySessionId: z.string().min(1).nullable(),
    deliveryProvider: z.string().nullable().optional(),
    deliveryProviderSessionId: z.string().nullable().optional(),
    deliveryBindingRevision: z.number().int().nonnegative().nullable(),
    deliveryText: z
      .string()
      .refine(
        (text) => new TextEncoder().encode(text).byteLength <= 16_384,
        'Frozen delivery text exceeds 16 KiB'
      )
      .nullable(),
    claimedAt: date.nullable(),
    deliveredAt: date.nullable(),
    createdAt: date,
  })
  .refine((e) => e.kind === e.payload.kind, 'Event kind disagrees with payload')
  .refine(
    (event) =>
      event.state !== 'DISPATCHING' ||
      Boolean(
        event.deliveryId &&
        event.deliverySessionId &&
        event.deliveryProvider &&
        event.deliveryProviderSessionId &&
        event.deliveryText &&
        event.deliveryBindingRevision !== null
      ),
    'Dispatching event requires complete frozen delivery metadata'
  );
export const prAssociationBackupSchema = z.strictObject({
  dedicatedSession: z
    .strictObject({ sessionId: z.string().min(1).nullable() })
    .nullable()
    .optional(),
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
