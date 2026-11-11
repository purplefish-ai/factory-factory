import type { ChatAction, ChatState, TaskNotification } from '@/client/features/chat/reducer/types';

export function reduceSystemSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'SDK_TASK_NOTIFICATION': {
      const newNotification: TaskNotification = {
        id: crypto.randomUUID(),
        message: action.payload.message,
        timestamp: new Date().toISOString(),
      };
      return {
        ...state,
        taskNotifications: [...state.taskNotifications, newNotification],
      };
    }
    case 'WS_SLASH_COMMANDS':
      return {
        ...state,
        slashCommands: action.payload.commands,
        slashCommandsLoaded: true,
      };
    case 'DISMISS_TASK_NOTIFICATION':
      return {
        ...state,
        taskNotifications: state.taskNotifications.filter(
          (notif) => notif.id !== action.payload.id
        ),
      };
    case 'CLEAR_TASK_NOTIFICATIONS':
      return { ...state, taskNotifications: [] };
    default:
      return state;
  }
}
