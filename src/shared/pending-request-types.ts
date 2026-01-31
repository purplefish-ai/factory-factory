/**
 * Shared types for pending interactive requests.
 * Used by both frontend and backend for session restore functionality.
 */

/**
 * Pending interactive request stored for session restore.
 * When a user navigates away and returns, we need to restore the modal.
 */
export interface PendingInteractiveRequest {
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  /** Plan content for ExitPlanMode requests */
  planContent: string | null;
  timestamp: string;
}
