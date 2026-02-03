import { createSessionSwitchResetState } from '../state';
import type { ChatAction, ChatState } from '../types';

export function reduceSessionSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'WS_STATUS':
      return {
        ...state,
        sessionStatus: action.payload.running ? { phase: 'running' } : { phase: 'ready' },
        processStatus:
          action.payload.processAlive === undefined
            ? state.processStatus
            : action.payload.processAlive
              ? { state: 'alive' }
              : state.processStatus.lastExit
                ? { state: 'stopped', lastExit: state.processStatus.lastExit }
                : { state: 'stopped' },
      };
    case 'WS_STARTING':
      return { ...state, sessionStatus: { phase: 'starting' } };
    case 'WS_STARTED':
      return {
        ...state,
        sessionStatus: { phase: 'running' },
        processStatus: { state: 'alive' },
        latestThinking: null,
      };
    case 'WS_STOPPED':
      return {
        ...state,
        sessionStatus: { phase: 'ready' },
        processStatus: state.processStatus.lastExit
          ? { state: 'stopped', lastExit: state.processStatus.lastExit }
          : { state: 'stopped' },
        toolProgress: new Map(),
        isCompacting: false,
        activeHooks: new Map(),
      };
    case 'WS_PROCESS_EXIT': {
      const exitedAt = new Date().toISOString();
      return {
        ...state,
        sessionStatus: { phase: 'ready' },
        processStatus: {
          state: 'stopped',
          lastExit: {
            code: action.payload.code,
            exitedAt,
            unexpected: action.payload.code !== null && action.payload.code !== 0,
          },
        },
        toolProgress: new Map(),
        isCompacting: false,
        activeHooks: new Map(),
      };
    }
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
