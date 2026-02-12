import type { ChatAction, ChatState } from '@/components/chat/reducer/types';

export function reduceRequestSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'WS_PERMISSION_REQUEST':
      return { ...state, pendingRequest: { type: 'permission', request: action.payload } };
    case 'WS_USER_QUESTION':
      return { ...state, pendingRequest: { type: 'question', request: action.payload } };
    case 'PERMISSION_RESPONSE': {
      const shouldDisablePlanMode =
        action.payload.allow &&
        state.pendingRequest.type === 'permission' &&
        state.pendingRequest.request.toolName === 'ExitPlanMode';
      return {
        ...state,
        pendingRequest: { type: 'none' },
        ...(shouldDisablePlanMode && {
          chatSettings: { ...state.chatSettings, planModeEnabled: false },
        }),
      };
    }
    case 'QUESTION_RESPONSE':
      return { ...state, pendingRequest: { type: 'none' } };
    case 'WS_PERMISSION_CANCELLED': {
      const currentRequestId =
        state.pendingRequest.type === 'permission'
          ? state.pendingRequest.request.requestId
          : state.pendingRequest.type === 'question'
            ? state.pendingRequest.request.requestId
            : null;
      if (currentRequestId === action.payload.requestId) {
        return { ...state, pendingRequest: { type: 'none' } };
      }
      return state;
    }
    default:
      return state;
  }
}
