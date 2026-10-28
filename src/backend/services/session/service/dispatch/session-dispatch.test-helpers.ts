import { acpRuntimeManager } from '@/backend/services/session/service/acp';
import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import {
  sessionConfigService,
  sessionService,
} from '@/backend/services/session/service/lifecycle/session-core-services';
import { SessionQueuedSettings } from '@/backend/services/session/service/lifecycle/session-queued-settings';
import type { SessionConfigService } from '@/backend/services/session/service/lifecycle/session.config.service';
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
    | 'setSessionCollaborationMode'
    | 'setSessionThinkingBudget'
    | 'setSessionModel'
    | 'setSessionReasoningEffort'
  >,
  sessionId: string,
  message: QueuedMessage,
  supportsThinkingBudget: boolean
): Promise<QueuedMessage['settings']> {
  return new SessionQueuedSettings({ getClient: () => undefined }).configure(
    sessionId,
    message,
    supportsThinkingBudget,
    {
      plan: () => service.setSessionCollaborationMode(sessionId, 'plan'),
      thinking: (budget) => service.setSessionThinkingBudget(sessionId, budget),
      model: (model) => service.setSessionModel(sessionId, model),
      reasoning: (effort) => service.setSessionReasoningEffort(sessionId, effort),
    }
  );
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
