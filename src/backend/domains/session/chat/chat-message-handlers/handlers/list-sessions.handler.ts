import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { SessionFileReader } from '@/backend/domains/session/data/session-file-reader';
import type { ListSessionsMessage } from '@/shared/websocket';

export function createListSessionsHandler(): ChatMessageHandler<ListSessionsMessage> {
  return async ({ ws, workingDir }) => {
    const sessions = await SessionFileReader.listSessions(workingDir);
    ws.send(JSON.stringify({ type: 'sessions', sessions }));
  };
}
