import { createLogger } from '@/backend/services/logger.service';
import { sessionService } from '@/backend/services/session.service';
import type { RewindFilesMessage } from '@/shared/websocket';
import { DEBUG_CHAT_WS } from '../constants';
import type { ChatMessageHandler } from '../types';

const logger = createLogger('chat-message-handlers');

export function createRewindFilesHandler(): ChatMessageHandler<RewindFilesMessage> {
  return async ({ ws, sessionId, message }) => {
    const client = sessionService.getClient(sessionId);
    if (!client) {
      ws.send(
        JSON.stringify({
          type: 'rewind_files_error',
          userMessageId: message.userMessageId,
          rewindError: 'No active client for session',
        })
      );
      return;
    }

    try {
      const response = await client.rewindFiles(message.userMessageId, message.dryRun);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Rewind files request completed', {
          sessionId,
          userMessageId: message.userMessageId,
          dryRun: message.dryRun,
          affectedFiles: response.affected_files?.length ?? 0,
        });
      }
      // Send preview response with affected files list
      ws.send(
        JSON.stringify({
          type: 'rewind_files_preview',
          userMessageId: message.userMessageId,
          dryRun: message.dryRun ?? false,
          affectedFiles: response.affected_files ?? [],
        })
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to rewind files', {
        sessionId,
        userMessageId: message.userMessageId,
        error: errorMessage,
      });
      ws.send(
        JSON.stringify({
          type: 'rewind_files_error',
          userMessageId: message.userMessageId,
          rewindError: `Failed to rewind files: ${errorMessage}`,
        })
      );
    }
  };
}
