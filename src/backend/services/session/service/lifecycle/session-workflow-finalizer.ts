import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpRuntimeManager } from '@/backend/services/session/service/acp';
import type {
  RatchetSessionEndOutcome,
  SessionAutoIterationExitBridge,
  SessionLifecycleWorkspaceBridge,
} from '@/backend/services/session/service/bridges';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { PersistClosedSessionInput } from './closed-session-persistence.service';
import type { SessionRepository } from './session.repository';
import type { SessionLifecycleEventService } from './session-lifecycle-event.service';
import { maybeDiscoverPROnSessionEnd } from './session-pr-discovery.service';

const logger = createLogger('session-workflow-finalizer');

type HydrateProviderHistory = (
  sessionId: string,
  session: AgentSessionRecord & { workspace: { worktreePath: string | null } }
) => Promise<void>;

type WorkflowFinalizerDependencies = {
  repository: Pick<
    SessionRepository,
    'getSessionById' | 'deleteSession' | 'recoverStaleRunningSessions'
  >;
  workspaceLookup: {
    findById(workspaceId: string): Promise<{ worktreePath: string | null } | null>;
  };
  sessionDomainService: Pick<SessionDomainService, 'clearSession' | 'getTranscriptSnapshot'>;
  closedSessionPersistenceService: {
    persistClosedSession(input: PersistClosedSessionInput): Promise<void>;
  };
  lifecycleEventService: Pick<SessionLifecycleEventService, 'hydrate'>;
  hydrateProviderHistory: HydrateProviderHistory;
  runtimeManager: Pick<AcpRuntimeManager, 'isSessionRunning'>;
  countViewers(sessionId: string): number;
};

export class SessionWorkflowFinalizer {
  private workspaceBridge: SessionLifecycleWorkspaceBridge | null = null;
  private autoIterationExitBridge: SessionAutoIterationExitBridge | null = null;

  constructor(private readonly dependencies: WorkflowFinalizerDependencies) {}

  configure(bridges: {
    workspace: SessionLifecycleWorkspaceBridge;
    autoIterationExit?: SessionAutoIterationExitBridge;
  }): void {
    this.workspaceBridge = bridges.workspace;
    this.autoIterationExitBridge = bridges.autoIterationExit ?? null;
  }

  async finalizeDeliberateStop(input: {
    session: AgentSessionRecord | null;
    sessionId: string;
    cleanupTransientRatchetSession: boolean;
  }): Promise<void> {
    const { session, sessionId, cleanupTransientRatchetSession } = input;
    if (session?.workflow !== 'ratchet') {
      return;
    }

    try {
      await this.recordRatchetSessionEnd(session.workspaceId, sessionId, 'COMPLETED');
    } catch (error) {
      logger.warn('Failed settling ratchet dispatch record during stop', {
        sessionId,
        workspaceId: session.workspaceId,
        error: toErrorMessage(error),
      });
    }

    if (!cleanupTransientRatchetSession) {
      return;
    }

    await this.cleanupTransientRatchetSession(sessionId, 'stop');
  }

  async finalizeRuntimeExit(input: {
    session: AgentSessionRecord;
    sessionId: string;
    exitCode: number | null;
    deliberate: boolean;
  }): Promise<void> {
    const { session, sessionId, exitCode, deliberate } = input;
    if (session.workflow === 'ratchet') {
      const outcome: RatchetSessionEndOutcome = exitCode === 0 || deliberate ? 'COMPLETED' : 'DIED';
      await this.recordRatchetSessionEnd(session.workspaceId, sessionId, outcome);
    }

    if (this.workspaceBridge) {
      void maybeDiscoverPROnSessionEnd(session.workspaceId, logger, this.workspaceBridge);
    }

    if (session.workflow === 'ratchet') {
      await this.cleanupTransientRatchetSession(sessionId, 'exit');
    }

    if (session.workflow === 'auto-iteration' && !deliberate) {
      this.autoIterationExitBridge?.onAutoIterationSessionExit(session.workspaceId, sessionId);
    }
  }

  async persistClosedSession(sessionId: string): Promise<void> {
    const session = await this.dependencies.repository.getSessionById(sessionId);
    if (!session) {
      logger.warn('Cannot persist closed session: session not found', { sessionId });
      return;
    }

    const workspace = await this.dependencies.workspaceLookup.findById(session.workspaceId);
    if (!workspace?.worktreePath) {
      logger.warn('Cannot persist closed session: no worktree path', {
        sessionId,
        workspaceId: session.workspaceId,
      });
      return;
    }

    await this.dependencies.hydrateProviderHistory(sessionId, {
      ...session,
      workspace: { worktreePath: workspace.worktreePath },
    });
    await this.dependencies.lifecycleEventService.hydrate(sessionId);

    await this.dependencies.closedSessionPersistenceService.persistClosedSession({
      sessionId,
      workspaceId: session.workspaceId,
      worktreePath: workspace.worktreePath,
      name: session.name,
      workflow: session.workflow,
      provider: session.provider,
      model: session.model,
      startedAt: session.createdAt,
      messages: this.dependencies.sessionDomainService.getTranscriptSnapshot(sessionId),
    });
  }

  clearInactiveSession(sessionId: string, reason: 'manual_stop' | 'runtime_exit'): void {
    if (
      this.dependencies.runtimeManager.isSessionRunning(sessionId) ||
      this.dependencies.countViewers(sessionId) > 0
    ) {
      return;
    }
    this.dependencies.sessionDomainService.clearSession(sessionId, { preserveRejections: true });
    logger.debug('Cleared inactive in-memory session state', { sessionId, reason });
  }

  recoverStaleRunningSessions(): Promise<number> {
    return this.dependencies.repository.recoverStaleRunningSessions();
  }

  private async recordRatchetSessionEnd(
    workspaceId: string,
    sessionId: string,
    outcome: RatchetSessionEndOutcome
  ): Promise<void> {
    await this.workspaceBridge?.recordRatchetSessionEnd(workspaceId, sessionId, outcome);
  }

  private async cleanupTransientRatchetSession(
    sessionId: string,
    trigger: 'stop' | 'exit'
  ): Promise<void> {
    try {
      await this.persistClosedSession(sessionId);
      await this.dependencies.repository.deleteSession(sessionId);
      this.dependencies.sessionDomainService.clearSession(sessionId);
      logger.debug('Deleted transient ratchet session', { sessionId, trigger });
    } catch (error) {
      logger.warn('Failed persisting or deleting transient ratchet session', {
        sessionId,
        trigger,
        error: toErrorMessage(error),
      });
    }
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
