import type { RewindFilesMessage } from '@/shared/websocket';
import { createLogger } from '../../logger.service';
import { sessionService } from '../../session.service';
import { DEBUG_CHAT_WS } from '../constants';
import type { ChatMessageHandler } from '../types';

const logger = createLogger('chat-message-handlers');

export function createRewindFilesHandler(): ChatMessageHandler {
  return async ({ ws, sessionId, message }) => {
    const typedMessage = message as RewindFilesMessage;
    const client = sessionService.getClient(sessionId);
    if (!client) {
      ws.send(
        JSON.stringify({
          type: 'rewind_files_error',
          userMessageId: typedMessage.userMessageId,
          rewindError: 'No active client for session',
        })
      );
      return;
    }

    try {
      const response = await client.rewindFiles(typedMessage.userMessageId, typedMessage.dryRun);
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Rewind files request completed', {
          sessionId,
          userMessageId: typedMessage.userMessageId,
          dryRun: typedMessage.dryRun,
          affectedFiles: response.affected_files?.length ?? 0,
        });
      }
      // Send preview response with affected files list
      ws.send(
        JSON.stringify({
          type: 'rewind_files_preview',
          userMessageId: typedMessage.userMessageId,
          dryRun: typedMessage.dryRun ?? false,
          affectedFiles: response.affected_files ?? [],
        })
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Chat WS] Failed to rewind files', {
        sessionId,
        userMessageId: typedMessage.userMessageId,
        error: errorMessage,
      });
      ws.send(
        JSON.stringify({
          type: 'rewind_files_error',
          userMessageId: typedMessage.userMessageId,
          rewindError: `Failed to rewind files: ${errorMessage}`,
        })
      );
    }
  };
}
