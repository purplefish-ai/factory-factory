import { acpRuntimeManager } from '@/backend/services/session/service/acp';
import {
  sessionConfigService,
  sessionService,
} from '@/backend/services/session/service/composition/session-core-services';
import { SessionQueuedSettings } from '@/backend/services/session/service/config/session-queued-settings';
import type { SessionConfigService } from '@/backend/services/session/service/config/session.config.service';
import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/delivery/session-background-delivery.service';
import type { QueuedMessage } from '@/shared/acp-protocol';
import { SessionDispatchService } from './session-dispatch.service';

/** Supplies the same infrastructure ports as production; individual suites retain their mocks. */
export function createTestSessionDispatcher(): SessionDispatchService {
  return new SessionDispatchService({
    runtimeManager: acpRuntimeManager,
    configService: sessionConfigService,
    promptService: sessionService,
    backgroundDelivery: sessionBackgroundDeliveryService,
  });
}

export function configureTestQueuedMessage(
  service: Pick<
    SessionConfigService,
    'setSessionCollaborationMode' | 'setSessionModel' | 'setSessionReasoningEffort'
  >,
  sessionId: string,
  message: QueuedMessage
): Promise<QueuedMessage['settings']> {
  return new SessionQueuedSettings({ getClient: () => undefined }).configure(sessionId, message, {
    plan: () => service.setSessionCollaborationMode(sessionId, 'plan'),
    model: (model) => service.setSessionModel(sessionId, model),
    reasoning: (effort) => service.setSessionReasoningEffort(sessionId, effort),
  });
}

export function createAttachmentMessage(message: QueuedMessage): QueuedMessage {
  return {
    ...message,
    text: 'preserve this draft',
    attachments: [
      {
        id: 'attachment-1',
        name: 'notes.txt',
        type: 'text/plain',
        size: 11,
        data: 'draft notes',
        contentType: 'text',
      },
    ],
  };
}
