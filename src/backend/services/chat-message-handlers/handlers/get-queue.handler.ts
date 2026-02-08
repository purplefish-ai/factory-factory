import type { GetQueueMessage } from '@/shared/websocket';
import { claudeSessionAccessor } from '../../../resource_accessors/claude-session.accessor';
import { sessionService } from '../../session.service';
import { sessionStoreService } from '../../session-store.service';
import type { ChatMessageHandler } from '../types';

export function createGetQueueHandler(): ChatMessageHandler<GetQueueMessage> {
  return async ({ ws, sessionId, workingDir }) => {
    const dbSession = await claudeSessionAccessor.findById(sessionId);
    if (!dbSession) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }
    const existingClient = sessionService.getClient(sessionId);
    await sessionStoreService.subscribe({
      sessionId,
      workingDir,
      claudeSessionId: dbSession.claudeSessionId,
      isRunning: existingClient?.isRunning() ?? false,
      isWorking: existingClient?.isWorking() ?? false,
    });
  };
}
