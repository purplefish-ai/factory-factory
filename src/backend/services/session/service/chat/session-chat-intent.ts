import { chatIntentAccessor } from '@/backend/services/session/resources/chat-intent.accessor';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { SessionChatIntentService } from './session-chat-intent.service';
export const sessionChatIntentService = new SessionChatIntentService(
  chatIntentAccessor,
  sessionDomainService
);

sessionDomainService.chatIntent = sessionChatIntentService;
