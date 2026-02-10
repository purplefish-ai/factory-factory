import type { ListSessionsMessage } from '@/shared/websocket';
import { SessionManager } from '../../../claude/index';
import type { ChatMessageHandler } from '../types';

export function createListSessionsHandler(): ChatMessageHandler<ListSessionsMessage> {
  return async ({ ws, workingDir }) => {
    const sessions = await SessionManager.listSessions(workingDir);
    ws.send(JSON.stringify({ type: 'sessions', sessions }));
  };
}
