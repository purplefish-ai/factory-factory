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
export const MAX_RECONNECT_ATTEMPTS = 3;

/**
 * Delay in milliseconds between reconnection attempts.
 */
export const RECONNECT_DELAY_MS = 2000;

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
