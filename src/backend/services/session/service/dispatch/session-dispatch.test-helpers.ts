import { acpRuntimeManager } from '@/backend/services/session/service/acp';
import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import {
  sessionConfigService,
  sessionService,
} from '@/backend/services/session/service/lifecycle/session-core-services';
import type { QueuedMessage } from '@/shared/acp-protocol';
import { SessionQueuedSettings } from '../lifecycle/session-queued-settings';
import type { SessionConfigService } from '../lifecycle/session.config.service';
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
