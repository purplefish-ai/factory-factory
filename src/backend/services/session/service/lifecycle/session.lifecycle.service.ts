import { randomUUID } from 'node:crypto';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpRuntimeManager } from '@/backend/services/session/service/acp';
import type {
  SessionAutoIterationExitBridge,
  SessionLifecycleMessageQueueBridge,
  SessionLifecycleWorkspaceBridge,
} from '@/backend/services/session/service/bridges';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionEventBus } from '@/backend/services/session/service/session-event-bus';
import { workspaceDataService } from '@/backend/services/workspace';
import {
  SessionLifecycleEventKind,
  SessionLifecycleEventReason,
  type WorkspaceStatus,
} from '@/shared/core';
import {
  createInitialSessionRuntimeState,
  type SessionRuntimeState,
} from '@/shared/session-runtime';
import type { AcpEventProcessor } from './acp-event-processor';
import { closedSessionPersistenceService } from './closed-session-persistence.service';
import type { SessionConfigService } from './session.config.service';
import type { SessionPermissionService } from './session.permission.service';
import type { SessionPromptTurnCompletionService } from './session.prompt-turn-completion.service';
import type { SessionRepository } from './session.repository';
import type { SessionRetryService } from './session.retry.service';
import type { SessionContextService } from './session-context.service';
import type { SessionAcpEnvironmentPort } from './session-lifecycle.types';
import type { SessionLifecycleEventService } from './session-lifecycle-event.service';
import type { SessionLifecycleGate } from './session-lifecycle-gate';
import type { SessionNotificationDeliveryService } from './session-notification-delivery.service';
import { SessionRuntimeExitCoordinator } from './session-runtime-exit.coordinator';
import { isStaleLoadingRuntime } from './session-runtime-state.helpers';
import {
  type GetOrCreateSessionClientOptions,
  SessionStartupCoordinator,
  type StartSessionOptions,
} from './session-startup.coordinator';
import {
  type SessionStopReason,
  SessionTerminationCoordinator,
  type StopSessionOptions,
} from './session-termination.coordinator';
import { SessionWorkflowFinalizer } from './session-workflow-finalizer';

export type { SessionStopReason, StopSessionOptions } from './session-termination.coordinator';

const logger = createLogger('session');

const SHUTDOWN_LIFECYCLE_RECORD_TIMEOUT_MS = 1000;
const SHUTDOWN_SESSION_STOP_MESSAGE = 'Session stopped by the system.';

type SendSessionMessage = (sessionId: string, content: string) => Promise<void>;
type HydrateProviderHistory = (
  sessionId: string,
  session: AgentSessionRecord & {
    workspace: { worktreePath: string | null };
  }
) => Promise<void>;

export type SessionLifecycleServiceDependencies = {
  repository: SessionRepository;
  contextService: SessionContextService;
  acpEnvironment: SessionAcpEnvironmentPort;
  runtimeManager: AcpRuntimeManager;
  sessionDomainService: SessionDomainService;
  sessionPermissionService: SessionPermissionService;
  sessionConfigService: SessionConfigService;
  acpEventProcessor: AcpEventProcessor;
  promptTurnCompletionService: SessionPromptTurnCompletionService;
  retryService: SessionRetryService;
  lifecycleEventService: SessionLifecycleEventService;
  lifecycleGate: SessionLifecycleGate;
  hydrateProviderHistory?: HydrateProviderHistory;
  sendSessionMessage: SendSessionMessage;
  onBeforeStopSession?: (sessionId: string) => void;
  onSessionExit?: (sessionId: string) => void;
};

export class SessionLifecycleService {
  private readonly repository: SessionRepository;
  private readonly contextService: SessionContextService;
  private readonly acpEnvironment: SessionAcpEnvironmentPort;
  private readonly runtimeManager: AcpRuntimeManager;
  private readonly sessionDomainService: SessionDomainService;
  private readonly sessionPermissionService: SessionPermissionService;
  private readonly sessionConfigService: SessionConfigService;
  private readonly acpEventProcessor: AcpEventProcessor;
  private readonly promptTurnCompletionService: SessionPromptTurnCompletionService;
  private readonly retryService: SessionRetryService;
  private readonly lifecycleEventService: SessionLifecycleEventService;
  private readonly lifecycleGate: SessionLifecycleGate;
  private readonly hydrateProviderHistory: HydrateProviderHistory;
  private readonly workflowFinalizer: SessionWorkflowFinalizer;
  private readonly terminationCoordinator: SessionTerminationCoordinator;
  private readonly runtimeExitCoordinator: SessionRuntimeExitCoordinator;
  private readonly sendSessionMessage: SendSessionMessage;
  private startupCoordinator: SessionStartupCoordinator | null = null;
  private workspaceBridge: SessionLifecycleWorkspaceBridge | null = null;
  private messageQueueBridge: SessionLifecycleMessageQueueBridge | null = null;
  constructor(options: SessionLifecycleServiceDependencies) {
    if (!(options.contextService && options.acpEnvironment)) {
      throw new Error('SessionLifecycleService requires context and ACP environment ports');
    }
    this.repository = options.repository;
    this.contextService = options.contextService;
    this.acpEnvironment = options.acpEnvironment;
    this.runtimeManager = options.runtimeManager;
    this.sessionDomainService = options.sessionDomainService;
    this.sessionPermissionService = options.sessionPermissionService;
    this.sessionConfigService = options.sessionConfigService;
    this.acpEventProcessor = options.acpEventProcessor;
    this.promptTurnCompletionService = options.promptTurnCompletionService;
    this.retryService = options.retryService;
    this.lifecycleEventService = options.lifecycleEventService;
    this.lifecycleGate = options.lifecycleGate;
    this.hydrateProviderHistory =
      options.hydrateProviderHistory ?? (async (): Promise<void> => undefined);
    this.workflowFinalizer = new SessionWorkflowFinalizer({
      repository: this.repository,
      workspaceLookup: workspaceDataService,
      sessionDomainService: this.sessionDomainService,
      closedSessionPersistenceService,
      lifecycleEventService: this.lifecycleEventService,
      hydrateProviderHistory: this.hydrateProviderHistory,
      runtimeManager: this.runtimeManager,
      countViewers: (sessionId) => sessionEventBus.countViewers(sessionId),
    });
    this.terminationCoordinator = new SessionTerminationCoordinator({
      repository: this.repository,
      retryService: this.retryService,
      runtimeManager: this.runtimeManager,
      sessionDomainService: this.sessionDomainService,
      sessionPermissionService: this.sessionPermissionService,
      acpEventProcessor: this.acpEventProcessor,
      promptTurnCompletionService: this.promptTurnCompletionService,
      lifecycleEventService: this.lifecycleEventService,
      lifecycleGate: this.lifecycleGate,
      workflowFinalizer: this.workflowFinalizer,
      getWorkspaceBridge: () => this.workspaceBridge,
      onBeforeStopSession: options.onBeforeStopSession,
    });
    this.runtimeExitCoordinator = new SessionRuntimeExitCoordinator({
      repository: this.repository,
      sessionDomainService: this.sessionDomainService,
      sessionPermissionService: this.sessionPermissionService,
      acpEventProcessor: this.acpEventProcessor,
      promptTurnCompletionService: this.promptTurnCompletionService,
      lifecycleEventService: this.lifecycleEventService,
      lifecycleGate: this.lifecycleGate,
      workflowFinalizer: this.workflowFinalizer,
      onSessionExit: options.onSessionExit,
    });
    this.sendSessionMessage = options.sendSessionMessage;
  }
  configure(bridges: {
    workspace: SessionLifecycleWorkspaceBridge;
    messageQueue?: SessionLifecycleMessageQueueBridge;
    autoIterationExit?: SessionAutoIterationExitBridge;
  }): void {
    this.workspaceBridge = bridges.workspace;
    this.messageQueueBridge = bridges.messageQueue ?? null;
    this.workflowFinalizer.configure({
      workspace: bridges.workspace,
      autoIterationExit: bridges.autoIterationExit,
    });
  }

  configureNotificationDelivery(service: SessionNotificationDeliveryService): void {
    this.startupCoordinator = new SessionStartupCoordinator({
      repository: this.repository,
      contextService: this.contextService,
      acpEnvironment: this.acpEnvironment,
      runtimeManager: this.runtimeManager,
      sessionDomainService: this.sessionDomainService,
      sessionConfigService: this.sessionConfigService,
      acpEventProcessor: this.acpEventProcessor,
      runtimeExitCoordinator: this.runtimeExitCoordinator,
      lifecycleGate: this.lifecycleGate,
      notificationDelivery: service,
      getMessageQueueBridge: () => this.messageQueueBridge,
      sendSessionMessage: this.sendSessionMessage,
      stopSession: (sessionId, options) => this.stopSession(sessionId, options),
    });
  }

  private get startup(): SessionStartupCoordinator {
    if (!this.startupCoordinator) {
      throw new Error(
        'SessionLifecycleService not configured: notification delivery service missing'
      );
    }
    return this.startupCoordinator;
  }

  async startSession(sessionId: string, options?: StartSessionOptions): Promise<void> {
    await this.startup.startSession(sessionId, options);
  }

  async restartSession(sessionId: string, options?: StartSessionOptions): Promise<void> {
    await this.startup.restartSession(sessionId, options);
  }

  async stopSession(sessionId: string, options?: StopSessionOptions): Promise<void> {
    await this.terminationCoordinator.stopSession(sessionId, options);
  }

  async stopWorkspaceSessions(
    workspaceId: string,
    options?: { reason?: SessionStopReason }
  ): Promise<void> {
    await this.terminationCoordinator.stopWorkspaceSessions(workspaceId, options);
  }

  async getOrCreateSessionClient(
    sessionId: string,
    options?: GetOrCreateSessionClientOptions
  ): Promise<unknown> {
    return await this.startup.getOrCreateSessionClient(sessionId, options);
  }

  async getOrCreateSessionClientFromRecord(
    session: AgentSessionRecord,
    options?: GetOrCreateSessionClientOptions
  ): Promise<unknown> {
    return await this.startup.getOrCreateSessionClientFromRecord(session, options);
  }

  async ensureSubagentBrowseSession(sessionId: string): Promise<boolean> {
    return await this.startup.ensureSubagentBrowseSession(sessionId);
  }

  getSessionClient(sessionId: string): unknown | undefined {
    return this.runtimeManager.getClient(sessionId);
  }

  getRuntimeSnapshot(sessionId: string): SessionRuntimeState {
    const fallback = createInitialSessionRuntimeState();
    const persisted = this.sessionDomainService.getRuntimeSnapshot(sessionId);
    const base = persisted ?? fallback;

    const acpClient = this.runtimeManager.getClient(sessionId);
    if (acpClient) {
      const isWorking = this.runtimeManager.isSessionWorking(sessionId);
      return {
        phase: isWorking ? 'running' : 'idle',
        processState: 'alive',
        activity: isWorking ? 'WORKING' : 'IDLE',
        updatedAt: base.updatedAt,
      };
    }

    if (this.runtimeManager.isStopInProgress(sessionId)) {
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
    return this.lifecycleGate.isSessionStopping(sessionId);
  }

  getStopGeneration(sessionId: string): number {
    return this.lifecycleGate.getGeneration(sessionId);
  }

  isStopGenerationCurrent(sessionId: string, stopGeneration: number): boolean {
    return this.lifecycleGate.isGenerationCurrent(sessionId, stopGeneration);
  }

  getSessionOptions(sessionId: string): Promise<{
    workingDir: string;
    resumeProviderSessionId: string | undefined;
    systemPrompt: string | undefined;
    model: string;
    workspaceStatus: WorkspaceStatus;
  } | null> {
    return this.contextService.getOptions(sessionId);
  }

  async stopAllClients(timeoutMs = 5000): Promise<void> {
    this.promptTurnCompletionService.clearAll();
    const shutdownSessionIds = this.runtimeManager.beginShutdown();
    const activeShutdownSessionIds = shutdownSessionIds.filter(
      (sessionId) => !this.runtimeManager.isBrowseOnlySession(sessionId)
    );
    this.lifecycleGate.reserveShutdown(activeShutdownSessionIds);

    await this.recordShutdownLifecycleEvents(activeShutdownSessionIds);

    try {
      await this.runtimeManager.stopAllClients(timeoutMs);
    } catch (error) {
      logger.error('Failed to stop ACP clients during shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async recordShutdownLifecycleEvent(sessionId: string): Promise<void> {
    const session = await this.loadSessionForStop(sessionId);
    const workspaceId = session?.workspaceId ?? this.acpEventProcessor.getWorkspaceId(sessionId);
    if (!workspaceId) {
      logger.warn('Skipped shutdown lifecycle event without workspace owner', { sessionId });
      return;
    }
    await this.lifecycleEventService.record({
      workspaceId,
      sessionId,
      kind: SessionLifecycleEventKind.SESSION_STOPPED,
      reason: SessionLifecycleEventReason.SYSTEM_STOP,
      message: SHUTDOWN_SESSION_STOP_MESSAGE,
      dedupeKey: `session-stop:${randomUUID()}`,
    });
  }

  private async recordShutdownLifecycleEvents(sessionIds: string[]): Promise<void> {
    const resultsPromise = Promise.allSettled(
      sessionIds.map((sessionId) => this.recordShutdownLifecycleEvent(sessionId))
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const results = await Promise.race([
      resultsPromise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), SHUTDOWN_LIFECYCLE_RECORD_TIMEOUT_MS);
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (results === null) {
      logger.warn('Timed out recording shutdown lifecycle events; continuing shutdown', {
        timeoutMs: SHUTDOWN_LIFECYCLE_RECORD_TIMEOUT_MS,
      });
      return;
    }
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        logger.warn('Failed recording shutdown lifecycle event; continuing shutdown', {
          sessionId: sessionIds[index],
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  private async loadSessionForStop(sessionId: string): Promise<AgentSessionRecord | null> {
    try {
      return await this.retryService.run(() => this.repository.getSessionById(sessionId), {
        attempts: 2,
        operationName: 'loadSessionForStop',
        context: { sessionId },
      });
    } catch (error) {
      logger.warn('Failed to load session before stop; continuing with process shutdown', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  persistClosedSession(sessionId: string): Promise<void> {
    return this.workflowFinalizer.persistClosedSession(sessionId);
  }
  recoverStaleRunningSessions(): Promise<number> {
    return this.workflowFinalizer.recoverStaleRunningSessions();
  }
}
