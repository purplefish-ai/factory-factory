import type { AcpRuntimeManager } from '@/backend/services/session/service/acp';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { SessionChatIntentService } from '../chat/session-chat-intent.service';
import type { CodexModelCatalogService } from './codex-model-catalog.service';
import type { SessionLaunchOptionsService } from './session-launch-options.service';
import type { SessionRepository } from './session.repository';
export type SessionConfigServiceDependencies = {
  chatIntent?: Pick<SessionChatIntentService, 'override'>;
  eventAuthority?: { assertOrdinary(sessionId: string): Promise<void> };
  repository: SessionRepository;
  runtimeManager: AcpRuntimeManager;
  codexModelCatalogService: Pick<CodexModelCatalogService, 'getModels'>;
  sessionDomainService?: SessionDomainService;
  launchOptionsService?: Pick<SessionLaunchOptionsService, 'getOptions'>;
};
