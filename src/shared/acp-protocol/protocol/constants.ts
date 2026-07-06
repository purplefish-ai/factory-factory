/**
 * Canonical base order used for queued messages before dispatch assigns real order.
 * Shared by backend snapshot generation and frontend optimistic queue rendering.
 */
export const QUEUED_MESSAGE_ORDER_BASE = 1_000_000_000;

/**
 * Maximum number of transcript messages retained in renderer state and sent
 * during session hydration. The backend store remains authoritative.
 */
export const DEFAULT_RENDERER_TRANSCRIPT_LIMIT = 1000;
