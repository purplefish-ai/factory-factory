import { randomUUID } from 'node:crypto';
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
import { AcpBrowseSessionUnavailableError } from '@/backend/services/session/service/acp/acp-runtime-manager';
import { getChildWorkspaceMcpServerConfig } from '@/backend/services/session/service/acp/child-workspace-mcp-server';
import type {
  RatchetSessionEndOutcome,
  SessionAutoIterationExitBridge,
  SessionLifecycleMessageQueueBridge,
  SessionLifecycleWorkspaceBridge,
} from '@/backend/services/session/service/bridges';
import { acpTraceLogger } from '@/backend/services/session/service/logging/acp-trace-logger.service';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionEventBus } from '@/backend/services/session/service/session-event-bus';
import { userSettingsService } from '@/backend/services/settings';
import { workspaceDataService, workspaceNotificationService } from '@/backend/services/workspace';
import type { AgentMessage, QueuedMessage, SessionDeltaEvent } from '@/shared/acp-protocol';
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
import {
  buildWorkspaceNotificationMessageText,
  WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX,
  workspaceNotificationMessageId,
} from '@/shared/workspace-notifications';
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
import type { SessionLifecycleEventService } from './session-lifecycle-event.service';
import { maybeDiscoverPROnSessionEnd as maybeDiscoverPROnSessionEndHelper } from './session-pr-discovery.service';
import { isStaleLoadingRuntime } from './session-runtime-state.helpers';

const logger = createLogger('session');

class SessionStartupCancelledError extends Error {
  constructor() {
    super('Session is currently being stopped');
    this.name = 'SessionStartupCancelledError';
  }
}

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
  promptBuilder: SessionPromptBuilder;
  runtimeManager: AcpRuntimeManager;
  sessionDomainService: SessionDomainService;
  sessionPermissionService: SessionPermissionService;
  sessionConfigService: SessionConfigService;
  acpEventProcessor: AcpEventProcessor;
  promptTurnCompletionService: SessionPromptTurnCompletionService;
  retryService: SessionRetryService;
  lifecycleEventService: SessionLifecycleEventService;
  hydrateProviderHistory?: HydrateProviderHistory;
  sendSessionMessage: SendSessionMessage;
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
  private readonly lifecycleEventService: SessionLifecycleEventService;
  private readonly hydrateProviderHistory: HydrateProviderHistory;
  private readonly sendSessionMessage: SendSessionMessage;
  private readonly onBeforeStopSession?: (sessionId: string) => void;
  private readonly onSessionExit?: (sessionId: string) => void;
  private readonly stoppingSessions = new Set<string>();
  private readonly shutdownSessions = new Set<string>();
  private stopGenerationCounter = 0;
  private readonly stopGenerations = new Map<string, number>();
  private readonly startupGenerationReferences = new Map<number, number>();
  private readonly clientCreationOperations = new Map<string, Set<Promise<AcpProcessHandle>>>();
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
    this.lifecycleEventService = options.lifecycleEventService;
    this.hydrateProviderHistory =
      options.hydrateProviderHistory ?? (async (): Promise<void> => undefined);
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
    this.autoIterationExitBridge = bridges.autoIterationExit ?? null;
  }

  async startSession(sessionId: string, options?: StartSessionOptions): Promise<void> {
    await this.runStartupOperation(sessionId, async (stopGeneration) => {
      const session = await this.repository.getSessionById(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      this.assertStartupAllowed(sessionId, stopGeneration);

      const existingClient = this.runtimeManager.getClient(sessionId);
      if (existingClient) {
        throw new Error('Session is already running');
      }

      const startupModePreset = options?.startupModePreset;

      const { handle, resolvedPreset, dispatchableNotificationCount } =
        await this.getOrCreateAcpSessionClient(sessionId, {}, session, stopGeneration);
      this.assertStartupAllowed(sessionId, stopGeneration);
      await this.applyStartupModePreset(sessionId, handle, startupModePreset, session.workflow);
      this.assertStartupAllowed(sessionId, stopGeneration);
      await this.applyConfiguredPermissionPreset(sessionId, session, handle, resolvedPreset);
      this.assertStartupAllowed(sessionId, stopGeneration);
      await this.dispatchQueuedNotificationsIfNeeded(sessionId, dispatchableNotificationCount);
      this.assertStartupAllowed(sessionId, stopGeneration);

      const initialPrompt = options?.initialPrompt ?? 'Continue with the task.';
      const shouldSendInitialPrompt =
        dispatchableNotificationCount === 0 ||
        (typeof options?.initialPrompt === 'string' && !options.initialPromptIsDefault);
      if (shouldSendInitialPrompt && initialPrompt) {
        await this.sendSessionMessage(sessionId, initialPrompt);
      }
      this.assertStartupAllowed(sessionId, stopGeneration);

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
    if (this.stoppingSessions.has(sessionId)) {
      logger.debug('Session stop already in progress', { sessionId });
      return;
    }

    this.advanceStopGeneration(sessionId);
    this.stoppingSessions.add(sessionId);
    const stopInvocationId = randomUUID();
    try {
      await this.stopSessionWithBarrier(sessionId, stopInvocationId, options);
    } finally {
      this.stoppingSessions.delete(sessionId);
      this.stopGenerations.delete(sessionId);
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
    return await this.runStartupOperation(sessionId, async (stopGeneration) => {
      const session = await this.repository.getSessionById(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      this.assertStartupAllowed(sessionId, stopGeneration);

      const hadClient = !!this.runtimeManager.getClient(sessionId);
      const { handle, resolvedPreset, dispatchableNotificationCount } =
        await this.getOrCreateAcpSessionClient(sessionId, options ?? {}, session, stopGeneration);
      this.assertStartupAllowed(sessionId, stopGeneration);
      if (!hadClient) {
        await this.applyConfiguredPermissionPreset(sessionId, session, handle, resolvedPreset);
        this.assertStartupAllowed(sessionId, stopGeneration);
        await this.dispatchQueuedNotificationsIfNeeded(sessionId, dispatchableNotificationCount);
        this.assertStartupAllowed(sessionId, stopGeneration);
      }

      return handle;
    });
  }

  async getOrCreateSessionClientFromRecord(
    session: AgentSessionRecord,
    options?: GetOrCreateSessionClientOptions
  ): Promise<unknown> {
    return await this.runStartupOperation(session.id, async (stopGeneration) => {
      this.assertStartupAllowed(session.id, stopGeneration);
      const hadClient = !!this.runtimeManager.getClient(session.id);
      const { handle, resolvedPreset, dispatchableNotificationCount } =
        await this.getOrCreateAcpSessionClient(session.id, options ?? {}, session, stopGeneration);
      this.assertStartupAllowed(session.id, stopGeneration);
      if (!hadClient) {
        await this.applyConfiguredPermissionPreset(session.id, session, handle, resolvedPreset);
        this.assertStartupAllowed(session.id, stopGeneration);
        await this.dispatchQueuedNotificationsIfNeeded(session.id, dispatchableNotificationCount);
        this.assertStartupAllowed(session.id, stopGeneration);
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

    return await this.runStartupOperation(sessionId, async (stopGeneration) => {
      const session = await this.repository.getSessionById(sessionId);
      if (!(session?.provider === 'CODEX' && session.providerSessionId)) {
        return false;
      }
      this.assertStartupAllowed(sessionId, stopGeneration);

      const workspace = await this.repository.getWorkspaceById(session.workspaceId);
      if (
        !workspace?.worktreePath ||
        workspace.status === 'ARCHIVING' ||
        workspace.status === 'ARCHIVED'
      ) {
        return false;
      }
      this.assertStartupAllowed(sessionId, stopGeneration);

      try {
        await this.createAcpClient(
          sessionId,
          { purpose: 'browse' },
          session,
          undefined,
          stopGeneration
        );
      } catch (error) {
        if (error instanceof AcpBrowseSessionUnavailableError) {
          return false;
        }
        throw error;
      }

      return await this.resolveSubagentBrowseSupport(sessionId);
    }).catch((error: unknown) => {
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

    this.advanceStopGeneration(sessionId);
    try {
      await this.runtimeManager.stopClient(sessionId);
    } finally {
      this.acpEventProcessor.clearSessionState(sessionId);
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
    return this.stoppingSessions.has(sessionId) || this.runtimeManager.isStopInProgress(sessionId);
  }

  getStopGeneration(sessionId: string): number {
    return this.stopGenerations.get(sessionId) ?? this.advanceStopGeneration(sessionId);
  }

  private async runStartupOperation<T>(
    sessionId: string,
    operation: (stopGeneration: number) => Promise<T>
  ): Promise<T> {
    const stopGeneration = this.getStopGeneration(sessionId);
    this.startupGenerationReferences.set(
      stopGeneration,
      (this.startupGenerationReferences.get(stopGeneration) ?? 0) + 1
    );
    let succeeded = false;
    try {
      const result = await operation(stopGeneration);
      succeeded = true;
      return result;
    } finally {
      this.releaseStartupGeneration(sessionId, stopGeneration, succeeded);
    }
  }

  private releaseStartupGeneration(
    sessionId: string,
    stopGeneration: number,
    succeeded: boolean
  ): void {
    const referenceCount = this.startupGenerationReferences.get(stopGeneration);
    if (referenceCount === undefined) {
      return;
    }
    if (referenceCount > 1) {
      this.startupGenerationReferences.set(stopGeneration, referenceCount - 1);
      return;
    }

    this.startupGenerationReferences.delete(stopGeneration);
    if (
      !(
        succeeded ||
        this.isSessionStopping(sessionId) ||
        this.runtimeManager.getClient(sessionId)
      ) &&
      this.isStopGenerationCurrent(sessionId, stopGeneration)
    ) {
      this.stopGenerations.delete(sessionId);
    }
  }

  isStopGenerationCurrent(sessionId: string, stopGeneration: number): boolean {
    return this.stopGenerations.get(sessionId) === stopGeneration;
  }

  private advanceStopGeneration(sessionId: string): number {
    this.stopGenerationCounter += 1;
    this.stopGenerations.set(sessionId, this.stopGenerationCounter);
    return this.stopGenerationCounter;
  }

  private assertStartupAllowed(sessionId: string, stopGeneration: number): void {
    if (
      this.isSessionStopping(sessionId) ||
      !this.isStopGenerationCurrent(sessionId, stopGeneration)
    ) {
      throw new SessionStartupCancelledError();
    }
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
    const shutdownSessionIds = this.runtimeManager.beginShutdown();
    const activeShutdownSessionIds = shutdownSessionIds.filter(
      (sessionId) => !this.runtimeManager.isBrowseOnlySession(sessionId)
    );
    for (const sessionId of activeShutdownSessionIds) {
      this.shutdownSessions.add(sessionId);
    }

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
        this.stopGenerations.delete(sid);
        if (this.runtimeManager.isBrowseOnlySession(sid)) {
          this.acpEventProcessor.clearSessionState(sid);
          acpTraceLogger.closeSession(sid);
          return;
        }
        const wasDeliberateStop =
          this.stoppingSessions.has(sid) ||
          this.shutdownSessions.has(sid) ||
          this.runtimeManager.isStopInProgress(sid);
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
      await this.recordRatchetSessionEndOnExit(session.workspaceId, sessionId, exitCode);
      void this.maybeDiscoverPROnSessionEnd(session.workspaceId);
      await this.cleanupExitedWorkflow(session, sessionId, wasDeliberateStop);
    } catch (error) {
      logger.warn('Failed to process ACP session exit', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      try {
        this.clearSessionStoreIfInactive(sessionId, 'runtime_exit');
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

  private async cleanupExitedWorkflow(
    session: AgentSessionRecord,
    sessionId: string,
    wasDeliberateStop: boolean
  ): Promise<void> {
    if (session.workflow === 'ratchet') {
      await this.persistRatchetTranscript(sessionId);
      await this.repository.deleteSession(sessionId);
      this.sessionDomainService.clearSession(sessionId);
      logger.debug('Deleted transient ratchet ACP session', { sessionId });
    }

    if (
      session.workflow === 'auto-iteration' &&
      this.autoIterationExitBridge &&
      !wasDeliberateStop
    ) {
      this.autoIterationExitBridge.onAutoIterationSessionExit(session.workspaceId, sessionId);
    }
  }

  private async createAcpClient(
    sessionId: string,
    options?: {
      model?: string;
      purpose?: 'active' | 'browse';
    },
    session?: AgentSessionRecord,
    permissionPreset?: PermissionPreset,
    stopGeneration = this.getStopGeneration(sessionId)
  ): Promise<{ handle: AcpProcessHandle; dispatchableNotificationCount: number }> {
    const sessionContext = await this.loadSessionContext(sessionId, session);
    if (!sessionContext) {
      throw new Error(`Session context not ready: ${sessionId}`);
    }
    this.assertStartupAllowed(sessionId, stopGeneration);

    const browseOnly = options?.purpose === 'browse';
    if (!browseOnly) {
      await this.repository.markWorkspaceHasHadSessions(sessionContext.workspaceId);
      this.assertStartupAllowed(sessionId, stopGeneration);
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

    const apiPort = String(configService.getBackendPort());
    const mcpServerConfig = getChildWorkspaceMcpServerConfig({
      workspaceId: sessionContext.workspaceId,
      parentWorkspaceId: sessionContext.parentWorkspaceId ?? null,
      apiBaseUrl: `http://localhost:${apiPort}`,
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
      mcpServers: [mcpServerConfig],
    };

    let handle: AcpProcessHandle;
    this.assertStartupAllowed(sessionId, stopGeneration);
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
      this.assertStartupAllowed(sessionId, stopGeneration);
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

    this.assertStartupAllowed(sessionId, stopGeneration);

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
    this.assertStartupAllowed(sessionId, stopGeneration);
    const dispatchableNotificationCount = await this.deliverPendingChildNotifications(
      sessionId,
      sessionContext.workspaceId,
      stopGeneration
    );

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

  private async cleanupTransientRatchetOnStop(
    session: AgentSessionRecord | null,
    sessionId: string,
    shouldCleanupTransientRatchetSession: boolean
  ): Promise<void> {
    if (session?.workflow !== 'ratchet') {
      return;
    }

    try {
      // A stop is deliberate, so the dispatch settles as COMPLETED (no retry).
      // No-ops if another session-end path already settled the record.
      await this.recordRatchetSessionEnd(session.workspaceId, sessionId, 'COMPLETED');
    } catch (error) {
      logger.warn('Failed settling ratchet dispatch record during stop', {
        sessionId,
        workspaceId: session.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!shouldCleanupTransientRatchetSession) {
      return;
    }

    try {
      await this.persistRatchetTranscript(sessionId);
      await this.repository.deleteSession(sessionId);
      this.sessionDomainService.clearSession(sessionId);
      logger.debug('Deleted transient ratchet session after stop', { sessionId });
    } catch (error) {
      logger.warn('Failed persisting or deleting transient ratchet session during stop', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async recordRatchetSessionEnd(
    workspaceId: string,
    sessionId: string,
    outcome: RatchetSessionEndOutcome
  ): Promise<void> {
    if (!this.workspaceBridge) {
      return;
    }

    await this.workspaceBridge.recordRatchetSessionEnd(workspaceId, sessionId, outcome);
  }

  /**
   * Deliberate stops (isStopInProgress) and clean exits settle the ratchet
   * dispatch as COMPLETED; unexpected exits settle it as DIED so the ratchet
   * can re-dispatch (bounded) for the same PR state.
   */
  private async recordRatchetSessionEndOnExit(
    workspaceId: string,
    sessionId: string,
    exitCode: number | null
  ): Promise<void> {
    const outcome =
      exitCode === 0 || this.runtimeManager.isStopInProgress(sessionId) ? 'COMPLETED' : 'DIED';
    await this.recordRatchetSessionEnd(workspaceId, sessionId, outcome);
  }

  private async maybeDiscoverPROnSessionEnd(workspaceId: string): Promise<void> {
    if (!this.workspaceBridge) {
      return;
    }
    await maybeDiscoverPROnSessionEndHelper(workspaceId, logger, this.workspaceBridge);
  }

  private clearSessionStoreIfInactive(
    sessionId: string,
    reason: 'manual_stop' | 'runtime_exit'
  ): void {
    if (
      this.runtimeManager.isSessionRunning(sessionId) ||
      sessionEventBus.countViewers(sessionId) > 0
    ) {
      return;
    }
    this.sessionDomainService.clearSession(sessionId, { preserveRejections: true });
    logger.debug('Cleared inactive in-memory session state', { sessionId, reason });
  }

  async persistClosedSession(sessionId: string): Promise<void> {
    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      logger.warn('Cannot persist closed session: session not found', { sessionId });
      return;
    }

    const workspace = await workspaceDataService.findById(session.workspaceId);
    if (!workspace?.worktreePath) {
      logger.warn('Cannot persist closed session: no worktree path', {
        sessionId,
        workspaceId: session.workspaceId,
      });
      return;
    }

    await this.hydrateProviderHistory(sessionId, {
      ...session,
      workspace: { worktreePath: workspace.worktreePath },
    });
    await this.lifecycleEventService.hydrate(sessionId);

    const transcript = this.sessionDomainService.getTranscriptSnapshot(sessionId);
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

  private async persistRatchetTranscript(sessionId: string): Promise<void> {
    await this.persistClosedSession(sessionId);
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
    this.assertStartupAllowed(sessionId, stopGeneration);

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
    this.assertStartupAllowed(sessionId, stopGeneration);

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

    this.assertStartupAllowed(sessionId, stopGeneration);

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
    workspaceId: string,
    stopGeneration = this.getStopGeneration(sessionId)
  ): Promise<number> {
    try {
      const pending = await workspaceNotificationService.listPendingForDelivery(workspaceId);
      this.assertStartupAllowed(sessionId, stopGeneration);
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
      const consumedContentMatchIds = new Set<string>();
      for (const notification of pending) {
        this.assertStartupAllowed(sessionId, stopGeneration);
        const timestamp = notification.createdAt.toISOString();
        const messageId = workspaceNotificationMessageId(notification.id);
        if (this.sessionDomainService.hasQueuedMessage(sessionId, messageId)) {
          dispatchableCount += 1;
          continue;
        }
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
        } else {
          claudeMessage = {
            type: 'child_workspace_update' as const,
            childWorkspaceId: notification.sourceWorkspaceId,
            childWorkspaceName: notification.sourceWorkspaceName,
            childProjectName: notification.sourceProjectName,
            text: notification.message,
            timestamp,
          };
        }
        const enqueueText = buildWorkspaceNotificationMessageText(notification);
        const alreadyDelivered = await this.markDeliveredIfTranscriptMatch(
          sessionId,
          workspaceId,
          notification.id,
          messageId,
          enqueueText,
          consumedContentMatchIds
        );
        this.assertStartupAllowed(sessionId, stopGeneration);
        if (alreadyDelivered) {
          continue;
        }
        if (this.sessionDomainService.hasQueuedMessage(sessionId, messageId)) {
          dispatchableCount += 1;
          continue;
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

  private findCommittedQueuedWorkspaceNotificationMessage(
    sessionId: string,
    messageId: string,
    messageText: string,
    consumedContentMatchIds: ReadonlySet<string>
  ): { id: string; matchedByContent: boolean } | undefined {
    const userEntries = this.sessionDomainService
      .getTranscriptSnapshot(sessionId)
      .filter((entry) => entry.source === 'user');
    const exactIdMatch = userEntries.find((entry) => entry.id === messageId);
    if (exactIdMatch) {
      return { id: exactIdMatch.id, matchedByContent: false };
    }
    if (this.sessionDomainService.getHistoryHydrationSource(sessionId) !== 'jsonl') {
      return undefined;
    }
    const contentMatch = userEntries.find(
      (entry) =>
        !entry.id.startsWith(WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX) &&
        entry.text === messageText &&
        !consumedContentMatchIds.has(entry.id)
    );
    if (contentMatch) {
      return { id: contentMatch.id, matchedByContent: true };
    }
    return undefined;
  }

  private async markDeliveredIfTranscriptMatch(
    sessionId: string,
    workspaceId: string,
    notificationId: string,
    messageId: string,
    messageText: string,
    consumedContentMatchIds: Set<string>
  ): Promise<boolean> {
    const committedMessage = this.findCommittedQueuedWorkspaceNotificationMessage(
      sessionId,
      messageId,
      messageText,
      consumedContentMatchIds
    );
    if (!committedMessage) {
      return false;
    }
    if (committedMessage.matchedByContent) {
      consumedContentMatchIds.add(committedMessage.id);
    }
    await this.markDeliveredAfterTranscriptMatch(sessionId, workspaceId, notificationId);
    return true;
  }

  private async markDeliveredAfterTranscriptMatch(
    sessionId: string,
    workspaceId: string,
    notificationId: string
  ): Promise<void> {
    try {
      await workspaceNotificationService.markDelivered([notificationId]);
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
      const settings = await userSettingsService.get();
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
