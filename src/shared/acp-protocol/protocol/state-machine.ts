/**
 * Message states for the unified message state machine.
 *
 * User message flow:
 *   PENDING → SENT → ACCEPTED → DISPATCHED → COMMITTED
 *                        ↘ REJECTED/FAILED/CANCELLED
 *
 * Agent message flow:
 *   STREAMING → COMPLETE
 *
 * Runtime values used throughout the codebase for state comparisons.
 */
export enum MessageState {
  // User message states
  PENDING = 'PENDING', // User typed, not yet sent to backend
  SENT = 'SENT', // Sent over WebSocket, awaiting ACK
  ACCEPTED = 'ACCEPTED', // Backend queued (has queuePosition)
  DISPATCHED = 'DISPATCHED', // Sent to ACP runtime
  COMMITTED = 'COMMITTED', // Response complete

  // Error states
  REJECTED = 'REJECTED', // Backend rejected (queue full, etc.)
  FAILED = 'FAILED', // Error during processing
  CANCELLED = 'CANCELLED', // User cancelled

  // Agent message states
  STREAMING = 'STREAMING', // Agent actively generating
  COMPLETE = 'COMPLETE', // Agent finished
}
