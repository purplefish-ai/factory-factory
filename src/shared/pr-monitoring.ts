import { prPauseReasonSchema } from './schemas/pr-event.schema';

export { prDeliveryModeSchema, prPauseReasonSchema } from './schemas/pr-event.schema';
export const PRDeliveryMode = { MAIN: 'MAIN', DEDICATED: 'DEDICATED' } as const;
export type PRDeliveryMode = (typeof PRDeliveryMode)[keyof typeof PRDeliveryMode];
export const PR_DEDICATED_WORKFLOW = 'pr-monitoring';

export type {
  PRDeliveryRequest,
  PRFactPayload,
  PRMonitoringControlPayload,
  PRMonitoringEventPayload,
  PRObservation,
  PRPauseReason,
  PRTarget,
} from './schemas/pr-event.schema';
export type { PREventDraft } from './pr-trigger-policy.types';
export interface ClaimedPRDelivery {
  deliveryId: string;
  sessionId: string;
  deliveryProvider?: string | null;
  deliveryProviderSessionId?: string | null;
  bindingRevision: number;
  eventIds: string[];
  text: string;
  attempt: number;
}
export interface PRMonitoringProjection {
  deliveryMode: PRDeliveryMode;
  enabled: boolean;
  recipientSessionId: string | null;
  bindingRevision: number;
  pauseReason: string | null;
  pendingEventCount: number;
}
/**
 * Projected (not persisted) pause: a quarantined `BLOCKED` delivery holds every
 * later claim for the workspace until the user discards it.
 */
export const PR_DELIVERY_BLOCKED_PAUSE_REASON = 'DELIVERY_BLOCKED';
export function isPRDeliveryBlocked(reason: string | null | undefined): boolean {
  return reason === PR_DELIVERY_BLOCKED_PAUSE_REASON;
}
/**
 * Whether an explicit resume or the recipient's next turn clears this pause.
 * The others end elsewhere: the legacy fixer cutover lifts its `LEGACY_FIXER`
 * fence at startup, and the user discards a blocked delivery.
 */
export function canResumePRMonitoring(reason: string | null | undefined): boolean {
  return prPauseReasonSchema.safeParse(reason).success;
}
export const PR_EVENT_MESSAGE_ID_PREFIX = 'pr-event-';
export const PR_UPDATE_QUEUED_TEXT = 'PR update queued for the next turn';
export function prEventMarker(deliveryId: string): string {
  return `<!-- factory-factory-pr-event:${deliveryId} -->`;
}
export function isPRMonitoringRecipient(session: {
  workflow?: string | null;
  providerMetadata?: unknown;
}): boolean {
  return !['ratchet', 'auto-iteration', 'adversarial_review', PR_DEDICATED_WORKFLOW].includes(
    session.workflow ?? ''
  );
}

export type PRUpdateDeliveryState = 'queued' | 'delivered' | 'failed' | 'cancelled';
