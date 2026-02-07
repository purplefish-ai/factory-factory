import { createSessionSwitchResetState } from '../state';
import type { ChatAction, ChatState } from '../types';

function deriveSessionStatus(runtime: ChatState['sessionRuntime']): ChatState['sessionStatus'] {
  switch (runtime.phase) {
    case 'loading':
      return { phase: 'loading' };
    case 'starting':
      return { phase: 'starting' };
    case 'running':
      return { phase: 'running' };
    case 'stopping':
      return { phase: 'stopping' };
    case 'idle':
    case 'error':
      return { phase: 'ready' };
    default:
      return { phase: 'ready' };
  }
}

function deriveProcessStatus(runtime: ChatState['sessionRuntime']): ChatState['processStatus'] {
  if (runtime.processState === 'alive') {
    return { state: 'alive' };
  }
  if (runtime.processState === 'stopped') {
    return runtime.lastExit
      ? {
          state: 'stopped',
          lastExit: {
            code: runtime.lastExit.code,
            exitedAt: runtime.lastExit.timestamp,
            unexpected: runtime.lastExit.unexpected,
          },
        }
      : { state: 'stopped' };
  }
  return { state: 'unknown' };
}

function withRuntime(state: ChatState, runtime: ChatState['sessionRuntime']): ChatState {
  return {
    ...state,
    sessionRuntime: runtime,
    sessionStatus: deriveSessionStatus(runtime),
    processStatus: deriveProcessStatus(runtime),
  };
}

function reduceLegacySessionEvent(state: ChatState, action: ChatAction): ChatState | null {
  switch (action.type) {
    case 'WS_STATUS':
      return withRuntime(state, {
        ...state.sessionRuntime,
        phase: action.payload.running ? 'running' : 'idle',
        processState:
          action.payload.processAlive === undefined
            ? state.sessionRuntime.processState
            : action.payload.processAlive
              ? 'alive'
              : 'stopped',
        activity: action.payload.running ? 'WORKING' : 'IDLE',
        updatedAt: new Date().toISOString(),
      });
    case 'WS_STARTING':
      return withRuntime(state, {
        ...state.sessionRuntime,
        phase: 'starting',
        processState: 'alive',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      });
    case 'WS_STARTED':
      return {
        ...withRuntime(state, {
          ...state.sessionRuntime,
          phase: 'running',
          processState: 'alive',
          activity: 'WORKING',
          updatedAt: new Date().toISOString(),
        }),
        latestThinking: null,
      };
    case 'WS_STOPPED':
      return {
        ...withRuntime(state, {
          ...state.sessionRuntime,
          phase: 'idle',
          processState: 'stopped',
          activity: 'IDLE',
          updatedAt: new Date().toISOString(),
        }),
        toolProgress: new Map(),
        isCompacting: false,
        activeHooks: new Map(),
      };
    case 'WS_PROCESS_EXIT':
      return {
        ...withRuntime(state, {
          ...state.sessionRuntime,
          phase: action.payload.code !== null && action.payload.code !== 0 ? 'error' : 'idle',
          processState: 'stopped',
          activity: 'IDLE',
          lastExit: {
            code: action.payload.code,
            timestamp: new Date().toISOString(),
            unexpected: action.payload.code !== null && action.payload.code !== 0,
          },
          updatedAt: new Date().toISOString(),
        }),
        toolProgress: new Map(),
        isCompacting: false,
        activeHooks: new Map(),
      };
    default:
      return null;
  }
}

export function reduceSessionSlice(state: ChatState, action: ChatAction): ChatState {
  const legacyState = reduceLegacySessionEvent(state, action);
  if (legacyState) {
    return legacyState;
  }

  switch (action.type) {
    case 'SESSION_RUNTIME_SNAPSHOT':
      return withRuntime(state, action.payload.sessionRuntime);
    case 'SESSION_RUNTIME_UPDATED':
      return withRuntime(state, action.payload.sessionRuntime);
    case 'WS_SESSIONS':
      return { ...state, availableSessions: action.payload.sessions };
    case 'SESSION_SWITCH_START':
      return {
        ...state,
        ...createSessionSwitchResetState(),
      };
    case 'SESSION_LOADING_START':
      return withRuntime(state, {
        ...state.sessionRuntime,
        phase: 'loading',
        updatedAt: new Date().toISOString(),
      });
    case 'SESSION_LOADING_END':
      return state.sessionRuntime.phase === 'loading'
        ? withRuntime(state, {
            ...state.sessionRuntime,
            phase: 'idle',
            updatedAt: new Date().toISOString(),
          })
        : state;
    case 'STOP_REQUESTED':
      return withRuntime(state, {
        ...state.sessionRuntime,
        phase: 'stopping',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      });
    default:
      return state;
  }
}
