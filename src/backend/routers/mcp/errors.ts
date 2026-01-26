/**
 * Tools that are critical for agent operation
 * Failures of these tools should be escalated immediately
 */
export const CRITICAL_TOOLS = ['mcp__system__get_status', 'mcp__git__read_file'];

/**
 * Check if an error is transient (retryable)
 */
export function isTransientError(error: Error): boolean {
  const transientPatterns = [
    /timeout/i,
    /connection/i,
    /network/i,
    /temporary/i,
    /ECONNREFUSED/i,
    /ETIMEDOUT/i,
    /ENOTFOUND/i,
  ];

  return transientPatterns.some((pattern) => pattern.test(error.message));
}
