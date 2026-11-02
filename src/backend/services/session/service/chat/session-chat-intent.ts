import { chatIntentAccessor } from '../../resources/chat-intent.accessor';
import { sessionDomainService } from '../session-domain.service';
import { SessionChatIntentService } from './session-chat-intent.service';
export const sessionChatIntentService = new SessionChatIntentService(
  chatIntentAccessor,
  sessionDomainService
);

sessionDomainService.chatIntent = sessionChatIntentService;
