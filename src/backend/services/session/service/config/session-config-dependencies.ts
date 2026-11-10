import type { AcpRuntimeManager } from '@/backend/services/session/service/acp';
import type { SessionRepository } from '@/backend/services/session/service/data/session.repository';
import type { CodexModelCatalogService } from '@/backend/services/session/service/providers/codex-model-catalog.service';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { SessionLaunchOptionsService } from './session-launch-options.service';
export type SessionConfigServiceDependencies = {
  eventAuthority?: { assertOrdinary(sessionId: string): Promise<void> };
  repository: SessionRepository;
  runtimeManager: AcpRuntimeManager;
  codexModelCatalogService: Pick<CodexModelCatalogService, 'getModels'>;
  sessionDomainService?: SessionDomainService;
  launchOptionsService?: Pick<SessionLaunchOptionsService, 'getOptions'>;
};
