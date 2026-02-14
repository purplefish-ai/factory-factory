import type { ChatMessage } from './messages';
import type { QueuedMessage } from './queued';

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
 * Note: For type-safe state handling in discriminated unions, prefer using
 * `UserMessageState` or `AgentMessageState` type aliases. This enum provides
 * runtime values and is used throughout the codebase for state comparisons.
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

/**
 * Valid states for user messages.
 * User messages flow through: PENDING → SENT → ACCEPTED → DISPATCHED → COMMITTED
 * Or can terminate early with: REJECTED | FAILED | CANCELLED
 */
export type UserMessageState =
  | 'PENDING'
  | 'SENT'
  | 'ACCEPTED'
  | 'DISPATCHED'
  | 'COMMITTED'
  | 'REJECTED'
  | 'FAILED'
  | 'CANCELLED';

/**
 * Valid states for agent messages.
 * Agent messages flow through: STREAMING → COMPLETE
 */
export type AgentMessageState = 'STREAMING' | 'COMPLETE';

/**
 * User message with state - has required user-specific fields.
 * The `type: 'user'` discriminant enables type narrowing.
 */
export interface UserMessageWithState {
  id: string;
  type: 'user';
  state: UserMessageState;
  timestamp: string;
  /** User message text - required for user messages */
  text: string;
  /** Optional file attachments */
  attachments?: import('./queued').MessageAttachment[];
  /** User message settings (model, thinking, plan mode) */
  settings?: QueuedMessage['settings'];
  /** Queue position when in ACCEPTED state */
  queuePosition?: number;
  /** Error message for REJECTED/FAILED states */
  errorMessage?: string;
  /** Backend-assigned order for reliable sorting (monotonically increasing per session).
   * Assigned when message transitions to DISPATCHED state (when sent to agent),
   * not when queued. Undefined for ACCEPTED (queued) messages. */
  order?: number;
}

/**
 * Agent message with state - has required agent-specific fields.
 * The `type: 'agent'` discriminant enables type narrowing.
 */
export interface AgentMessageWithState {
  id: string;
  type: 'agent';
  state: AgentMessageState;
  timestamp: string;
  /** Pre-built ChatMessages for snapshot restoration - same format frontend uses */
  chatMessages: ChatMessage[];
  /** Backend-assigned order for reliable sorting (monotonically increasing per session) */
  order: number;
}

/**
 * Unified message type with state for the message state machine.
 * This is a discriminated union - use `msg.type` to narrow to the specific type.
 */
export type MessageWithState = UserMessageWithState | AgentMessageWithState;

/**
 * Type guard to check if a MessageWithState is a UserMessageWithState.
 * Use this for type-safe handling of user messages.
 */
export function isUserMessage(msg: MessageWithState): msg is UserMessageWithState {
  return msg.type === 'user';
}

/**
 * Type guard to check if a MessageWithState is an AgentMessageWithState.
 * Use this for type-safe handling of agent messages.
 */
export function isAgentMessage(msg: MessageWithState): msg is AgentMessageWithState {
  return msg.type === 'agent';
}
