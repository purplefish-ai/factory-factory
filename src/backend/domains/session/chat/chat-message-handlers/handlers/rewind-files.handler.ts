import { DEBUG_CHAT_WS } from '@/backend/domains/session/chat/chat-message-handlers/constants';
import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { sessionService } from '@/backend/domains/session/lifecycle/session.service';
import { createLogger } from '@/backend/services/logger.service';
import type { RewindFilesMessage } from '@/shared/websocket';

const logger = createLogger('chat-message-handlers');

export function createRewindFilesHandler(): ChatMessageHandler<RewindFilesMessage> {
  return async ({ ws, sessionId, message }) => {
    try {
      const response = await sessionService.rewindSessionFiles(
        sessionId,
        message.userMessageId,
        message.dryRun
      );
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
