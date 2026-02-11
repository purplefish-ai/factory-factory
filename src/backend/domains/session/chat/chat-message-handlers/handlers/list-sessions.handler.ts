import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { SessionManager } from '@/backend/domains/session/claude/index';
import type { ListSessionsMessage } from '@/shared/websocket';

export function createListSessionsHandler(): ChatMessageHandler<ListSessionsMessage> {
  return async ({ ws, workingDir }) => {
    const sessions = await SessionManager.listSessions(workingDir);
    ws.send(JSON.stringify({ type: 'sessions', sessions }));
  };
}
