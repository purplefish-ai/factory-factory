import { SessionManager } from '../../../claude/index';
import { sessionService } from '../../session.service';
import type { ChatMessageHandler } from '../types';

export function createGetHistoryHandler(): ChatMessageHandler {
  return async ({ ws, sessionId, workingDir }) => {
    const client = sessionService.getClient(sessionId);
    const claudeSessionId = client?.getClaudeSessionId();
    if (claudeSessionId) {
      const history = await SessionManager.getHistory(claudeSessionId, workingDir);
      ws.send(JSON.stringify({ type: 'history', dbSessionId: sessionId, messages: history }));
    } else {
      ws.send(JSON.stringify({ type: 'history', dbSessionId: sessionId, messages: [] }));
    }
  };
}
