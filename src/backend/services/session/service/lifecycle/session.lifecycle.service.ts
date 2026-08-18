import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpRuntimeManager } from '@/backend/services/session/service/acp';
import type {
  SessionAutoIterationExitBridge,
  SessionLifecycleMessageQueueBridge,
  SessionLifecycleWorkspaceBridge,
} from '@/backend/services/session/service/bridges';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { WorkspaceStatus } from '@/shared/core';
import {
  createInitialSessionRuntimeState,
  type SessionRuntimeState,
} from '@/shared/session-runtime';
import type { SessionContextService } from './session-context.service';
import type { SessionLifecycleGate } from './session-lifecycle-gate';
import { isStaleLoadingRuntime } from './session-runtime-state.helpers';
import type {
  GetOrCreateSessionClientOptions,
  StartSessionOptions,
} from './session-startup.coordinator';
import type { SessionStopReason, StopSessionOptions } from './session-termination.coordinator';

export type {
  GetOrCreateSessionClientOptions,
  StartSessionOptions,
} from './session-startup.coordinator';
export type { SessionStopReason, StopSessionOptions } from './session-termination.coordinator';

export type LifecycleBridges = {
  workspace: SessionLifecycleWorkspaceBridge;
  messageQueue?: SessionLifecycleMessageQueueBridge;
  autoIterationExit?: SessionAutoIterationExitBridge;
};

export type SessionLifecycleServiceDependencies = {
  startupCoordinator: Pick<
    import('./session-startup.coordinator').SessionStartupCoordinator,
    | 'configure'
    | 'startSession'
    | 'restartSession'
    | 'getOrCreateSessionClient'
    | 'getOrCreateSessionClientFromRecord'
    | 'ensureSubagentBrowseSession'
  >;
  terminationCoordinator: Pick<
    import('./session-termination.coordinator').SessionTerminationCoordinator,
    'configure' | 'stopSession' | 'stopWorkspaceSessions' | 'stopAllClients'
  >;
  workflowFinalizer: Pick<
    import('./session-workflow-finalizer').SessionWorkflowFinalizer,
    'configure' | 'persistClosedSession' | 'recoverStaleRunningSessions'
  >;
  contextService: Pick<SessionContextService, 'getOptions'>;
  runtimeManager: Pick<AcpRuntimeManager, 'getClient' | 'isSessionWorking' | 'isStopInProgress'>;
  sessionDomainService: Pick<SessionDomainService, 'getRuntimeSnapshot'>;
  lifecycleGate: Pick<
    SessionLifecycleGate,
    'isSessionStopping' | 'getGeneration' | 'isGenerationCurrent'
  >;
};

export class SessionLifecycleService {
  private configured = false;

  constructor(private readonly dependencies: SessionLifecycleServiceDependencies) {}

  configure(bridges: LifecycleBridges): void {
    this.configured = false;
    this.dependencies.workflowFinalizer.configure({
      workspace: bridges.workspace,
      autoIterationExit: bridges.autoIterationExit,
    });
    this.dependencies.terminationCoordinator.configure({ workspace: bridges.workspace });
    this.dependencies.startupCoordinator.configure({ messageQueue: bridges.messageQueue });
    this.configured = true;
  }

  async startSession(sessionId: string, options?: StartSessionOptions): Promise<void> {
    this.assertConfigured();
    await this.dependencies.startupCoordinator.startSession(sessionId, options);
  }

  async restartSession(sessionId: string, options?: StartSessionOptions): Promise<void> {
    this.assertConfigured();
    await this.dependencies.startupCoordinator.restartSession(sessionId, options);
  }

  async stopSession(sessionId: string, options?: StopSessionOptions): Promise<void> {
    this.assertConfigured();
    await this.dependencies.terminationCoordinator.stopSession(sessionId, options);
  }

  async stopWorkspaceSessions(
    workspaceId: string,
    options?: { reason?: SessionStopReason }
  ): Promise<void> {
    this.assertConfigured();
    await this.dependencies.terminationCoordinator.stopWorkspaceSessions(workspaceId, options);
  }

  async getOrCreateSessionClient(
    sessionId: string,
    options?: GetOrCreateSessionClientOptions
  ): Promise<unknown> {
    this.assertConfigured();
    return await this.dependencies.startupCoordinator.getOrCreateSessionClient(sessionId, options);
  }

  async getOrCreateSessionClientFromRecord(
    session: AgentSessionRecord,
    options?: GetOrCreateSessionClientOptions
  ): Promise<unknown> {
    this.assertConfigured();
    return await this.dependencies.startupCoordinator.getOrCreateSessionClientFromRecord(
      session,
      options
    );
  }

  async ensureSubagentBrowseSession(sessionId: string): Promise<boolean> {
    this.assertConfigured();
    return await this.dependencies.startupCoordinator.ensureSubagentBrowseSession(sessionId);
  }

  getSessionClient(sessionId: string): unknown | undefined {
    return this.dependencies.runtimeManager.getClient(sessionId);
  }

  getRuntimeSnapshot(sessionId: string): SessionRuntimeState {
    const fallback = createInitialSessionRuntimeState();
    const persisted = this.dependencies.sessionDomainService.getRuntimeSnapshot(sessionId);
    const base = persisted ?? fallback;

    const acpClient = this.dependencies.runtimeManager.getClient(sessionId);
    if (acpClient) {
      const isWorking = this.dependencies.runtimeManager.isSessionWorking(sessionId);
      return {
        phase: isWorking ? 'running' : 'idle',
        processState: 'alive',
        activity: isWorking ? 'WORKING' : 'IDLE',
        updatedAt: base.updatedAt,
      };
    }

    if (this.dependencies.runtimeManager.isStopInProgress(sessionId)) {
      return {
        ...base,
        phase: 'stopping',
        updatedAt: base.updatedAt,
      };
    }

    if (isStaleLoadingRuntime(base)) {
      return {
        ...base,
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: base.updatedAt,
      };
    }

    return base;
  }

  isSessionStopping(sessionId: string): boolean {
    return this.dependencies.lifecycleGate.isSessionStopping(sessionId);
  }

  getStopGeneration(sessionId: string): number {
    return this.dependencies.lifecycleGate.getGeneration(sessionId);
  }

  isStopGenerationCurrent(sessionId: string, stopGeneration: number): boolean {
    return this.dependencies.lifecycleGate.isGenerationCurrent(sessionId, stopGeneration);
  }

  getSessionOptions(sessionId: string): Promise<{
    workingDir: string;
    resumeProviderSessionId: string | undefined;
    systemPrompt: string | undefined;
    model: string;
    workspaceStatus: WorkspaceStatus;
  } | null> {
    return this.dependencies.contextService.getOptions(sessionId);
  }

  async stopAllClients(timeoutMs = 5000): Promise<void> {
    this.assertConfigured();
    await this.dependencies.terminationCoordinator.stopAllClients(timeoutMs);
  }

  persistClosedSession(sessionId: string): Promise<void> {
    this.assertConfigured();
    return this.dependencies.workflowFinalizer.persistClosedSession(sessionId);
  }
  recoverStaleRunningSessions(): Promise<number> {
    this.assertConfigured();
    return this.dependencies.workflowFinalizer.recoverStaleRunningSessions();
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new Error('SessionLifecycleService not configured: lifecycle bridges missing');
    }
  }
}
