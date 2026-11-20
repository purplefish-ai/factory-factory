/**
 * Chat state reducer for managing chat UI state.
 *
 * This reducer handles all state transitions for the chat interface:
 * - WebSocket message handling
 * - Session management (loading, switching)
 * - Permission and question requests
 * - Tool input streaming updates
 *
 * The state is designed to be used with useReducer for predictable updates.
 */

import type { ChatMessage, SessionDeltaEvent } from '@/lib/chat-protocol';
import { generateMessageId } from './helpers';
import { runRendererTranscriptBatch } from './renderer-indexes';
import { reduceMessageCompactSlice } from './slices/messages/compact';
import { reduceMessageQueueSlice } from './slices/messages/queue';
import { reduceMessageResetSlice } from './slices/messages/reset';
import { reduceSessionStateDeltaSlice } from './slices/messages/session-state-delta';
import { reduceMessageSnapshotSlice } from './slices/messages/snapshot';
import { reduceMessageStateMachineSlice } from './slices/messages/state-machine';
import { reduceMessageTransportSlice } from './slices/messages/transport';
import { reduceRequestSlice } from './slices/requests';
import { reduceSessionSlice } from './slices/session';
import { reduceSettingsSlice } from './slices/settings';
import { reduceSystemSlice } from './slices/system';
import { reduceToolingSlice } from './slices/tooling';
import { reduceTranscriptHistory } from './slices/transcript-history';
import { createBaseResetState, createInitialChatState } from './state';
import type { ChatAction, ChatState } from './types';
import { createActionFromWebSocketMessage } from './websocket-actions';

export type {
  AcpConfigOption,
  AcpConfigOptionGroup,
  AcpConfigOptionValue,
  AcpPlanEntry,
  AcpPlanState,
  AcpToolLocation,
  ChatAction,
  ChatState,
  PendingMessageContent,
  PendingRequest,
  ProcessStatus,
  RejectedMessageInfo,
  SessionStatus,
  StreamDeltaAction,
  TaskNotification,
  ToolProgressInfo,
} from './types';
export { createActionFromWebSocketMessage, createInitialChatState };

// =============================================================================
// Reducer Slices
// =============================================================================

type ReducerSlice = (state: ChatState, action: ChatAction) => ChatState;

// =============================================================================
// Reducer
// =============================================================================

const chatReducerSlices: ReducerSlice[] = [
  reduceSessionSlice,
  reduceTranscriptHistory,
  reduceRequestSlice,
  reduceSettingsSlice,
  reduceMessageTransportSlice,
  reduceMessageQueueSlice,
  reduceMessageResetSlice,
  reduceMessageSnapshotSlice,
  reduceSessionStateDeltaSlice,
  reduceMessageStateMachineSlice,
  reduceMessageCompactSlice,
  reduceToolingSlice,
  reduceSystemSlice,
];

function reduceSingleAction(currentState: ChatState, currentAction: ChatAction): ChatState {
  let nextState = currentState;
  for (const reduce of chatReducerSlices) {
    const updated = reduce(nextState, currentAction);
    if (updated !== nextState) {
      nextState = updated;
    }
  }
  return nextState;
}

function createReplayBaseState(state: ChatState, replayEvents: SessionDeltaEvent[]): ChatState {
  // Retain local recovery metadata only for messages this replay accounts for.
  const queuedMessages: ChatState['queuedMessages'] = new Map();
  for (const event of replayEvents) {
    if (event.type === 'message_state_changed') {
      const previous = state.queuedMessages.get(event.id);
      if (previous) {
        queuedMessages.set(event.id, previous);
      }
    }
  }
  return {
    ...state,
    ...createBaseResetState(),
    rendererTranscriptLimit:
      state.transcriptPageBoundaries.size > 0 ? undefined : state.rendererTranscriptLimit,
    // Preserve optimistic pending sends that are not yet reflected in replayed events.
    pendingMessages: state.pendingMessages,
    pendingSteer: state.pendingSteer,
    queuedMessages,
    // Preserve rejected-message recovery content until the UI effect restores it.
    lastRejectedMessage: state.lastRejectedMessage,
    sessionStatus: { phase: 'loading' },
    processStatus: { state: 'unknown' },
    sessionRuntime: {
      ...state.sessionRuntime,
      phase: 'loading',
      processState: 'unknown',
      activity: 'IDLE',
      updatedAt: new Date().toISOString(),
    },
  };
}

function replaySessionEvents(state: ChatState, replayEvents: SessionDeltaEvent[]): ChatState {
  let nextState = createReplayBaseState(state, replayEvents);
  for (const event of replayEvents) {
    const replayAction = createActionFromWebSocketMessage(event);
    if (replayAction) {
      nextState = reduceSingleAction(nextState, replayAction);
    }
  }
  // Clear loading state after replay completes
  // Only clear if still in loading phase (runtime updates during replay may have already changed it)
  if (nextState.sessionStatus.phase === 'loading') {
    nextState = reduceSingleAction(nextState, { type: 'SESSION_LOADING_END' });
  }
  // Replayed thinking starts belong to history. Live deltas need a fresh start.
  return nextState.openThinkingBlocks.size > 0
    ? { ...nextState, openThinkingBlocks: new Map() }
    : nextState;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === 'SESSION_REPLAY_BATCH') {
    const { replayEvents } = action.payload;
    // One batch, so transcript lookups grow in place across replayed messages
    // instead of being copied for each one.
    return runRendererTranscriptBatch(() => replaySessionEvents(state, replayEvents));
  }

  if (action.type === 'STREAM_DELTA_BATCH') {
    // Reducing each buffered delta in order yields exactly the state that
    // dispatching them one at a time would have committed.
    return runRendererTranscriptBatch(() =>
      action.payload.actions.reduce(reduceSingleAction, state)
    );
  }

  return reduceSingleAction(state, action);
}

// =============================================================================
// Action Creators (for type-safe dispatch)
// =============================================================================

/**
 * Creates a user message action.
 */
export function createUserMessageAction(text: string, order: number): ChatAction {
  const chatMessage: ChatMessage = {
    id: generateMessageId(),
    source: 'user',
    text,
    timestamp: new Date().toISOString(),
    order,
  };
  return { type: 'USER_MESSAGE_SENT', payload: chatMessage };
}
