import type { ChatAction, ChatState, TaskNotification } from '../types';

export function reduceSystemSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'SDK_STATUS_UPDATE': {
      const { permissionMode } = action.payload;
      if (permissionMode !== undefined) {
        return { ...state, permissionMode };
      }
      return state;
    }
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
    case 'SYSTEM_INIT':
      return { ...state, sessionInitData: action.payload, slashCommandsLoaded: true };
    case 'HOOK_STARTED': {
      const { hookId, hookName, hookEvent } = action.payload;
      const newActiveHooks = new Map(state.activeHooks);
      newActiveHooks.set(hookId, {
        hookId,
        hookName,
        hookEvent,
        startedAt: new Date().toISOString(),
      });
      return { ...state, activeHooks: newActiveHooks };
    }
    case 'HOOK_RESPONSE': {
      const newActiveHooks = new Map(state.activeHooks);
      newActiveHooks.delete(action.payload.hookId);
      return { ...state, activeHooks: newActiveHooks };
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
