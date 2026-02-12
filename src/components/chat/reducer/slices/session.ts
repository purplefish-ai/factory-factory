import { createSessionSwitchResetState } from '@/components/chat/reducer/state';
import type { ChatAction, ChatState } from '@/components/chat/reducer/types';

function deriveSessionStatus(runtime: ChatState['sessionRuntime']): ChatState['sessionStatus'] {
  switch (runtime.phase) {
    case 'loading':
      return { phase: 'loading' };
    case 'starting':
      return { phase: 'starting' };
    case 'stopping':
      return { phase: 'stopping' };
    case 'running':
      // If process is stopped, show ready instead of running
      if (runtime.processState === 'stopped') {
        return { phase: 'ready' };
      }
      return { phase: 'running' };
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

function shouldResetRuntimeTransientState(runtime: ChatState['sessionRuntime']): boolean {
  return runtime.processState === 'stopped' || runtime.phase === 'error';
}

function applyRuntime(state: ChatState, runtime: ChatState['sessionRuntime']): ChatState {
  const next = withRuntime(state, runtime);
  if (!shouldResetRuntimeTransientState(runtime)) {
    return next;
  }

  return {
    ...next,
    toolProgress: new Map(),
    isCompacting: false,
    activeHooks: new Map(),
  };
}

export function reduceSessionSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'SESSION_SNAPSHOT':
      return applyRuntime(state, action.payload.sessionRuntime);
    case 'SESSION_RUNTIME_SNAPSHOT':
      return applyRuntime(state, action.payload.sessionRuntime);
    case 'SESSION_RUNTIME_UPDATED':
      return applyRuntime(state, action.payload.sessionRuntime);
    case 'WS_SESSIONS':
      return { ...state, availableSessions: action.payload.sessions };
    case 'SESSION_SWITCH_START':
      return {
        ...state,
        ...createSessionSwitchResetState(),
        // Preserve queued messages - they will be reconstructed from replay events,
        // but preserving them ensures they remain visible during session switch.
        queuedMessages: state.queuedMessages,
      };
    case 'SESSION_LOADING_START': {
      const loadingRuntime = {
        ...state.sessionRuntime,
        phase: 'loading' as const,
        updatedAt: new Date().toISOString(),
      };
      return {
        ...state,
        sessionRuntime: loadingRuntime,
        sessionStatus: deriveSessionStatus(loadingRuntime),
        // Preserve processStatus — SESSION_LOADING_START only signals a UI loading
        // transition and should not re-derive processStatus from the runtime defaults.
        // This keeps the initial 'unknown' state until SESSION_SNAPSHOT arrives.
      };
    }
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
