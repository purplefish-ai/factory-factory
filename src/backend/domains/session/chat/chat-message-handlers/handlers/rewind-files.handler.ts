import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import type { RewindFilesMessage } from '@/shared/websocket';
import { sendWebSocketError } from './utils';

export function createRewindFilesHandler(): ChatMessageHandler<RewindFilesMessage> {
  return ({ ws }) => {
    sendWebSocketError(ws, 'rewind_files is not supported in ACP runtime');
  };
}
