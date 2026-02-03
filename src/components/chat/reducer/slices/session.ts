import { createSessionSwitchResetState } from '../state';
import type { ChatAction, ChatState } from '../types';

export function reduceSessionSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'WS_STATUS':
      return {
        ...state,
        sessionStatus: action.payload.running ? { phase: 'running' } : { phase: 'ready' },
      };
    case 'WS_STARTING':
      return { ...state, sessionStatus: { phase: 'starting' } };
    case 'WS_STARTED':
      return { ...state, sessionStatus: { phase: 'running' }, latestThinking: null };
    case 'WS_STOPPED':
      return {
        ...state,
        sessionStatus: { phase: 'ready' },
        toolProgress: new Map(),
        isCompacting: false,
        activeHooks: new Map(),
      };
    case 'WS_SESSIONS':
      return { ...state, availableSessions: action.payload.sessions };
    case 'SESSION_SWITCH_START':
      return {
        ...state,
        ...createSessionSwitchResetState(),
      };
    case 'SESSION_LOADING_START':
      return { ...state, sessionStatus: { phase: 'loading' } };
    case 'STOP_REQUESTED':
      return { ...state, sessionStatus: { phase: 'stopping' } };
    default:
      return state;
  }
}
