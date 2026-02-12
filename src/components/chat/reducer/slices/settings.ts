import type { ChatAction, ChatState } from '@/components/chat/reducer/types';

export function reduceSettingsSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'UPDATE_SETTINGS':
      return { ...state, chatSettings: { ...state.chatSettings, ...action.payload } };
    case 'SET_SETTINGS':
      return { ...state, chatSettings: action.payload };
    default:
      return state;
  }
}
