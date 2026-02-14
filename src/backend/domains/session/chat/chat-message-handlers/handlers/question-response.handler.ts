import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import type { QuestionResponseMessage } from '@/shared/websocket';
import { sendWebSocketError } from './utils';

export function createQuestionResponseHandler(): ChatMessageHandler<QuestionResponseMessage> {
  return ({ ws }) => {
    sendWebSocketError(ws, 'question_response is not supported in ACP runtime');
  };
}
