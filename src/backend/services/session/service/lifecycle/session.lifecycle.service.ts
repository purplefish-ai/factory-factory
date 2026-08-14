import { randomUUID } from 'node:crypto';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import type {
  SessionAutoIterationExitBridge,
  SessionLifecycleMessageQueueBridge,
  SessionLifecycleWorkspaceBridge,
} from '@/backend/services/session/service/bridges';
import { acpTraceLogger } from '@/backend/services/session/service/logging/acp-trace-logger.service';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionEventBus } from '@/backend/services/session/service/session-event-bus';
import { workspaceDataService } from '@/backend/services/workspace';
import {
  SessionLifecycleEventKind,
  SessionLifecycleEventReason,
  SessionStatus,
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
import { SessionWorkflowFinalizer } from './session-workflow-finalizer';

const logger = createLogger('session');

export type SessionStopReason =
  | 'USER_STOP'
  | 'SESSION_CLOSED'
  | 'WORKSPACE_ARCHIVED'
  | 'SYSTEM_STOP';

export type StopSessionOptions = {
  cleanupTransientRatchetSession?: boolean;
  recordLifecycleEvent?: boolean;
  reason?: SessionStopReason;
};

const SESSION_STOP_MESSAGES: Record<SessionStopReason, string> = {
  USER_STOP: 'Session stopped by you.',
  SESSION_CLOSED: 'Session closed by you.',
  WORKSPACE_ARCHIVED: 'Session stopped because the workspace was archived.',
  SYSTEM_STOP: 'Session stopped by the system.',
};
const SHUTDOWN_LIFECYCLE_RECORD_TIMEOUT_MS = 1000;

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
  private readonly runtimeExitCoordinator: SessionRuntimeExitCoordinator;
  private readonly sendSessionMessage: SendSessionMessage;
  private readonly onBeforeStopSession?: (sessionId: string) => void;
  private readonly clientCreationOperations = new Map<string, Set<Promise<AcpProcessHandle>>>();
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
    this.onBeforeStopSession = options.onBeforeStopSession;
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
      registerClientCreation: (sessionId, operation) =>
        this.registerClientCreation(sessionId, operation),
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
    const stopReservation = this.lifecycleGate.reserveStop(sessionId);
    if (!stopReservation) {
      logger.debug('Session stop already in progress', { sessionId });
      return;
    }

    const stopInvocationId = randomUUID();
    try {
      await this.stopSessionWithBarrier(sessionId, stopInvocationId, options);
    } finally {
      stopReservation.release();
    }
  }

  private async stopSessionWithBarrier(
    sessionId: string,
    stopInvocationId: string,
    options?: StopSessionOptions
  ): Promise<void> {
    this.promptTurnCompletionService.clearSession(sessionId);
    this.onBeforeStopSession?.(sessionId);
    this.sessionDomainService.clearQueuedWork(sessionId, { emitSnapshot: true });
    const session = await this.loadSessionForStop(sessionId);
    const workspaceId = session?.workspaceId ?? this.acpEventProcessor.getWorkspaceId(sessionId);
    const reason = options?.reason ?? 'SYSTEM_STOP';

    if (workspaceId && options?.recordLifecycleEvent !== false) {
      await this.lifecycleEventService.record({
        workspaceId,
        sessionId,
        kind: SessionLifecycleEventKind.SESSION_STOPPED,
        reason,
        message: SESSION_STOP_MESSAGES[reason],
        dedupeKey: `session-stop:${stopInvocationId}`,
      });
    }

    const current = this.getRuntimeSnapshot(sessionId);
    this.sessionDomainService.setRuntimeSnapshot(sessionId, {
      ...current,
      phase: 'stopping',
      activity: 'IDLE',
      updatedAt: new Date().toISOString(),
    });

    this.acpEventProcessor.clearStreamingState(sessionId);
    this.acpEventProcessor.clearReplaySuppression(sessionId);
    this.sessionPermissionService.cancelPendingRequests(sessionId);

    let stopClientFailed = false;
    try {
      await this.stopRuntimeAndPendingCreation(sessionId);
    } catch (error) {
      stopClientFailed = true;
      logger.warn('Error stopping ACP session runtime; continuing cleanup', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.finalizeOrphanedToolCalls(sessionId, 'session_stop');
      await this.updateStoppedSessionState(sessionId);
      this.sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      });
      this.markWorkspaceSessionIdleOnStop(workspaceId, sessionId);
      this.acpEventProcessor.clearSessionState(sessionId);

      if (!stopClientFailed) {
        const shouldCleanupTransientRatchetSession =
          options?.cleanupTransientRatchetSession ?? true;
        await this.workflowFinalizer.finalizeDeliberateStop({
          session,
          sessionId,
          cleanupTransientRatchetSession: shouldCleanupTransientRatchetSession,
        });
      }

      try {
        this.workflowFinalizer.clearInactiveSession(sessionId, 'manual_stop');
        logger.info('ACP session stopped', {
          sessionId,
          ...(stopClientFailed ? { runtimeStopFailed: true } : {}),
        });
      } finally {
        acpTraceLogger.closeSession(sessionId);
      }
    }
  }

  private async stopRuntimeAndPendingCreation(sessionId: string): Promise<void> {
    await this.runtimeManager.stopClient(sessionId);

    const pendingCreations = this.clientCreationOperations.get(sessionId);
    if (!pendingCreations || pendingCreations.size === 0) {
      return;
    }

    await Promise.allSettled([...pendingCreations]);
    await this.runtimeManager.stopClient(sessionId);
  }

  async stopWorkspaceSessions(
    workspaceId: string,
    options?: { reason?: SessionStopReason }
  ): Promise<void> {
    const sessions = await this.repository.getSessionsByWorkspaceId(workspaceId);
    const stopErrors: unknown[] = [];

    for (const session of sessions) {
      const stopOptions = this.getWorkspaceSessionStopOptions(
        session,
        options?.reason ?? 'SYSTEM_STOP'
      );
      if (!stopOptions) {
        continue;
      }
      try {
        await this.stopSession(session.id, stopOptions);
      } catch (error) {
        logger.error('Failed to stop workspace session', {
          sessionId: session.id,
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
        stopErrors.push(error);
      }
    }

    if (stopErrors.length > 0) {
      throw new Error(
        `Failed to stop ${stopErrors.length} workspace session${stopErrors.length === 1 ? '' : 's'}`
      );
    }

    logger.info('Stopped all workspace sessions', { workspaceId, count: sessions.length });
  }

  private getWorkspaceSessionStopOptions(
    session: { id: string; status: SessionStatus },
    reason: SessionStopReason
  ): StopSessionOptions | null {
    const browseOnlyClient = this.runtimeManager.isBrowseOnlySession(session.id);
    const activeClient = this.runtimeManager.isSessionRunning(session.id);
    if (!(session.status === SessionStatus.RUNNING || activeClient || browseOnlyClient)) {
      return null;
    }
    return {
      reason,
      ...(browseOnlyClient && !activeClient ? { recordLifecycleEvent: false } : {}),
    };
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
      message: SESSION_STOP_MESSAGES.SYSTEM_STOP,
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

  private finalizeOrphanedToolCalls(sessionId: string, reason: string): void {
    try {
      this.acpEventProcessor.finalizeOrphanedToolCalls(sessionId, reason);
    } catch (error) {
      logger.warn('Failed finalizing orphaned ACP tool calls', {
        sessionId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      this.acpEventProcessor.clearPendingToolCalls(sessionId);
    }
  }

  private markWorkspaceSessionIdleOnStop(workspaceId: string | undefined, sessionId: string): void {
    if (!(workspaceId && this.workspaceBridge)) {
      return;
    }

    try {
      this.workspaceBridge.markSessionIdle(workspaceId, sessionId);
    } catch (error) {
      logger.warn('Failed to mark workspace session idle during stop', {
        sessionId,
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
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

  private async updateStoppedSessionState(sessionId: string): Promise<void> {
    try {
      await this.retryService.run(
        () =>
          this.repository.updateSessionIfStatus(
            sessionId,
            {
              status: SessionStatus.IDLE,
            },
            [SessionStatus.RUNNING]
          ),
        {
          attempts: 2,
          operationName: 'updateStoppedSessionState',
          context: { sessionId },
        }
      );
    } catch (error) {
      logger.warn('Failed to update session state during stop; continuing cleanup', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  persistClosedSession(sessionId: string): Promise<void> {
    return this.workflowFinalizer.persistClosedSession(sessionId);
  }
  recoverStaleRunningSessions(): Promise<number> {
    return this.workflowFinalizer.recoverStaleRunningSessions();
  }

  private registerClientCreation(
    sessionId: string,
    operation: Promise<AcpProcessHandle>
  ): { isOnlyOperation: () => boolean; release: () => void } {
    const operations =
      this.clientCreationOperations.get(sessionId) ?? new Set<Promise<AcpProcessHandle>>();
    operations.add(operation);
    this.clientCreationOperations.set(sessionId, operations);
    return {
      isOnlyOperation: () => operations.size === 1,
      release: () => {
        operations.delete(operation);
        if (operations.size === 0) {
          this.clientCreationOperations.delete(sessionId);
        }
      },
    };
  }
}
