/**
 * Shared WebSocket configuration for frontend components.
 * This centralizes the WebSocket connection settings used by chat and agent-activity hooks.
 */

/**
 * Port number for WebSocket connections to the backend.
 * Configurable via NEXT_PUBLIC_BACKEND_PORT env var (defaults to 3001).
 * This allows running dev and production servers on different ports simultaneously.
 */
export const WEBSOCKET_PORT = Number(process.env.NEXT_PUBLIC_BACKEND_PORT) || 3001;

/**
 * Maximum reconnection attempts before giving up.
 *
 * With exponential backoff (1s, 2s, 4s, 8s, 16s, then 30s cap), 10 attempts
 * results in a maximum total wait time of approximately 3 minutes before
 * displaying an error to the user. This duration is chosen to:
 * - Handle brief network hiccups without user intervention
 * - Survive backend restarts during development
 * - Eventually fail and show clear feedback rather than trying indefinitely
 */
export const MAX_RECONNECT_ATTEMPTS = 10;

/**
 * Base delay in milliseconds for exponential backoff.
 */
export const RECONNECT_BASE_DELAY_MS = 1000;

/**
 * Maximum delay in milliseconds for exponential backoff.
 */
export const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * Calculate reconnection delay with exponential backoff and jitter.
 * @param attempt - The current reconnection attempt number (0-indexed)
 * @returns Delay in milliseconds
 */
export function getReconnectDelay(attempt: number): number {
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
  const baseDelay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
  // Add jitter (0-25%) to prevent thundering herd
  const jitter = Math.random() * baseDelay * 0.25;
  return baseDelay + jitter;
}

/**
 * Constructs a WebSocket URL for the given endpoint with query parameters.
 * @param endpoint - The WebSocket endpoint path (e.g., '/chat', '/agent-activity')
 * @param params - Query parameters to append to the URL
 */
export function buildWebSocketUrl(endpoint: string, params: Record<string, string>): string {
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const queryString = new URLSearchParams(params).toString();
  return `ws://${host}:${WEBSOCKET_PORT}${endpoint}?${queryString}`;
}
