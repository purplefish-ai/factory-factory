import { randomUUID } from 'node:crypto';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type {
  AcpClientOptions,
  AcpProcessHandle,
  AcpRuntimeEventHandlers,
  AcpRuntimeManager,
  PermissionPreset,
} from '@/backend/services/session/service/acp';
import { AcpBrowseSessionUnavailableError } from '@/backend/services/session/service/acp/acp-runtime-manager';
import type {
  SessionAutoIterationExitBridge,
  SessionLifecycleMessageQueueBridge,
  SessionLifecycleWorkspaceBridge,
} from '@/backend/services/session/service/bridges';
import { acpTraceLogger } from '@/backend/services/session/service/logging/acp-trace-logger.service';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionEventBus } from '@/backend/services/session/service/session-event-bus';
import { workspaceDataService } from '@/backend/services/workspace';
import type { SessionDeltaEvent } from '@/shared/acp-protocol';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
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
import type {
  PersistAcpConfigSnapshotParams,
  SessionConfigService,
} from './session.config.service';
import { toErrorMessage } from './session.error-message';
import type { SessionPermissionService } from './session.permission.service';
import type { SessionPromptTurnCompletionService } from './session.prompt-turn-completion.service';
import type { SessionRepository } from './session.repository';
import type { SessionRetryService } from './session.retry.service';
import type { SessionContextService } from './session-context.service';
import type { SessionAcpEnvironmentPort } from './session-lifecycle.types';
import type { SessionLifecycleEventService } from './session-lifecycle-event.service';
import { type SessionLifecycleGate, SessionStartupCancelledError } from './session-lifecycle-gate';
import type { SessionNotificationDeliveryService } from './session-notification-delivery.service';
import { isStaleLoadingRuntime } from './session-runtime-state.helpers';
import { SessionWorkflowFinalizer } from './session-workflow-finalizer';

const logger = createLogger('session');

function getPersistedStatusForExitCode(exitCode: number | null): SessionStatus {
  return exitCode === 0 ? SessionStatus.COMPLETED : SessionStatus.FAILED;
}

type SessionStartupModePreset = 'non_interactive' | 'plan';

type GetOrCreateSessionClientOptions = {
  thinkingEnabled?: boolean;
  model?: string;
  reasoningEffort?: string;
};

type StartSessionOptions = {
  initialPrompt?: string;
  initialPromptIsDefault?: boolean;
  startupModePreset?: SessionStartupModePreset;
};

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
  private readonly sendSessionMessage: SendSessionMessage;
  private readonly onBeforeStopSession?: (sessionId: string) => void;
  private readonly onSessionExit?: (sessionId: string) => void;
  private readonly clientCreationOperations = new Map<string, Set<Promise<AcpProcessHandle>>>();
  private workspaceBridge: SessionLifecycleWorkspaceBridge | null = null;
  private messageQueueBridge: SessionLifecycleMessageQueueBridge | null = null;
  private notificationDeliveryService: SessionNotificationDeliveryService | null = null;
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
    this.sendSessionMessage = options.sendSessionMessage;
    this.onBeforeStopSession = options.onBeforeStopSession;
    this.onSessionExit = options.onSessionExit;
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
    this.notificationDeliveryService = service;
  }

  private get notificationDelivery(): SessionNotificationDeliveryService {
    if (!this.notificationDeliveryService) {
      throw new Error(
        'SessionLifecycleService not configured: notification delivery service missing'
      );
    }
    return this.notificationDeliveryService;
  }

  async startSession(sessionId: string, options?: StartSessionOptions): Promise<void> {
    await this.lifecycleGate.runStartup(sessionId, async (lease) => {
      const stopGeneration = lease.generation;
      const session = await this.repository.getSessionById(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });

      const existingClient = this.runtimeManager.getClient(sessionId);
      if (existingClient) {
        this.lifecycleGate.establishStartup(lease);
        throw new Error('Session is already running');
      }

      const startupModePreset = options?.startupModePreset;

      const { handle, resolvedPreset, dispatchableNotificationCount } =
        await this.getOrCreateAcpSessionClient(sessionId, {}, session, stopGeneration);
      this.lifecycleGate.establishStartup(lease);
      this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });
      await this.applyStartupModePreset(sessionId, handle, startupModePreset, session.workflow);
      this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });
      await this.applyConfiguredPermissionPreset(sessionId, session, handle, resolvedPreset);
      this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });
      await this.dispatchQueuedNotificationsIfNeeded(sessionId, dispatchableNotificationCount);
      this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });

      const initialPrompt = options?.initialPrompt ?? 'Continue with the task.';
      const shouldSendInitialPrompt =
        dispatchableNotificationCount === 0 ||
        (typeof options?.initialPrompt === 'string' && !options.initialPromptIsDefault);
      if (shouldSendInitialPrompt && initialPrompt) {
        await this.sendSessionMessage(sessionId, initialPrompt);
      }
      this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });

      logger.info('Session started', { sessionId, provider: session.provider });
    });
  }

  async restartSession(sessionId: string, options?: StartSessionOptions): Promise<void> {
    const isRunning = this.runtimeManager.isSessionRunning(sessionId);
    const isStopInProgress = this.runtimeManager.isStopInProgress(sessionId);

    if (isStopInProgress) {
      // A stop is already under way; starting now would throw "Session is currently being stopped".
      throw new Error(
        'Cannot restart: session is currently being stopped. Please try again shortly.'
      );
    }

    if (isRunning) {
      try {
        await this.stopSession(sessionId, { cleanupTransientRatchetSession: false });
      } catch (error) {
        logger.warn('Error stopping session during restart; continuing with start', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.startSession(
      sessionId,
      options ?? {
        initialPrompt: 'Continue with the task.',
        initialPromptIsDefault: true,
      }
    );
    logger.info('Session restarted', { sessionId });
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
    return await this.lifecycleGate.runStartup(sessionId, async (lease) => {
      const stopGeneration = lease.generation;
      const session = await this.repository.getSessionById(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });

      const hadClient = !!this.runtimeManager.getClient(sessionId);
      const { handle, resolvedPreset, dispatchableNotificationCount } =
        await this.getOrCreateAcpSessionClient(sessionId, options ?? {}, session, stopGeneration);
      this.lifecycleGate.establishStartup(lease);
      this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });
      if (!hadClient) {
        await this.applyConfiguredPermissionPreset(sessionId, session, handle, resolvedPreset);
        this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });
        await this.dispatchQueuedNotificationsIfNeeded(sessionId, dispatchableNotificationCount);
        this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });
      }

      return handle;
    });
  }

  async getOrCreateSessionClientFromRecord(
    session: AgentSessionRecord,
    options?: GetOrCreateSessionClientOptions
  ): Promise<unknown> {
    return await this.lifecycleGate.runStartup(session.id, async (lease) => {
      const stopGeneration = lease.generation;
      this.lifecycleGate.assertStartupAllowed({
        sessionId: session.id,
        generation: stopGeneration,
      });
      const hadClient = !!this.runtimeManager.getClient(session.id);
      const { handle, resolvedPreset, dispatchableNotificationCount } =
        await this.getOrCreateAcpSessionClient(session.id, options ?? {}, session, stopGeneration);
      this.lifecycleGate.establishStartup(lease);
      this.lifecycleGate.assertStartupAllowed({
        sessionId: session.id,
        generation: stopGeneration,
      });
      if (!hadClient) {
        await this.applyConfiguredPermissionPreset(session.id, session, handle, resolvedPreset);
        this.lifecycleGate.assertStartupAllowed({
          sessionId: session.id,
          generation: stopGeneration,
        });
        await this.dispatchQueuedNotificationsIfNeeded(session.id, dispatchableNotificationCount);
        this.lifecycleGate.assertStartupAllowed({
          sessionId: session.id,
          generation: stopGeneration,
        });
      }

      return handle;
    });
  }

  async ensureSubagentBrowseSession(sessionId: string): Promise<boolean> {
    if (this.runtimeManager.getSubagentBrowseCapability(sessionId)) {
      return true;
    }

    const pendingClient = this.runtimeManager.getPendingClient(sessionId);
    if (pendingClient) {
      try {
        await pendingClient;
      } catch (error) {
        if (error instanceof AcpBrowseSessionUnavailableError) {
          return false;
        }
        throw error;
      }
      return await this.resolveSubagentBrowseSupport(sessionId);
    }

    return await this.lifecycleGate
      .runStartup(sessionId, async (lease) => {
        const stopGeneration = lease.generation;
        const session = await this.repository.getSessionById(sessionId);
        if (!(session?.provider === 'CODEX' && session.providerSessionId)) {
          return false;
        }
        this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });

        const workspace = await this.repository.getWorkspaceById(session.workspaceId);
        if (
          !workspace?.worktreePath ||
          workspace.status === 'ARCHIVING' ||
          workspace.status === 'ARCHIVED'
        ) {
          return false;
        }
        this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });

        try {
          await this.createAcpClient(
            sessionId,
            { purpose: 'browse' },
            session,
            undefined,
            stopGeneration
          );
          this.lifecycleGate.establishStartup(lease);
        } catch (error) {
          if (error instanceof AcpBrowseSessionUnavailableError) {
            return false;
          }
          throw error;
        }

        return await this.resolveSubagentBrowseSupport(sessionId);
      })
      .catch((error: unknown) => {
        if (error instanceof SessionStartupCancelledError) {
          return false;
        }
        throw error;
      });
  }

  private async resolveSubagentBrowseSupport(sessionId: string): Promise<boolean> {
    if (this.runtimeManager.getSubagentBrowseCapability(sessionId) !== null) {
      return true;
    }
    if (!this.runtimeManager.isBrowseOnlySession(sessionId)) {
      return false;
    }

    const stopReservation = this.lifecycleGate.reserveStop(sessionId);
    try {
      await this.runtimeManager.stopClient(sessionId);
    } finally {
      this.acpEventProcessor.clearSessionState(sessionId);
      stopReservation?.release();
    }
    return false;
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

  private setupAcpEventHandler(
    sessionId: string,
    options?: { persistProviderSessionId?: boolean }
  ): AcpRuntimeEventHandlers {
    const runtimeEventHandler = this.acpEventProcessor.createRuntimeEventHandler(sessionId);
    const runtimeIncarnationId = randomUUID();
    const providerSessionIdHandler =
      options?.persistProviderSessionId === false
        ? {}
        : {
            onSessionId: async (sid: string, providerSessionId: string) => {
              try {
                await this.repository.updateSession(sid, { providerSessionId });
                acpTraceLogger.log(sid, 'runtime_metadata', {
                  type: 'provider_session_id',
                  providerSessionId,
                });
                logger.debug('Updated session with ACP providerSessionId', {
                  sessionId: sid,
                  providerSessionId,
                });
              } catch (error) {
                logger.warn('Failed to update session with ACP providerSessionId', {
                  sessionId: sid,
                  providerSessionId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          };

    return {
      ...runtimeEventHandler,
      ...providerSessionIdHandler,
      onExit: async (sid: string, exitCode: number | null) => {
        const wasDeliberateStop = this.lifecycleGate.isSessionStopping(sid);
        this.lifecycleGate.releaseShutdown(sid);
        if (this.runtimeManager.isBrowseOnlySession(sid)) {
          this.acpEventProcessor.clearSessionState(sid);
          acpTraceLogger.closeSession(sid);
          return;
        }
        this.prepareAcpRuntimeExit(sid, exitCode);
        await this.handleAcpRuntimeExit(sid, exitCode, wasDeliberateStop, runtimeIncarnationId);
      },
      onError: (sid: string, error: Error) => {
        acpTraceLogger.log(sid, 'runtime_error', {
          message: error.message,
          stack: error.stack,
        });
        if (!this.runtimeManager.isBrowseOnlySession(sid)) {
          this.sessionDomainService.markError(sid, error.message);
        }
        logger.error('ACP client error', {
          sessionId: sid,
          error: error.message,
          stack: error.stack,
        });
      },
      onAcpLog: (sid: string, payload: Record<string, unknown>) => {
        this.acpEventProcessor.handleAcpLog(sid, payload);
      },
    };
  }

  private prepareAcpRuntimeExit(sessionId: string, exitCode: number | null): void {
    this.promptTurnCompletionService.clearSession(sessionId);
    this.onSessionExit?.(sessionId);
    this.finalizeOrphanedToolCalls(sessionId, 'runtime_exit');
    this.acpEventProcessor.clearSessionState(sessionId);
    this.sessionPermissionService.cancelPendingRequests(sessionId);
    acpTraceLogger.log(sessionId, 'runtime_exit', { exitCode });
  }

  private async handleAcpRuntimeExit(
    sessionId: string,
    exitCode: number | null,
    wasDeliberateStop: boolean,
    runtimeIncarnationId: string
  ): Promise<void> {
    try {
      this.sessionDomainService.markProcessExit(sessionId, exitCode);
      const session = await this.repository.getSessionById(sessionId);
      if (!session) {
        logger.warn('Failed to find ACP session on exit', { sessionId });
        return;
      }

      const persistedStatus = getPersistedStatusForExitCode(exitCode);
      try {
        await this.repository.updateSession(sessionId, { status: persistedStatus });
        logger.debug('Updated ACP session status on exit', {
          sessionId,
          exitCode,
          status: persistedStatus,
        });
      } catch (error) {
        logger.warn('Failed to update ACP session status on exit', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await this.recordUnexpectedExitIfNeeded(
        session,
        sessionId,
        exitCode,
        wasDeliberateStop,
        runtimeIncarnationId
      );
      await this.workflowFinalizer.finalizeRuntimeExit({
        session,
        sessionId,
        exitCode,
        deliberate: wasDeliberateStop,
      });
    } catch (error) {
      logger.warn('Failed to process ACP session exit', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      try {
        this.workflowFinalizer.clearInactiveSession(sessionId, 'runtime_exit');
      } finally {
        acpTraceLogger.closeSession(sessionId);
      }
    }
  }

  private async recordUnexpectedExitIfNeeded(
    session: AgentSessionRecord,
    sessionId: string,
    exitCode: number | null,
    wasDeliberateStop: boolean,
    runtimeIncarnationId: string
  ): Promise<void> {
    if (wasDeliberateStop) {
      return;
    }

    await this.lifecycleEventService.record({
      workspaceId: session.workspaceId,
      sessionId,
      kind: SessionLifecycleEventKind.SESSION_STOPPED,
      reason: SessionLifecycleEventReason.UNEXPECTED_EXIT,
      message:
        exitCode === null
          ? 'Session stopped: agent process exited unexpectedly.'
          : `Session stopped: agent process exited unexpectedly (code ${exitCode}).`,
      dedupeKey: `process-exit:${runtimeIncarnationId}:${exitCode ?? 'signal'}`,
    });
  }

  private async createAcpClient(
    sessionId: string,
    options?: {
      model?: string;
      purpose?: 'active' | 'browse';
    },
    session?: AgentSessionRecord,
    permissionPreset?: PermissionPreset,
    stopGeneration = this.lifecycleGate.getGeneration(sessionId)
  ): Promise<{ handle: AcpProcessHandle; dispatchableNotificationCount: number }> {
    const sessionContext = await this.contextService.load(sessionId, session);
    if (!sessionContext) {
      throw new Error(`Session context not ready: ${sessionId}`);
    }
    this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });

    const browseOnly = options?.purpose === 'browse';
    if (!browseOnly) {
      await this.repository.markWorkspaceHasHadSessions(sessionContext.workspaceId);
      this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });
    }
    this.acpEventProcessor.registerSessionContext(sessionId, {
      workspaceId: sessionContext.workspaceId,
      workingDir: sessionContext.workingDir,
      provider: session?.provider ?? 'CLAUDE',
    });

    const handlers = this.setupAcpEventHandler(sessionId, {
      persistProviderSessionId: !browseOnly,
    });
    const shouldSuppressReplay = this.shouldSuppressReplayDuringAcpResume(sessionId, session);
    this.acpEventProcessor.setReplaySuppression(sessionId, shouldSuppressReplay);

    const mcpServers = this.acpEnvironment.getMcpServers({
      workspaceId: sessionContext.workspaceId,
      parentWorkspaceId: sessionContext.parentWorkspaceId,
    });

    const clientOptions: AcpClientOptions = {
      provider: session?.provider ?? 'CLAUDE',
      purpose: options?.purpose,
      workingDir: sessionContext.workingDir,
      model: options?.model ?? sessionContext.model,
      systemPrompt: sessionContext.systemPrompt,
      permissionPreset,
      sessionId,
      resumeProviderSessionId: session?.providerSessionId ?? undefined,
      mcpServers,
    };

    let handle: AcpProcessHandle;
    this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });
    const creationPromise = this.runtimeManager.getOrCreateClient(
      sessionId,
      clientOptions,
      handlers,
      {
        workspaceId: sessionContext.workspaceId,
        workingDir: sessionContext.workingDir,
      }
    );
    const sessionCreations =
      this.clientCreationOperations.get(sessionId) ?? new Set<Promise<AcpProcessHandle>>();
    sessionCreations.add(creationPromise);
    this.clientCreationOperations.set(sessionId, sessionCreations);
    try {
      handle = await creationPromise;
      this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });
      if (browseOnly) {
        return { handle, dispatchableNotificationCount: 0 };
      }
      await this.sessionConfigService.applyConfiguredReasoningEffort(sessionId, handle, {
        persistSnapshot: false,
        emitUpdates: false,
      });
    } catch (error) {
      this.clearAcpSessionStateAfterFailedCreation(sessionId, sessionCreations);
      throw error;
    } finally {
      sessionCreations.delete(creationPromise);
      if (sessionCreations.size === 0) {
        this.clientCreationOperations.delete(sessionId);
      }
    }

    this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });

    await this.persistAcpConfigSnapshot(sessionId, {
      provider: handle.provider as PersistAcpConfigSnapshotParams['provider'],
      providerSessionId: handle.providerSessionId,
      configOptions: handle.configOptions,
      existingMetadata: session?.providerMetadata ?? undefined,
    });

    if (handle.configOptions.length > 0) {
      this.sessionDomainService.emitDelta(sessionId, {
        type: 'config_options_update',
        configOptions: handle.configOptions,
      } as SessionDeltaEvent);
    }

    this.sessionDomainService.emitDelta(sessionId, {
      type: 'chat_capabilities',
      capabilities: this.buildAcpChatBarCapabilities(handle),
    });

    // Queue pending notifications only after the ACP client starts successfully.
    // Callers decide when dispatch is safe for their startup flow.
    this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });
    const { dispatchableCount: dispatchableNotificationCount } =
      await this.notificationDelivery.recoverPending({
        sessionId,
        workspaceId: sessionContext.workspaceId,
        assertAllowed: () =>
          this.lifecycleGate.assertStartupAllowed({
            sessionId,
            generation: stopGeneration,
          }),
      });

    return { handle, dispatchableNotificationCount };
  }

  private clearAcpSessionStateAfterFailedCreation(
    sessionId: string,
    sessionCreations: Set<Promise<AcpProcessHandle>>
  ): void {
    if (sessionCreations.size === 1) {
      this.acpEventProcessor.clearSessionState(sessionId);
    }
  }

  private shouldSuppressReplayDuringAcpResume(
    sessionId: string,
    session: AgentSessionRecord | undefined
  ): boolean {
    if (!session?.providerSessionId) {
      return false;
    }

    if (!this.sessionDomainService.isHistoryHydrated(sessionId)) {
      return false;
    }

    return this.sessionDomainService.getTranscriptSnapshot(sessionId).length > 0;
  }

  private async applyStartupModePreset(
    sessionId: string,
    handle: AcpProcessHandle,
    startupModePreset: SessionStartupModePreset | undefined,
    workflow: string
  ): Promise<void> {
    await this.sessionConfigService.applyStartupModePreset(
      sessionId,
      handle,
      startupModePreset,
      workflow,
      {
        persistSnapshot: this.persistAcpConfigSnapshot.bind(this),
      }
    );
  }

  private async applyConfiguredPermissionPreset(
    sessionId: string,
    session: AgentSessionRecord,
    handle: AcpProcessHandle,
    permissionPreset?: PermissionPreset
  ): Promise<void> {
    await this.sessionConfigService.applyConfiguredPermissionPreset(
      sessionId,
      session,
      handle,
      permissionPreset
    );
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
  private async getOrCreateAcpSessionClient(
    sessionId: string,
    options: {
      model?: string;
    },
    session: AgentSessionRecord,
    stopGeneration: number
  ): Promise<{
    handle: AcpProcessHandle;
    resolvedPreset?: PermissionPreset;
    dispatchableNotificationCount: number;
  }> {
    this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });

    const existingAcp = this.runtimeManager.getClient(sessionId);
    if (existingAcp) {
      this.sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: existingAcp.isPromptInFlight ? 'running' : 'idle',
        processState: 'alive',
        activity: existingAcp.isPromptInFlight ? 'WORKING' : 'IDLE',
        updatedAt: new Date().toISOString(),
      });
      return { handle: existingAcp, dispatchableNotificationCount: 0 };
    }

    this.sessionDomainService.setRuntimeSnapshot(sessionId, {
      phase: 'starting',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: new Date().toISOString(),
    });

    const resolvedPreset = await this.contextService.resolvePermissionPreset(session);
    this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });

    let handle: AcpProcessHandle;
    let dispatchableNotificationCount = 0;
    try {
      const created = await this.createAcpClient(
        sessionId,
        options,
        session,
        resolvedPreset,
        stopGeneration
      );
      handle = created.handle;
      dispatchableNotificationCount = created.dispatchableNotificationCount;
    } catch (error) {
      this.sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: 'error',
        processState: 'stopped',
        activity: 'IDLE',
        errorMessage: `Failed to start agent: ${toErrorMessage(error)}`,
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }

    this.lifecycleGate.assertStartupAllowed({ sessionId, generation: stopGeneration });

    await this.repository.updateSession(sessionId, {
      status: SessionStatus.RUNNING,
    });

    this.sessionDomainService.setRuntimeSnapshot(sessionId, {
      phase: handle.isPromptInFlight ? 'running' : 'idle',
      processState: 'alive',
      activity: handle.isPromptInFlight ? 'WORKING' : 'IDLE',
      updatedAt: new Date().toISOString(),
    });

    return { handle, resolvedPreset, dispatchableNotificationCount };
  }

  private async dispatchQueuedNotificationsIfNeeded(
    sessionId: string,
    dispatchableNotificationCount: number
  ): Promise<void> {
    if (dispatchableNotificationCount === 0 || !this.messageQueueBridge) {
      return;
    }
    try {
      await this.messageQueueBridge.tryDispatchNextMessage(sessionId);
    } catch (error) {
      logger.warn('Failed to dispatch queued workspace notifications', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async persistAcpConfigSnapshot(
    sessionId: string,
    params: PersistAcpConfigSnapshotParams
  ): Promise<void> {
    await this.sessionConfigService.persistAcpConfigSnapshot(sessionId, params);
  }

  private buildAcpChatBarCapabilities(handle: AcpProcessHandle): ChatBarCapabilities {
    return this.sessionConfigService.buildAcpChatBarCapabilities(handle);
  }
}
