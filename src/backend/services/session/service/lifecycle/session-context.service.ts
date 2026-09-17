import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { PermissionPreset } from '@/backend/services/session/service/acp';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import type { WorkspaceStatus } from '@/shared/core';
import type { SessionRepository } from './session.repository';

const logger = createLogger('session');

export type SessionContext = Readonly<{
  session: AgentSessionRecord;
  workingDir: string;
  resumeProviderSessionId: string | undefined;
  model: string;
  workspaceId: string;
  workspaceStatus: WorkspaceStatus;
  parentWorkspaceId: string | null;
}>;

export interface SessionPermissionPresetPort {
  getPermissionPreset(workflow: string): Promise<PermissionPreset>;
}

type SessionContextServiceDependencies = {
  repository: Pick<SessionRepository, 'getSessionById' | 'getWorkspaceById'>;
  permissionPresetPort: SessionPermissionPresetPort;
};

export class SessionContextService {
  constructor(private readonly dependencies: SessionContextServiceDependencies) {}

  async load(
    sessionId: string,
    preloadedSession?: AgentSessionRecord
  ): Promise<SessionContext | null> {
    const session =
      preloadedSession ?? (await this.dependencies.repository.getSessionById(sessionId));
    if (!session) {
      logger.warn('Session not found when getting options', { sessionId });
      return null;
    }

    const workspace = await this.dependencies.repository.getWorkspaceById(session.workspaceId);
    if (!workspace?.worktreePath) {
      logger.warn('Workspace or worktree not found', {
        sessionId,
        workspaceId: session.workspaceId,
      });
      return null;
    }

    return {
      session,
      workingDir: workspace.worktreePath,
      resumeProviderSessionId: session.providerSessionId ?? undefined,
      model: session.model,
      workspaceId: workspace.id,
      workspaceStatus: workspace.status,
      parentWorkspaceId: workspace.parentWorkspaceId,
    };
  }

  async getOptions(
    sessionId: string
  ): Promise<Omit<SessionContext, 'session' | 'workspaceId' | 'parentWorkspaceId'> | null> {
    const context = await this.load(sessionId);
    if (!context) {
      return null;
    }
    return {
      workingDir: context.workingDir,
      resumeProviderSessionId: context.resumeProviderSessionId,
      model: context.model,
      workspaceStatus: context.workspaceStatus,
    };
  }

  async resolvePermissionPreset(session: AgentSessionRecord): Promise<PermissionPreset> {
    const fallback: PermissionPreset =
      session.workflow === 'ratchet' || session.workflow === ADVERSARIAL_REVIEW_WORKFLOW
        ? 'YOLO'
        : 'STRICT';
    try {
      return await this.dependencies.permissionPresetPort.getPermissionPreset(session.workflow);
    } catch (error) {
      logger.warn('Failed loading user permission preset; using default', {
        workflow: session.workflow,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }
}
