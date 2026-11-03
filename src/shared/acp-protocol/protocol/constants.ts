/**
 * Canonical base order used for queued messages before dispatch assigns real order.
 * Shared by backend snapshot generation and frontend optimistic queue rendering.
 */
export const QUEUED_MESSAGE_ORDER_BASE = 1_000_000_000;

/**
 * Maximum number of transcript messages sent during session hydration, and the
 * size the renderer trims back to. The renderer may grow past it by a small
 * slack between trims. The backend store remains authoritative.
 */
export const DEFAULT_RENDERER_TRANSCRIPT_LIMIT = 1000;
