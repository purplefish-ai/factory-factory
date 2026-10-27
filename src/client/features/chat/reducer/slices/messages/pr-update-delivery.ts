import {
  applyRendererMessages,
  insertMessageByOrder,
} from '@/client/features/chat/reducer/helpers';
import type { ChatState } from '@/client/features/chat/reducer/types';
import { QUEUED_MESSAGE_ORDER_BASE, type QueuedMessage } from '@/lib/chat-protocol';
import { PR_EVENT_MESSAGE_ID_PREFIX, type PRUpdateDeliveryState } from '@/shared/pr-monitoring';

export function retainPRUpdateOutcome(
  state: ChatState,
  id: string,
  deliveryState: Extract<PRUpdateDeliveryState, 'failed' | 'cancelled'>,
  error?: string,
  userMessage?: Pick<QueuedMessage, 'text' | 'timestamp'>
): ChatState | null {
  const existing = state.messages.find((message) => message.id === id);
  if (!(id.startsWith(PR_EVENT_MESSAGE_ID_PREFIX) || existing?.message?.type === 'pr_update')) {
    return null;
  }
  const queued = state.queuedMessages.get(id);
  const pending = state.pendingMessages.get(id);
  const queuedMessages = new Map(state.queuedMessages);
  queuedMessages.delete(id);
  const pendingMessages = new Map(state.pendingMessages);
  pendingMessages.delete(id);
  return applyRendererMessages(
    { ...state, queuedMessages, pendingMessages },
    insertMessageByOrder(
      state.messages.filter((message) => message.id !== id),
      {
        id,
        source: 'agent',
        order: existing?.order ?? QUEUED_MESSAGE_ORDER_BASE,
        timestamp:
          existing?.timestamp ??
          queued?.timestamp ??
          userMessage?.timestamp ??
          new Date().toISOString(),
        message: {
          type: 'pr_update',
          prDeliveryState: deliveryState,
          text:
            existing?.message?.text ??
            existing?.text ??
            queued?.text ??
            pending?.text ??
            userMessage?.text ??
            'PR update',
          ...(error ? { error } : {}),
        },
      }
    )
  );
}
