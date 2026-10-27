import { agentSessionAccessor } from '@/backend/services/session/resources/agent-session.accessor';
import { SessionLoadService } from '@/backend/services/session/service/chat/session-load.service';
import {
  sessionConfigService,
  sessionLifecycleEventService,
  sessionLifecycleService,
} from '@/backend/services/session/service/lifecycle/session-core-services';
import { hydrateProviderHistoryIfNeeded } from '@/backend/services/session/service/lifecycle/session-provider-history-hydrator';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { slashCommandCacheService } from '@/backend/services/session/service/store/slash-command-cache.service';
import type { LoadSessionMessage } from '@/shared/websocket';

/** Exercise both application stages with each test's external-history and configuration doubles. */
export function createLoadSessionTestHandler(deps: {
  tryDispatchNextMessage(sessionId: string): Promise<void>;
}) {
  const service = new SessionLoadService({
    findSession: (sessionId) => agentSessionAccessor.findById(sessionId),
    hydrateProviderHistory: hydrateProviderHistoryIfNeeded,
    hydrateLifecycleEvents: (sessionId) => sessionLifecycleEventService.hydrate(sessionId),
    getRuntimeSnapshot: (sessionId) => sessionLifecycleService.getRuntimeSnapshot(sessionId),
    domain: sessionDomainService,
    config: sessionConfigService,
    getCachedCommands: (provider) => slashCommandCacheService.getCachedCommands(provider),
    tryDispatchNextMessage: deps.tryDispatchNextMessage,
  });
  return async ({ sessionId, message }: { sessionId: string; message: LoadSessionMessage }) => {
    const prepared = await service.prepareLoad({ sessionId, loadRequestId: message.loadRequestId });
    if (prepared.status === 'error') {
      return prepared.outcome;
    }
    service.captureReplay(prepared);
    await service.completeLoad(prepared);
    return { replies: [] };
  };
}
