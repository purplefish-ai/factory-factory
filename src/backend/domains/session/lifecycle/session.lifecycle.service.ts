import type {
  AcpClientOptions,
  AcpProcessHandle,
  AcpRuntimeEventHandlers,
  AcpRuntimeManager,
} from '@/backend/domains/session/acp';
import type { SessionLifecycleWorkspaceBridge } from '@/backend/domains/session/bridges';
import { chatConnectionService } from '@/backend/domains/session/chat/chat-connection.service';
import { acpTraceLogger } from '@/backend/domains/session/logging/acp-trace-logger.service';
import type { SessionDomainService } from '@/backend/domains/session/session-domain.service';
import type { AgentSessionRecord } from '@/backend/resource_accessors/agent-session.accessor';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import { createLogger } from '@/backend/services/logger.service';
import type { SessionDeltaEvent } from '@/shared/acp-protocol';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import { SessionStatus } from '@/shared/core';
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

const logger = createLogger('session');
const STALE_LOADING_RUNTIME_MAX_AGE_MS = 30_000;

type SessionPermissionMode = 'bypassPermissions' | 'plan';
type SessionStartupModePreset = 'non_interactive' | 'plan';

type SessionContext = {
  workingDir: string;
  resumeProviderSessionId: string | undefined;
  systemPrompt: string | undefined;
  model: string;
  workspaceId: string;
};

type GetOrCreateSessionClientOptions = {
  thinkingEnabled?: boolean;
  permissionMode?: SessionPermissionMode;
  model?: string;
  reasoningEffort?: string;
};

type StartSessionOptions = {
  initialPrompt?: string;
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
  private workspaceBridge: SessionLifecycleWorkspaceBridge | null = null;

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
  }

  configure(bridges: { workspace: SessionLifecycleWorkspaceBridge }): void {
    this.workspaceBridge = bridges.workspace;
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
    const startupPermissionMode: SessionPermissionMode =
      startupModePreset === 'plan' ? 'plan' : 'bypassPermissions';

    const handle = await this.getOrCreateAcpSessionClient(
      sessionId,
      { permissionMode: startupPermissionMode },
      session
    );
    await this.applyStartupModePreset(sessionId, handle, startupModePreset, session.workflow);
    if (!session.providerSessionId) {
      await this.applyConfiguredPermissionPreset(sessionId, session, handle);
    }

    const initialPrompt = options?.initialPrompt ?? 'Continue with the task.';
    if (initialPrompt) {
      await sendSessionMessage(sessionId, initialPrompt);
    }

    logger.info('Session started', { sessionId, provider: session.provider });
  }

  async stopSession(sessionId: string, options?: StopSessionOptions): Promise<void> {
    this.promptTurnCompletionService.clearSession(sessionId);
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
      this.finalizeOrphanedToolCallsOnStop(sessionId);
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
        }
      }
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
    const handle = await this.getOrCreateAcpSessionClient(sessionId, options ?? {}, session);
    if (!(hadClient || session.providerSessionId)) {
      await this.applyConfiguredPermissionPreset(sessionId, session, handle);
    }

    return handle;
  }

  async getOrCreateSessionClientFromRecord(
    session: AgentSessionRecord,
    options?: GetOrCreateSessionClientOptions
  ): Promise<unknown> {
    const hadClient = !!this.runtimeManager.getClient(session.id);
    const handle = await this.getOrCreateAcpSessionClient(session.id, options ?? {}, session);
    if (!(hadClient || session.providerSessionId)) {
      await this.applyConfiguredPermissionPreset(session.id, session, handle);
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

    if (this.isStaleLoadingRuntime(base)) {
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

  private isStaleLoadingRuntime(runtime: SessionRuntimeState): boolean {
    if (runtime.phase !== 'loading' || runtime.processState === 'alive') {
      return false;
    }

    const updatedAtMs = Date.parse(runtime.updatedAt);
    if (Number.isNaN(updatedAtMs)) {
      return false;
    }

    return Date.now() - updatedAtMs > STALE_LOADING_RUNTIME_MAX_AGE_MS;
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
        this.acpEventProcessor.clearSessionState(sid);
        this.sessionPermissionService.cancelPendingRequests(sid);
        acpTraceLogger.log(sid, 'runtime_exit', { exitCode });

        try {
          this.sessionDomainService.markProcessExit(sid, exitCode);
          const session = await this.repository.updateSession(sid, {
            status: SessionStatus.COMPLETED,
          });
          logger.debug('Updated ACP session status to COMPLETED on exit', { sessionId: sid });

          await this.clearRatchetActiveSessionIfMatching(session.workspaceId, sid);
          if (session.workflow === 'ratchet') {
            await this.persistRatchetTranscript(sid, session);
            await this.repository.deleteSession(sid);
            logger.debug('Deleted transient ratchet ACP session', { sessionId: sid });
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
      permissionMode?: SessionPermissionMode;
    },
    session?: AgentSessionRecord
  ): Promise<AcpProcessHandle> {
    const sessionContext = await this.loadSessionContext(sessionId, session);
    if (!sessionContext) {
      throw new Error(`Session context not ready: ${sessionId}`);
    }

    await this.repository.markWorkspaceHasHadSessions(sessionContext.workspaceId);
    this.acpEventProcessor.registerSessionContext(sessionId, {
      workspaceId: sessionContext.workspaceId,
      workingDir: sessionContext.workingDir,
    });

    const handlers = this.setupAcpEventHandler(sessionId);
    const shouldSuppressReplay = this.shouldSuppressReplayDuringAcpResume(sessionId, session);
    this.acpEventProcessor.setReplaySuppression(sessionId, shouldSuppressReplay);

    const clientOptions: AcpClientOptions = {
      provider: session?.provider ?? 'CLAUDE',
      workingDir: sessionContext.workingDir,
      model: options?.model ?? sessionContext.model,
      systemPrompt: sessionContext.systemPrompt,
      permissionMode: options?.permissionMode ?? 'bypassPermissions',
      sessionId,
      resumeProviderSessionId: session?.providerSessionId ?? undefined,
    };

    let handle: AcpProcessHandle;
    try {
      handle = await this.runtimeManager.getOrCreateClient(sessionId, clientOptions, handlers, {
        workspaceId: sessionContext.workspaceId,
        workingDir: sessionContext.workingDir,
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

    return handle;
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
    handle: AcpProcessHandle
  ): Promise<void> {
    await this.sessionConfigService.applyConfiguredPermissionPreset(sessionId, session, handle);
  }

  private finalizeOrphanedToolCallsOnStop(sessionId: string): void {
    try {
      this.acpEventProcessor.finalizeOrphanedToolCalls(sessionId, 'session_stop');
    } catch (error) {
      logger.warn('Failed finalizing orphaned ACP tool calls during stop', {
        sessionId,
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
          this.repository.updateSession(sessionId, {
            status: SessionStatus.IDLE,
          }),
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
      await this.repository.deleteSession(sessionId);
      logger.debug('Deleted transient ratchet session after stop', { sessionId });
    } catch (error) {
      logger.warn('Failed deleting transient ratchet session during stop', {
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

    try {
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
    } catch (error) {
      logger.error('Failed to persist ratchet transcript', error as Error, {
        sessionId,
        workspaceId: session.workspaceId,
      });
    }
  }

  private async getOrCreateAcpSessionClient(
    sessionId: string,
    options: {
      model?: string;
      permissionMode?: SessionPermissionMode;
    },
    session: AgentSessionRecord
  ): Promise<AcpProcessHandle> {
    const existingAcp = this.runtimeManager.getClient(sessionId);
    if (existingAcp) {
      this.sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: existingAcp.isPromptInFlight ? 'running' : 'idle',
        processState: 'alive',
        activity: existingAcp.isPromptInFlight ? 'WORKING' : 'IDLE',
        updatedAt: new Date().toISOString(),
      });
      return existingAcp;
    }

    this.sessionDomainService.setRuntimeSnapshot(sessionId, {
      phase: 'starting',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: new Date().toISOString(),
    });

    let handle: AcpProcessHandle;
    try {
      handle = await this.createAcpClient(sessionId, options, session);
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

    return handle;
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

    const { workflowPrompt, systemPrompt, injectedBranchRename } =
      this.promptBuilder.buildSystemPrompt({
        workflow: session.workflow,
        workspace: {
          branchName: workspace.branchName,
          isAutoGeneratedBranch: workspace.isAutoGeneratedBranch,
          hasHadSessions: workspace.hasHadSessions,
          name: workspace.name,
          description: workspace.description ?? undefined,
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
    };
  }
}
