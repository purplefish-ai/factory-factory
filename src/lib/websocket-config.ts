/**
 * Shared WebSocket configuration for frontend components.
 * This centralizes the WebSocket connection settings used by chat and agent-activity hooks.
 */

/**
 * Base delay in milliseconds for exponential backoff.
 */
export const RECONNECT_BASE_DELAY_MS = 1000;

/**
 * Maximum delay in milliseconds for exponential backoff.
 *
 * The transport never stops retrying, so this cap is how long a tab can lag
 * behind a server that has come back: 1s, 2s, 4s, 8s, then 10s (plus up to 25%
 * jitter). An attempt against a local or tailnet server costs one failed
 * connection, so a short cap is cheap, and returning to the tab or the network
 * coming back retries at once regardless.
 */
export const RECONNECT_MAX_DELAY_MS = 10_000;

/**
 * How long one attempt may stay opening before it is abandoned and retried. A
 * stopped server's kernel still accepts connections, so without this an
 * attempt could hang with the browser's own, much longer, timeout. It matches
 * the 30 s the transport gives an open connection that stopped answering
 * (`LIVENESS_ABANDON_AFTER_MS`): an overloaded server that is slow to finish
 * an upgrade is not handed a fresh one every few seconds. Closing an abandoned
 * attempt is all the client can do; a server that completes the upgrade later
 * sees the client's close at once.
 */
export const CONNECT_TIMEOUT_MS = 30_000;

/**
 * How long a connection must stay open, and answering when the server pings,
 * before the backoff starts again from its shortest delay.
 */
export const STABLE_CONNECTION_MS = 10_000;

/**
 * Calculate reconnection delay with exponential backoff and jitter.
 * @param attempt - The current reconnection attempt number (0-indexed)
 * @returns Delay in milliseconds
 */
export function getReconnectDelay(attempt: number): number {
  // Exponential backoff: 1s, 2s, 4s, 8s, capped at 10s
  const baseDelay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
  // Add jitter (0-25%) to prevent thundering herd
  const jitter = Math.random() * baseDelay * 0.25;
  return baseDelay + jitter;
}

/**
 * Constructs a WebSocket URL for the given endpoint with query parameters.
 * Uses a root-absolute path (e.g. '/chat?...') so the proxy's monkey-patched
 * WebSocket constructor can intercept and prepend the proxy path prefix.
 * Hardcoding ws://host bypasses the proxy tunnel entirely.
 * In development, Vite proxies WebSocket connections to the backend.
 * In production, the backend serves both HTTP and WebSocket on the same port.
 * @param endpoint - The WebSocket endpoint path (e.g., '/chat', '/agent-activity')
 * @param params - Query parameters to append to the URL
 */
export function buildWebSocketUrl(
  endpoint: string,
  params: Record<string, string | undefined>
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, value);
    }
  }
  const queryString = query.toString();
  return `${endpoint}?${queryString}`;
}
