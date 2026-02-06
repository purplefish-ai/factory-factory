import { createSessionSwitchResetState } from '../state';
import type { ChatAction, ChatState } from '../types';

function resolveProcessStatus(
  processAlive: boolean | undefined,
  current: ChatState['processStatus']
): ChatState['processStatus'] {
  if (processAlive === undefined) {
    return current;
  }
  if (processAlive) {
    return { state: 'alive' };
  }
  return current.lastExit ? { state: 'stopped', lastExit: current.lastExit } : { state: 'stopped' };
}

export function reduceSessionSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'WS_STATUS':
      return {
        ...state,
        sessionStatus: action.payload.running ? { phase: 'running' } : { phase: 'ready' },
        processStatus: resolveProcessStatus(action.payload.processAlive, state.processStatus),
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
    case 'SESSION_LOADING_END':
      // Only clear loading if still in loading phase (avoid overriding a valid status)
      return state.sessionStatus.phase === 'loading'
        ? { ...state, sessionStatus: { phase: 'ready' } }
        : state;
    case 'STOP_REQUESTED':
      return { ...state, sessionStatus: { phase: 'stopping' } };
    default:
      return state;
  }
}
