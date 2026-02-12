/**
 * Shared WebSocket configuration for frontend components.
 * This centralizes the WebSocket connection settings used by chat and agent-activity hooks.
 */

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
 * Uses wss:// when the page is served over HTTPS, ws:// otherwise.
 * In development, Vite proxies WebSocket connections to the backend.
 * In production, the backend serves both HTTP and WebSocket on the same port.
 * @param endpoint - The WebSocket endpoint path (e.g., '/chat', '/agent-activity')
 * @param params - Query parameters to append to the URL
 */
export function buildWebSocketUrl(
  endpoint: string,
  params: Record<string, string | undefined>
): string {
  const host = typeof window !== 'undefined' ? window.location.host : 'localhost:3000';
  const protocol =
    typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, value);
    }
  }
  const queryString = query.toString();
  return `${protocol}//${host}${endpoint}?${queryString}`;
}
