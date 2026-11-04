/**
 * Kinds of interactive request that block an agent until the user responds,
 * in the order a workspace reports them when several sessions are blocked.
 */
export const PENDING_REQUEST_TYPES = [
  'plan_approval',
  'user_question',
  'permission_request',
] as const;

export type PendingRequestType = (typeof PENDING_REQUEST_TYPES)[number];
