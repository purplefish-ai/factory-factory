import { configService } from '@/backend/services/config.service';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type {
  AcpClientOptions,
  AcpProcessHandle,
  AcpRuntimeEventHandlers,
  AcpRuntimeManager,
  PermissionPreset,
} from '@/backend/services/session/service/acp';
import { getChildWorkspaceMcpServerConfig } from '@/backend/services/session/service/acp/child-workspace-mcp-server';
import type {
  SessionAutoIterationExitBridge,
  SessionLifecycleMessageQueueBridge,
  SessionLifecycleWorkspaceBridge,
} from '@/backend/services/session/service/bridges';
import { chatConnectionService } from '@/backend/services/session/service/chat/chat-connection.service';
import { acpTraceLogger } from '@/backend/services/session/service/logging/acp-trace-logger.service';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { userSettingsAccessor } from '@/backend/services/settings';
import { workspaceAccessor, workspaceNotificationAccessor } from '@/backend/services/workspace';
import type { AgentMessage, QueuedMessage, SessionDeltaEvent } from '@/shared/acp-protocol';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import { SessionStatus, type WorkspaceStatus } from '@/shared/core';
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
import type { SessionPromptBuilder } from './session.prompt-builder';
import type { SessionPromptTurnCompletionService } from './session.prompt-turn-completion.service';
import type { SessionRepository } from './session.repository';
import type { SessionRetryService } from './session.retry.service';
import { maybeDiscoverPROnSessionEnd as maybeDiscoverPROnSessionEndHelper } from './session-pr-discovery.service';
import { isStaleLoadingRuntime } from './session-runtime-state.helpers';

const logger = createLogger('session');

function getPersistedStatusForExitCode(exitCode: number | null): SessionStatus {
  return exitCode === 0 ? SessionStatus.COMPLETED : SessionStatus.FAILED;
}

type SessionStartupModePreset = 'non_interactive' | 'plan';

type SessionContext = {
  workingDir: string;
  resumeProviderSessionId: string | undefined;
  systemPrompt: string | undefined;
  model: string;
  workspaceId: string;
  workspaceStatus: WorkspaceStatus;
  parentWorkspaceId?: string | null;
};

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

type StopSessionOptions = {
  cleanupTransientRatchetSession?: boolean;
};

type SendSessionMessage = (sessionId: string, content: string) => Promise<void>;

export type SessionLifecycleServiceDependencies = {
  repository: SessionRepository;
  promptBuilder: SessionPromptBuilder;
  runtimeManager: AcpRuntimeManager;
  sessionDomainService: SessionDomainService;
  sessionPermissionService: SessionPermissionService;
  sessionConfigService: SessionConfigService;
  acpEventProcessor: AcpEventProcessor;
  promptTurnCompletionService: SessionPromptTurnCompletionService;
  retryService: SessionRetryService;
  onBeforeStopSession?: (sessionId: string) => void;
  onSessionExit?: (sessionId: string) => void;
};

export class SessionLifecycleService {
  private readonly repository: SessionRepository;
  private readonly promptBuilder: SessionPromptBuilder;
  private readonly runtimeManager: AcpRuntimeManager;
  private readonly sessionDomainService: SessionDomainService;
  private readonly sessionPermissionService: SessionPermissionService;
  private readonly sessionConfigService: SessionConfigService;
  private readonly acpEventProcessor: AcpEventProcessor;
  private readonly promptTurnCompletionService: SessionPromptTurnCompletionService;
  private readonly retryService: SessionRetryService;
  private readonly onBeforeStopSession?: (sessionId: string) => void;
  private readonly onSessionExit?: (sessionId: string) => void;
  private workspaceBridge: SessionLifecycleWorkspaceBridge | null = null;
  private messageQueueBridge: SessionLifecycleMessageQueueBridge | null = null;
  private autoIterationExitBridge: SessionAutoIterationExitBridge | null = null;

  constructor(options: SessionLifecycleServiceDependencies) {
    this.repository = options.repository;
    this.promptBuilder = options.promptBuilder;
    this.runtimeManager = options.runtimeManager;
    this.sessionDomainService = options.sessionDomainService;
    this.sessionPermissionService = options.sessionPermissionService;
    this.sessionConfigService = options.sessionConfigService;
    this.acpEventProcessor = options.acpEventProcessor;
    this.promptTurnCompletionService = options.promptTurnCompletionService;
    this.retryService = options.retryService;
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
    this.autoIterationExitBridge = bridges.autoIterationExit ?? null;
  }

  async startSession(
    sessionId: string,
    sendSessionMessage: SendSessionMessage,
    options?: StartSessionOptions
  ): Promise<void> {
    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (this.runtimeManager.isStopInProgress(sessionId)) {
      throw new Error('Session is currently being stopped');
    }

    const existingClient = this.runtimeManager.getClient(sessionId);
    if (existingClient) {
      throw new Error('Session is already running');
    }

    const startupModePreset = options?.startupModePreset;

    const { handle, resolvedPreset, dispatchableNotificationCount } =
      await this.getOrCreateAcpSessionClient(sessionId, {}, session);
    await this.applyStartupModePreset(sessionId, handle, startupModePreset, session.workflow);
    await this.applyConfiguredPermissionPreset(sessionId, session, handle, resolvedPreset);
    await this.dispatchQueuedNotificationsIfNeeded(sessionId, dispatchableNotificationCount);

    const initialPrompt = options?.initialPrompt ?? 'Continue with the task.';
    const shouldSendInitialPrompt =
      dispatchableNotificationCount === 0 ||
      (typeof options?.initialPrompt === 'string' && !options.initialPromptIsDefault);
    if (shouldSendInitialPrompt && initialPrompt) {
      await sendSessionMessage(sessionId, initialPrompt);
    }

    logger.info('Session started', { sessionId, provider: session.provider });
  }

  async restartSession(
    sessionId: string,
    sendSessionMessage: SendSessionMessage,
    options?: StartSessionOptions
  ): Promise<void> {
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
      sendSessionMessage,
      options ?? {
        initialPrompt: 'Continue with the task.',
        initialPromptIsDefault: true,
      }
    );
    logger.info('Session restarted', { sessionId });
  }

  async stopSession(sessionId: string, options?: StopSessionOptions): Promise<void> {
    this.promptTurnCompletionService.clearSession(sessionId);
    this.onBeforeStopSession?.(sessionId);
    const session = await this.loadSessionForStop(sessionId);
    const workspaceId = session?.workspaceId ?? this.acpEventProcessor.getWorkspaceId(sessionId);

    if (this.runtimeManager.isStopInProgress(sessionId)) {
      logger.debug('Session stop already in progress', { sessionId });
      return;
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
      if (!this.runtimeManager.isStopInProgress(sessionId)) {
        await this.runtimeManager.stopClient(sessionId);
      }
    } catch (error) {
      stopClientFailed = true;
      logger.warn('Error stopping ACP session runtime; continuing cleanup', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.finalizeOrphanedToolCalls(sessionId, 'session_stop');
      await this.updateStoppedSessionState(sessionId);
      this.sessionDomainService.clearQueuedWork(sessionId, { emitSnapshot: true });
      this.sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      });
      this.markWorkspaceSessionIdleOnStop(workspaceId, sessionId);
      this.acpEventProcessor.clearSessionContext(sessionId);

      if (!stopClientFailed) {
        const shouldCleanupTransientRatchetSession =
          options?.cleanupTransientRatchetSession ?? true;
        await this.cleanupTransientRatchetOnStop(
          session,
          sessionId,
          shouldCleanupTransientRatchetSession
        );
      }

      try {
        this.clearSessionStoreIfInactive(sessionId, 'manual_stop');
        logger.info('ACP session stopped', {
          sessionId,
          ...(stopClientFailed ? { runtimeStopFailed: true } : {}),
        });
      } finally {
        acpTraceLogger.closeSession(sessionId);
      }
    }
  }

  async stopWorkspaceSessions(workspaceId: string): Promise<void> {
    const sessions = await this.repository.getSessionsByWorkspaceId(workspaceId);
    const stopErrors: unknown[] = [];

    for (const session of sessions) {
      if (
        session.status === SessionStatus.RUNNING ||
        this.runtimeManager.isSessionRunning(session.id)
      ) {
        try {
          await this.stopSession(session.id);
        } catch (error) {
          logger.error('Failed to stop workspace session', {
            sessionId: session.id,
            workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
          stopErrors.push(error);
        }
      }
    }

    if (stopErrors.length > 0) {
      throw new Error(
        `Failed to stop ${stopErrors.length} workspace session${stopErrors.length === 1 ? '' : 's'}`
      );
    }

    logger.info('Stopped all workspace sessions', { workspaceId, count: sessions.length });
  }

  async getOrCreateSessionClient(
    sessionId: string,
    options?: GetOrCreateSessionClientOptions
  ): Promise<unknown> {
    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const hadClient = !!this.runtimeManager.getClient(sessionId);
    const { handle, resolvedPreset, dispatchableNotificationCount } =
      await this.getOrCreateAcpSessionClient(sessionId, options ?? {}, session);
    if (!hadClient) {
      await this.applyConfiguredPermissionPreset(sessionId, session, handle, resolvedPreset);
      await this.dispatchQueuedNotificationsIfNeeded(sessionId, dispatchableNotificationCount);
    }

    return handle;
  }

  async getOrCreateSessionClientFromRecord(
    session: AgentSessionRecord,
    options?: GetOrCreateSessionClientOptions
  ): Promise<unknown> {
    const hadClient = !!this.runtimeManager.getClient(session.id);
    const { handle, resolvedPreset, dispatchableNotificationCount } =
      await this.getOrCreateAcpSessionClient(session.id, options ?? {}, session);
    if (!hadClient) {
      await this.applyConfiguredPermissionPreset(session.id, session, handle, resolvedPreset);
      await this.dispatchQueuedNotificationsIfNeeded(session.id, dispatchableNotificationCount);
    }

    return handle;
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

  async getSessionOptions(sessionId: string): Promise<{
    workingDir: string;
    resumeProviderSessionId: string | undefined;
    systemPrompt: string | undefined;
    model: string;
    workspaceStatus: WorkspaceStatus;
  } | null> {
    const sessionContext = await this.loadSessionContext(sessionId);
    if (!sessionContext) {
      return null;
    }

    return {
      workingDir: sessionContext.workingDir,
      resumeProviderSessionId: sessionContext.resumeProviderSessionId,
      systemPrompt: sessionContext.systemPrompt,
      model: sessionContext.model,
      workspaceStatus: sessionContext.workspaceStatus,
    };
  }

  async stopAllClients(timeoutMs = 5000): Promise<void> {
    this.promptTurnCompletionService.clearAll();
    try {
      await this.runtimeManager.stopAllClients(timeoutMs);
    } catch (error) {
      logger.error('Failed to stop ACP clients during shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private setupAcpEventHandler(sessionId: string): AcpRuntimeEventHandlers {
    const runtimeEventHandler = this.acpEventProcessor.createRuntimeEventHandler(sessionId);

    return {
      ...runtimeEventHandler,
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
      onExit: async (sid: string, exitCode: number | null) => {
        this.promptTurnCompletionService.clearSession(sid);
        this.onSessionExit?.(sid);
        this.finalizeOrphanedToolCalls(sid, 'runtime_exit');
        this.acpEventProcessor.clearSessionState(sid);
        this.sessionPermissionService.cancelPendingRequests(sid);
        acpTraceLogger.log(sid, 'runtime_exit', { exitCode });

        try {
          this.sessionDomainService.markProcessExit(sid, exitCode);
          const persistedStatus = getPersistedStatusForExitCode(exitCode);
          const session = await this.repository.updateSession(sid, {
            status: persistedStatus,
          });
          logger.debug('Updated ACP session status on exit', {
            sessionId: sid,
            exitCode,
            status: persistedStatus,
          });

          await this.clearRatchetActiveSessionIfMatching(session.workspaceId, sid);
          void this.maybeDiscoverPROnSessionEnd(session.workspaceId);
          if (session.workflow === 'ratchet') {
            await this.persistRatchetTranscript(sid, session);
            await this.repository.deleteSession(sid);
            logger.debug('Deleted transient ratchet ACP session', { sessionId: sid });
          }
          if (session.workflow === 'auto-iteration' && this.autoIterationExitBridge) {
            // Only propagate death for unexpected exits — intentional stop/recycle sets
            // isStopInProgress, so the loop should not be marked as failed in those cases.
            if (!this.runtimeManager.isStopInProgress(sid)) {
              this.autoIterationExitBridge.onAutoIterationSessionExit(session.workspaceId, sid);
            }
          }
        } catch (error) {
          logger.warn('Failed to update ACP session status on exit', {
            sessionId: sid,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          try {
            this.clearSessionStoreIfInactive(sid, 'runtime_exit');
          } finally {
            acpTraceLogger.closeSession(sid);
          }
        }
      },
      onError: (sid: string, error: Error) => {
        acpTraceLogger.log(sid, 'runtime_error', {
          message: error.message,
          stack: error.stack,
        });
        this.sessionDomainService.markError(sid, error.message);
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

  private async createAcpClient(
    sessionId: string,
    options?: {
      model?: string;
    },
    session?: AgentSessionRecord,
    permissionPreset?: PermissionPreset
  ): Promise<{ handle: AcpProcessHandle; dispatchableNotificationCount: number }> {
    const sessionContext = await this.loadSessionContext(sessionId, session);
    if (!sessionContext) {
      throw new Error(`Session context not ready: ${sessionId}`);
    }

    await this.repository.markWorkspaceHasHadSessions(sessionContext.workspaceId);
    this.acpEventProcessor.registerSessionContext(sessionId, {
      workspaceId: sessionContext.workspaceId,
      workingDir: sessionContext.workingDir,
      provider: session?.provider ?? 'CLAUDE',
    });

    const handlers = this.setupAcpEventHandler(sessionId);
    const shouldSuppressReplay = this.shouldSuppressReplayDuringAcpResume(sessionId, session);
    this.acpEventProcessor.setReplaySuppression(sessionId, shouldSuppressReplay);

    const apiPort = String(configService.getBackendPort());
    const mcpServerConfig = getChildWorkspaceMcpServerConfig({
      workspaceId: sessionContext.workspaceId,
      parentWorkspaceId: sessionContext.parentWorkspaceId ?? null,
      apiBaseUrl: `http://localhost:${apiPort}`,
    });

    const clientOptions: AcpClientOptions = {
      provider: session?.provider ?? 'CLAUDE',
      workingDir: sessionContext.workingDir,
      model: options?.model ?? sessionContext.model,
      systemPrompt: sessionContext.systemPrompt,
      permissionPreset,
      sessionId,
      resumeProviderSessionId: session?.providerSessionId ?? undefined,
      mcpServers: [mcpServerConfig],
    };

    let handle: AcpProcessHandle;
    try {
      handle = await this.runtimeManager.getOrCreateClient(sessionId, clientOptions, handlers, {
        workspaceId: sessionContext.workspaceId,
        workingDir: sessionContext.workingDir,
      });
      await this.sessionConfigService.applyConfiguredReasoningEffort(sessionId, handle, {
        persistSnapshot: false,
        emitUpdates: false,
      });
    } catch (error) {
      this.acpEventProcessor.clearSessionState(sessionId);
      throw error;
    }

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
    const dispatchableNotificationCount = await this.deliverPendingChildNotifications(
      sessionId,
      sessionContext.workspaceId
    );

    return { handle, dispatchableNotificationCount };
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

  private async cleanupTransientRatchetOnStop(
    session: AgentSessionRecord | null,
    sessionId: string,
    shouldCleanupTransientRatchetSession: boolean
  ): Promise<void> {
    if (session?.workflow !== 'ratchet') {
      return;
    }

    try {
      await this.clearRatchetActiveSessionIfMatching(session.workspaceId, sessionId);
    } catch (error) {
      logger.warn('Failed clearing ratchet active session pointer during stop', {
        sessionId,
        workspaceId: session.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!shouldCleanupTransientRatchetSession) {
      return;
    }

    try {
      await this.persistRatchetTranscript(sessionId, session);
      await this.repository.deleteSession(sessionId);
      logger.debug('Deleted transient ratchet session after stop', { sessionId });
    } catch (error) {
      logger.warn('Failed persisting or deleting transient ratchet session during stop', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async clearRatchetActiveSessionIfMatching(
    workspaceId: string,
    sessionId: string
  ): Promise<void> {
    if (!this.workspaceBridge) {
      return;
    }

    await this.workspaceBridge.clearRatchetActiveSessionIfMatching(workspaceId, sessionId);
  }

  private async maybeDiscoverPROnSessionEnd(workspaceId: string): Promise<void> {
    await maybeDiscoverPROnSessionEndHelper(workspaceId, logger);
  }

  private clearSessionStoreIfInactive(
    sessionId: string,
    reason: 'manual_stop' | 'runtime_exit'
  ): void {
    if (
      this.runtimeManager.isSessionRunning(sessionId) ||
      chatConnectionService.countConnectionsViewingSession(sessionId) > 0
    ) {
      return;
    }
    this.sessionDomainService.clearSession(sessionId);
    logger.debug('Cleared inactive in-memory session state', { sessionId, reason });
  }

  private async persistRatchetTranscript(
    sessionId: string,
    session: AgentSessionRecord
  ): Promise<void> {
    if (!this.workspaceBridge) {
      logger.warn('Cannot persist ratchet transcript: no workspace bridge', { sessionId });
      return;
    }

    const transcript = this.sessionDomainService.getTranscriptSnapshot(sessionId);
    const workspace = await workspaceAccessor.findById(session.workspaceId);
    if (!workspace?.worktreePath) {
      logger.warn('Cannot persist ratchet transcript: no worktree path', {
        sessionId,
        workspaceId: session.workspaceId,
      });
      return;
    }

    await closedSessionPersistenceService.persistClosedSession({
      sessionId,
      workspaceId: session.workspaceId,
      worktreePath: workspace.worktreePath,
      name: session.name,
      workflow: session.workflow,
      provider: session.provider,
      model: session.model,
      startedAt: session.createdAt,
      messages: transcript,
    });
  }

  private async getOrCreateAcpSessionClient(
    sessionId: string,
    options: {
      model?: string;
    },
    session: AgentSessionRecord
  ): Promise<{
    handle: AcpProcessHandle;
    resolvedPreset?: PermissionPreset;
    dispatchableNotificationCount: number;
  }> {
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

    const resolvedPreset = await this.resolvePermissionPreset(session);

    let handle: AcpProcessHandle;
    let dispatchableNotificationCount = 0;
    try {
      const created = await this.createAcpClient(sessionId, options, session, resolvedPreset);
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

  private async loadSessionContext(
    sessionId: string,
    preloadedSession?: AgentSessionRecord
  ): Promise<SessionContext | null> {
    const session = preloadedSession ?? (await this.repository.getSessionById(sessionId));
    if (!session) {
      logger.warn('Session not found when getting options', { sessionId });
      return null;
    }

    const workspace = await this.repository.getWorkspaceById(session.workspaceId);
    if (!workspace?.worktreePath) {
      logger.warn('Workspace or worktree not found', {
        sessionId,
        workspaceId: session.workspaceId,
      });
      return null;
    }

    const shouldInjectBranchRename = this.promptBuilder.shouldInjectBranchRename({
      branchName: workspace.branchName,
      isAutoGeneratedBranch: workspace.isAutoGeneratedBranch,
      hasHadSessions: workspace.hasHadSessions,
    });
    const project = shouldInjectBranchRename
      ? await this.repository.getProjectById(workspace.projectId)
      : null;
    if (shouldInjectBranchRename && !project) {
      logger.warn('Project not found when building branch rename instruction', {
        sessionId,
        projectId: workspace.projectId,
      });
    }

    // Resolve parent workspace context for child workspace system prompt injection
    const parentCtx = await this.resolveParentWorkspaceContext(workspace);

    const { workflowPrompt, systemPrompt, injectedBranchRename } =
      this.promptBuilder.buildSystemPrompt({
        workflow: session.workflow,
        workspace: {
          branchName: workspace.branchName,
          isAutoGeneratedBranch: workspace.isAutoGeneratedBranch,
          hasHadSessions: workspace.hasHadSessions,
          name: workspace.name,
          description: workspace.description ?? undefined,
          runScriptPort: workspace.runScriptPort,
          parentWorkspaceId: workspace.parentWorkspaceId,
          parentWorkspaceName: parentCtx.parentWorkspaceName,
          parentProjectName: parentCtx.parentProjectName,
          reportBackOn: parentCtx.reportBackOn,
        },
        project,
      });

    logger.info('Loaded workflow prompt for session options', {
      sessionId,
      workflow: session.workflow,
      hasPrompt: !!workflowPrompt,
      promptLength: workflowPrompt?.length ?? 0,
    });
    if (injectedBranchRename) {
      logger.info('Injected branch rename instruction', {
        sessionId,
        branchName: workspace.branchName,
        branchPrefix: project?.githubOwner,
      });
    }

    return {
      workingDir: workspace.worktreePath,
      resumeProviderSessionId: session.providerSessionId ?? undefined,
      systemPrompt,
      model: session.model,
      workspaceId: workspace.id,
      workspaceStatus: workspace.status,
      parentWorkspaceId: workspace.parentWorkspaceId,
    };
  }

  private async deliverPendingChildNotifications(
    sessionId: string,
    workspaceId: string
  ): Promise<number> {
    try {
      const pending = await workspaceNotificationAccessor.findPending(workspaceId);
      if (pending.length === 0) {
        return 0;
      }
      if (!this.messageQueueBridge) {
        logger.warn(
          'Cannot deliver pending workspace notifications: message queue bridge missing',
          {
            sessionId,
            workspaceId,
            count: pending.length,
          }
        );
        return 0;
      }
      let enqueuedCount = 0;
      let dispatchableCount = 0;
      for (const notification of pending) {
        const timestamp = notification.createdAt.toISOString();
        const messageId = `workspace-notification-${notification.id}`;
        if (this.sessionDomainService.hasQueuedMessage(sessionId, messageId)) {
          dispatchableCount += 1;
          continue;
        }
        if (this.hasCommittedQueuedWorkspaceNotificationMessage(sessionId, messageId)) {
          await this.markDeliveredAfterTranscriptMatch(sessionId, workspaceId, notification.id);
          continue;
        }

        let enqueueText: string;
        let claudeMessage: AgentMessage;
        if (notification.direction === 'PARENT_TO_CHILD') {
          claudeMessage = {
            type: 'parent_workspace_update' as const,
            parentWorkspaceId: notification.sourceWorkspaceId,
            parentWorkspaceName: notification.sourceWorkspaceName,
            parentProjectName: notification.sourceProjectName,
            text: notification.message,
            timestamp,
          };
          enqueueText = `[Message from parent workspace "${notification.sourceWorkspaceName}"]: ${notification.message}`;
        } else {
          claudeMessage = {
            type: 'child_workspace_update' as const,
            childWorkspaceId: notification.sourceWorkspaceId,
            childWorkspaceName: notification.sourceWorkspaceName,
            childProjectName: notification.sourceProjectName,
            text: notification.message,
            timestamp,
          };
          enqueueText = `[Message from child workspace "${notification.sourceWorkspaceName}"]: ${notification.message}`;
        }

        const enqueueResult = this.sessionDomainService.enqueue(sessionId, {
          id: messageId,
          text: enqueueText,
          timestamp,
          settings: {
            selectedModel: null,
            reasoningEffort: null,
            thinkingEnabled: false,
            planModeEnabled: false,
          },
        } satisfies QueuedMessage);
        if ('error' in enqueueResult) {
          logger.warn('Failed to enqueue pending workspace notification', {
            sessionId,
            workspaceId,
            notificationId: notification.id,
            error: enqueueResult.error,
          });
          continue;
        }
        enqueuedCount += 1;
        dispatchableCount += 1;
        const order = this.sessionDomainService.appendClaudeEvent(sessionId, claudeMessage);
        this.sessionDomainService.emitDelta(sessionId, {
          type: 'agent_message',
          data: claudeMessage,
          order,
        } as SessionDeltaEvent & { order: number });
      }
      logger.info('Queued pending workspace notifications', {
        sessionId,
        workspaceId,
        count: enqueuedCount,
        dispatchableCount,
      });
      return dispatchableCount;
    } catch (error) {
      logger.warn('Failed to deliver pending workspace notifications', {
        sessionId,
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  private hasCommittedQueuedWorkspaceNotificationMessage(
    sessionId: string,
    messageId: string
  ): boolean {
    return this.sessionDomainService
      .getTranscriptSnapshot(sessionId)
      .some((entry) => entry.source === 'user' && entry.id === messageId);
  }

  private async markDeliveredAfterTranscriptMatch(
    sessionId: string,
    workspaceId: string,
    notificationId: string
  ): Promise<void> {
    try {
      await workspaceNotificationAccessor.markDelivered([notificationId]);
    } catch (error) {
      logger.warn('Failed to mark already-transcripted workspace notification delivered', {
        sessionId,
        workspaceId,
        notificationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async resolveParentWorkspaceContext(workspace: {
    parentWorkspaceId: string | null;
    creationMetadata: unknown;
  }): Promise<{ parentWorkspaceName?: string; parentProjectName?: string; reportBackOn?: string }> {
    if (!workspace.parentWorkspaceId) {
      return {};
    }
    let parentWorkspaceName: string | undefined;
    let parentProjectName: string | undefined;
    const parentWorkspace = await this.repository.getWorkspaceById(workspace.parentWorkspaceId);
    if (parentWorkspace) {
      parentWorkspaceName = parentWorkspace.name;
      const parentProject = await this.repository.getProjectById(parentWorkspace.projectId);
      parentProjectName = parentProject?.name;
    }
    const metadata = workspace.creationMetadata as Record<string, unknown> | null;
    const reportBackOn =
      typeof metadata?.reportBackOn === 'string' ? metadata.reportBackOn : undefined;
    return { parentWorkspaceName, parentProjectName, reportBackOn };
  }

  private async resolvePermissionPreset(
    session: AgentSessionRecord | undefined
  ): Promise<PermissionPreset> {
    const fallback: PermissionPreset = session?.workflow === 'ratchet' ? 'YOLO' : 'STRICT';
    try {
      const settings = await userSettingsAccessor.get();
      return session?.workflow === 'ratchet'
        ? settings.ratchetPermissions
        : settings.defaultWorkspacePermissions;
    } catch (error) {
      logger.warn('Failed loading user permission preset; using default', {
        workflow: session?.workflow,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }
}
