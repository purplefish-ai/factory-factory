/**
 * Shared WebSocket configuration for frontend components.
 * This centralizes the WebSocket connection settings used by chat and agent-activity hooks.
 */

/**
 * Port number for WebSocket connections to the backend.
 * In development, this matches the BACKEND_PORT env var (defaults to 3001).
 */
export const WEBSOCKET_PORT = 3001;

/**
 * Maximum reconnection attempts before giving up.
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
 * Legacy constant for backwards compatibility.
 * @deprecated Use getReconnectDelay() instead for exponential backoff.
 */
export const RECONNECT_DELAY_MS = 2000;

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
