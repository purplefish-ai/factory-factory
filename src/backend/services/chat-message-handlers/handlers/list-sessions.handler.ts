import { SessionManager } from '../../../claude/index';
import type { ChatMessageHandler } from '../types';

export function createListSessionsHandler(): ChatMessageHandler {
  return async ({ ws, workingDir }) => {
    const sessions = await SessionManager.listSessions(workingDir);
    ws.send(JSON.stringify({ type: 'sessions', sessions }));
  };
}
