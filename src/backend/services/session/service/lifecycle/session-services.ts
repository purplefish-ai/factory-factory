import { agentSessionAccessor } from '@/backend/services/session/resources/agent-session.accessor';
import { acpRuntimeManager } from '@/backend/services/session/service/acp';
import {
  SessionLoadService,
  type SessionLoadDependencies,
} from '@/backend/services/session/service/chat/session-load.service';
import { SessionDispatchService } from '@/backend/services/session/service/dispatch/session-dispatch.service';
import type { SessionDispatchStartOptions } from '@/backend/services/session/service/dispatch/session-dispatch.types';
import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import { slashCommandCacheService } from '@/backend/services/session/service/store/slash-command-cache.service';
import {
  acpEventProcessor,
  claudeModelCatalogService,
  codexModelCatalogService,
  providerUsageService,
  sessionConfigService,
  sessionLifecycleEventService,
  sessionLifecycleGate,
  sessionLifecycleService,
  sessionNotificationDeliveryService,
  sessionPermissionService,
  sessionPromptTurnCompletionService,
  sessionRetryService,
  sessionService,
} from './session-core-services';
import { hydrateProviderHistoryIfNeeded } from './session-provider-history-hydrator';

export type { SessionPromptService } from './session-core-services';
export {
  acpEventProcessor,
  claudeModelCatalogService,
  codexModelCatalogService,
  providerUsageService,
  sessionConfigService,
  sessionLifecycleEventService,
  sessionLifecycleService,
  sessionPermissionService,
  sessionPromptTurnCompletionService,
  sessionRetryService,
  sessionService,
};

export const sessionDispatchService = new SessionDispatchService({
  runtimeManager: acpRuntimeManager,
  configService: sessionConfigService,
  promptService: sessionService,
  backgroundDelivery: sessionBackgroundDeliveryService,
});
const dispatchLifecycle = {
  gate: sessionLifecycleGate,
  notificationDelivery: sessionNotificationDeliveryService,
  startup: {
    getSessionClient: (sessionId: string) => sessionLifecycleService.getSessionClient(sessionId),
    getOrCreateSessionClient: (sessionId: string, options: SessionDispatchStartOptions) =>
      sessionLifecycleService.getOrCreateSessionClient(sessionId, {
        resumePolicy: options.resumePolicy,
        thinkingEnabled: options.thinkingEnabled,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      }),
  },
};

sessionDispatchService.configureLifecycle(dispatchLifecycle);
/** Resource adapters stay in the capsule; application composition supplies runtime capabilities. */
export function createSessionLoadService(
  ports: Omit<
    SessionLoadDependencies,
    'findSession' | 'hydrateProviderHistory' | 'getCachedCommands'
  >
): SessionLoadService {
  return new SessionLoadService({
    ...ports,
    findSession: (sessionId) => agentSessionAccessor.findById(sessionId),
    hydrateProviderHistory: hydrateProviderHistoryIfNeeded,
    getCachedCommands: (provider) => slashCommandCacheService.getCachedCommands(provider),
  });
}
