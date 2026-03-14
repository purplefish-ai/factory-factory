import { DEFAULT_CHAT_QUICK_ACTIONS } from '@/shared/quick-actions/default-chat-actions';

/**
 * Predefined quick actions that send messages to Claude.
 */
export const QUICK_ACTIONS = DEFAULT_CHAT_QUICK_ACTIONS.map((action) => ({
  id: action.id,
  name: action.name,
  icon: action.icon,
  message: action.prompt,
}));

export type QuickAction = (typeof QUICK_ACTIONS)[number];
