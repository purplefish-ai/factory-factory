import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type {
  AcpClientCreationOperation,
  AcpClientOptions,
  AcpProcessHandle,
  AcpRuntimeManager,
  PermissionPreset,
} from '@/backend/services/session/service/acp';
import { AcpBrowseSessionUnavailableError } from '@/backend/services/session/service/acp/acp-runtime-manager';
import type { SessionLifecycleMessageQueueBridge } from '@/backend/services/session/service/bridges';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { SessionDeltaEvent } from '@/shared/acp-protocol';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import { SessionStatus } from '@/shared/core';
import type { AcpEventProcessor } from './acp-event-processor';
import type {
  PersistAcpConfigSnapshotParams,
  SessionConfigService,
} from './session.config.service';
import { toErrorMessage } from './session.error-message';
import type { SessionRepository } from './session.repository';
import type { SessionContextService } from './session-context.service';
import type { SessionAcpEnvironmentPort } from './session-lifecycle.types';
import { type SessionLifecycleGate, SessionStartupCancelledError } from './session-lifecycle-gate';
import type { SessionNotificationDeliveryService } from './session-notification-delivery.service';
import type { SessionRuntimeExitCoordinator } from './session-runtime-exit.coordinator';
import type { StopSessionOptions } from './session-termination.coordinator';

const logger = createLogger('session');

export type SessionStartupModePreset = 'non_interactive' | 'plan';

export type GetOrCreateSessionClientOptions = {
  thinkingEnabled?: boolean;
  model?: string;
  reasoningEffort?: string;
};

export type StartSessionOptions = {
  initialPrompt?: string;
  initialPromptIsDefault?: boolean;
  startupModePreset?: SessionStartupModePreset;
};

export type SessionStartupCoordinatorDependencies = {
  repository: Pick<
    SessionRepository,
    'getSessionById' | 'getWorkspaceById' | 'markWorkspaceHasHadSessions' | 'updateSession'
  >;
  contextService: Pick<SessionContextService, 'load' | 'resolvePermissionPreset'>;
  acpEnvironment: SessionAcpEnvironmentPort;
  runtimeManager: Pick<
    AcpRuntimeManager,
    | 'getClient'
    | 'getPendingClient'
    | 'getSubagentBrowseCapability'
    | 'getOrCreateClient'
    | 'runClientCreationOperation'
    | 'isBrowseOnlySession'
    | 'isSessionRunning'
    | 'isSessionWorking'
    | 'isStopInProgress'
    | 'stopClient'
  >;
  sessionDomainService: Pick<
    SessionDomainService,
    'emitDelta' | 'getTranscriptSnapshot' | 'isHistoryHydrated' | 'setRuntimeSnapshot'
  >;
  sessionConfigService: Pick<
    SessionConfigService,
    | 'applyConfiguredPermissionPreset'
    | 'applyConfiguredReasoningEffort'
    | 'applyStartupModePreset'
    | 'buildAcpChatBarCapabilities'
    | 'persistAcpConfigSnapshot'
  >;
  acpEventProcessor: Pick<
    AcpEventProcessor,
    'clearSessionState' | 'registerSessionContext' | 'setReplaySuppression'
  >;
  runtimeExitCoordinator: Pick<SessionRuntimeExitCoordinator, 'createHandlers'>;
  lifecycleGate: SessionLifecycleGate;
  notificationDelivery: Pick<SessionNotificationDeliveryService, 'recoverPending'>;
  sendSessionMessage: (sessionId: string, content: string) => Promise<void>;
  stopSession: (sessionId: string, options: StopSessionOptions) => Promise<void>;
};

export class SessionStartupCoordinator {
  private messageQueueBridge: Pick<
    SessionLifecycleMessageQueueBridge,
    'tryDispatchNextMessage'
  > | null = null;

  constructor(private readonly dependencies: SessionStartupCoordinatorDependencies) {}

  configure(bridges: {
    messageQueue?: Pick<SessionLifecycleMessageQueueBridge, 'tryDispatchNextMessage'>;
  }): void {
    this.messageQueueBridge = bridges.messageQueue ?? null;
  }

  async startSession(sessionId: string, options?: StartSessionOptions): Promise<void> {
    await this.dependencies.lifecycleGate.runStartup(sessionId, async (lease) => {
      const stopGeneration = lease.generation;
      const session = await this.dependencies.repository.getSessionById(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      this.assertStartupAllowed(sessionId, stopGeneration);

      const existingClient = this.dependencies.runtimeManager.getClient(sessionId);
      if (existingClient) {
        this.dependencies.lifecycleGate.establishStartup(lease);
        throw new Error('Session is already running');
      }

      const { handle, resolvedPreset, dispatchableNotificationCount } =
        await this.getOrCreateAcpSessionClient(sessionId, {}, session, stopGeneration);
      this.dependencies.lifecycleGate.establishStartup(lease);
      this.assertStartupAllowed(sessionId, stopGeneration);
      await this.applyStartupModePreset(
        sessionId,
        handle,
        options?.startupModePreset,
        session.workflow
      );
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
        await this.dependencies.sendSessionMessage(sessionId, initialPrompt);
      }
      this.assertStartupAllowed(sessionId, stopGeneration);

      logger.info('Session started', { sessionId, provider: session.provider });
    });
  }

  async restartSession(sessionId: string, options?: StartSessionOptions): Promise<void> {
    const isRunning = this.dependencies.runtimeManager.isSessionRunning(sessionId);
    const isStopInProgress = this.dependencies.runtimeManager.isStopInProgress(sessionId);

    if (isStopInProgress) {
      throw new Error(
        'Cannot restart: session is currently being stopped. Please try again shortly.'
      );
    }

    if (isRunning) {
      try {
        await this.dependencies.stopSession(sessionId, {
          cleanupTransientRatchetSession: false,
        });
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

  async getOrCreateSessionClient(
    sessionId: string,
    options?: GetOrCreateSessionClientOptions
  ): Promise<unknown> {
    return await this.dependencies.lifecycleGate.runStartup(sessionId, async (lease) => {
      const stopGeneration = lease.generation;
      const session = await this.dependencies.repository.getSessionById(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      this.assertStartupAllowed(sessionId, stopGeneration);

      return await this.getOrCreateFromRecord(session, options ?? {}, lease);
    });
  }

  async getOrCreateSessionClientFromRecord(
    session: AgentSessionRecord,
    options?: GetOrCreateSessionClientOptions
  ): Promise<unknown> {
    return await this.dependencies.lifecycleGate.runStartup(session.id, async (lease) => {
      this.assertStartupAllowed(session.id, lease.generation);
      return await this.getOrCreateFromRecord(session, options ?? {}, lease);
    });
  }

  async ensureSubagentBrowseSession(sessionId: string): Promise<boolean> {
    return await this.dependencies.lifecycleGate
      .runStartup(sessionId, async (lease) => {
        const stopGeneration = lease.generation;
        this.assertStartupAllowed(sessionId, stopGeneration);

        const existingBrowseSupport = await this.resolveExistingBrowseSupport(
          sessionId,
          stopGeneration
        );
        if (existingBrowseSupport !== null) {
          return existingBrowseSupport;
        }

        const session = await this.dependencies.repository.getSessionById(sessionId);
        if (!(session?.provider === 'CODEX' && session.providerSessionId)) {
          return false;
        }
        this.assertStartupAllowed(sessionId, stopGeneration);

        const workspace = await this.dependencies.repository.getWorkspaceById(session.workspaceId);
        if (
          !workspace?.worktreePath ||
          workspace.status === 'ARCHIVING' ||
          workspace.status === 'ARCHIVED'
        ) {
          return false;
        }
        this.assertStartupAllowed(sessionId, stopGeneration);

        try {
          await this.dependencies.runtimeManager.runClientCreationOperation(
            sessionId,
            'browse',
            async (registration) =>
              await this.createAcpClient(
                sessionId,
                { purpose: 'browse' },
                session,
                undefined,
                stopGeneration,
                registration
              )
          );
          this.dependencies.lifecycleGate.establishStartup(lease);
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

  private async resolveExistingBrowseSupport(
    sessionId: string,
    stopGeneration: number
  ): Promise<boolean | null> {
    if (this.dependencies.runtimeManager.getSubagentBrowseCapability(sessionId)) {
      return true;
    }

    const pendingClient = this.dependencies.runtimeManager.getPendingClient(sessionId);
    if (!pendingClient) {
      return null;
    }
    try {
      await pendingClient;
    } catch (error) {
      if (error instanceof AcpBrowseSessionUnavailableError) {
        return false;
      }
      throw error;
    }
    this.assertStartupAllowed(sessionId, stopGeneration);
    return await this.resolveSubagentBrowseSupport(sessionId);
  }

  private async getOrCreateFromRecord(
    session: AgentSessionRecord,
    options: GetOrCreateSessionClientOptions,
    lease: Readonly<{ sessionId: string; generation: number }>
  ): Promise<AcpProcessHandle> {
    const hadClient = !!this.dependencies.runtimeManager.getClient(session.id);
    const { handle, resolvedPreset, dispatchableNotificationCount } =
      await this.getOrCreateAcpSessionClient(session.id, options, session, lease.generation);
    this.dependencies.lifecycleGate.establishStartup(lease);
    this.assertStartupAllowed(session.id, lease.generation);
    if (!hadClient) {
      await this.applyConfiguredPermissionPreset(session.id, session, handle, resolvedPreset);
      this.assertStartupAllowed(session.id, lease.generation);
      await this.dispatchQueuedNotificationsIfNeeded(session.id, dispatchableNotificationCount);
      this.assertStartupAllowed(session.id, lease.generation);
    }
    return handle;
  }

  private async resolveSubagentBrowseSupport(sessionId: string): Promise<boolean> {
    if (this.dependencies.runtimeManager.getSubagentBrowseCapability(sessionId) !== null) {
      return true;
    }
    if (!this.dependencies.runtimeManager.isBrowseOnlySession(sessionId)) {
      return false;
    }

    const stopReservation = this.dependencies.lifecycleGate.reserveStop(sessionId);
    try {
      await this.dependencies.runtimeManager.stopClient(sessionId);
    } finally {
      this.dependencies.acpEventProcessor.clearSessionState(sessionId);
      stopReservation?.release();
    }
    return false;
  }

  private async createAcpClient(
    sessionId: string,
    options: { model?: string; purpose?: 'active' | 'browse' },
    session: AgentSessionRecord,
    permissionPreset: PermissionPreset | undefined,
    stopGeneration: number,
    registration: AcpClientCreationOperation
  ): Promise<{ handle: AcpProcessHandle; dispatchableNotificationCount: number }> {
    const sessionContext = await this.dependencies.contextService.load(sessionId, session);
    if (!sessionContext) {
      throw new Error(`Session context not ready: ${sessionId}`);
    }
    this.assertStartupAllowed(sessionId, stopGeneration);

    const browseOnly = options.purpose === 'browse';
    if (!browseOnly) {
      await this.dependencies.repository.markWorkspaceHasHadSessions(sessionContext.workspaceId);
      this.assertStartupAllowed(sessionId, stopGeneration);
    }
    this.dependencies.acpEventProcessor.registerSessionContext(sessionId, {
      workspaceId: sessionContext.workspaceId,
      workingDir: sessionContext.workingDir,
      provider: session.provider,
    });

    const handlers = this.dependencies.runtimeExitCoordinator.createHandlers({
      sessionId,
      purpose: browseOnly ? 'browse' : 'active',
      persistProviderSessionId: !browseOnly,
    });
    this.dependencies.acpEventProcessor.setReplaySuppression(
      sessionId,
      this.shouldSuppressReplayDuringAcpResume(sessionId, session)
    );

    const clientOptions: AcpClientOptions = {
      provider: session.provider,
      purpose: options.purpose,
      workingDir: sessionContext.workingDir,
      model: options.model ?? sessionContext.model,
      systemPrompt: sessionContext.systemPrompt,
      permissionPreset,
      sessionId,
      resumeProviderSessionId: session.providerSessionId ?? undefined,
      mcpServers: this.dependencies.acpEnvironment.getMcpServers({
        workspaceId: sessionContext.workspaceId,
        parentWorkspaceId: sessionContext.parentWorkspaceId,
      }),
    };

    this.assertStartupAllowed(sessionId, stopGeneration);
    const creationPromise = this.dependencies.runtimeManager.getOrCreateClient(
      sessionId,
      clientOptions,
      handlers,
      {
        workspaceId: sessionContext.workspaceId,
        workingDir: sessionContext.workingDir,
      }
    );
    let handle: AcpProcessHandle;
    try {
      handle = await creationPromise;
      this.assertStartupAllowed(sessionId, stopGeneration);
      if (browseOnly) {
        return { handle, dispatchableNotificationCount: 0 };
      }
      await this.dependencies.sessionConfigService.applyConfiguredReasoningEffort(
        sessionId,
        handle,
        { persistSnapshot: false, emitUpdates: false }
      );
    } catch (error) {
      if (registration.isOnlyOperation()) {
        this.dependencies.acpEventProcessor.clearSessionState(sessionId);
      }
      throw error;
    }

    this.assertStartupAllowed(sessionId, stopGeneration);
    await this.persistAcpConfigSnapshot(sessionId, {
      provider: handle.provider as PersistAcpConfigSnapshotParams['provider'],
      providerSessionId: handle.providerSessionId,
      configOptions: handle.configOptions,
      existingMetadata: session.providerMetadata ?? undefined,
    });
    this.assertStartupAllowed(sessionId, stopGeneration);

    if (handle.configOptions.length > 0) {
      this.dependencies.sessionDomainService.emitDelta(sessionId, {
        type: 'config_options_update',
        configOptions: handle.configOptions,
      } as SessionDeltaEvent);
    }
    this.dependencies.sessionDomainService.emitDelta(sessionId, {
      type: 'chat_capabilities',
      capabilities: this.buildAcpChatBarCapabilities(handle),
    });

    this.assertStartupAllowed(sessionId, stopGeneration);
    const { dispatchableCount } = await this.dependencies.notificationDelivery.recoverPending({
      sessionId,
      workspaceId: sessionContext.workspaceId,
      assertAllowed: () => this.assertStartupAllowed(sessionId, stopGeneration),
    });
    return { handle, dispatchableNotificationCount: dispatchableCount };
  }

  private async getOrCreateAcpSessionClient(
    sessionId: string,
    options: { model?: string },
    session: AgentSessionRecord,
    stopGeneration: number
  ): Promise<{
    handle: AcpProcessHandle;
    resolvedPreset?: PermissionPreset;
    dispatchableNotificationCount: number;
  }> {
    this.assertStartupAllowed(sessionId, stopGeneration);
    const existingAcp = this.dependencies.runtimeManager.getClient(sessionId);
    if (existingAcp) {
      const isWorking = this.dependencies.runtimeManager.isSessionWorking(sessionId);
      this.dependencies.sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: isWorking ? 'running' : 'idle',
        processState: 'alive',
        activity: isWorking ? 'WORKING' : 'IDLE',
        updatedAt: new Date().toISOString(),
      });
      return { handle: existingAcp, dispatchableNotificationCount: 0 };
    }

    this.dependencies.sessionDomainService.setRuntimeSnapshot(sessionId, {
      phase: 'starting',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: new Date().toISOString(),
    });
    const resolvedPreset = await this.dependencies.contextService.resolvePermissionPreset(session);
    this.assertStartupAllowed(sessionId, stopGeneration);

    return await this.dependencies.runtimeManager.runClientCreationOperation(
      sessionId,
      'active',
      async (registration) => {
        let handle: AcpProcessHandle;
        let dispatchableNotificationCount = 0;
        try {
          const created = await this.createAcpClient(
            sessionId,
            options,
            session,
            resolvedPreset,
            stopGeneration,
            registration
          );
          handle = created.handle;
          dispatchableNotificationCount = created.dispatchableNotificationCount;
        } catch (error) {
          this.dependencies.sessionDomainService.setRuntimeSnapshot(sessionId, {
            phase: 'error',
            processState: 'stopped',
            activity: 'IDLE',
            errorMessage: `Failed to start agent: ${toErrorMessage(error)}`,
            updatedAt: new Date().toISOString(),
          });
          throw error;
        }

        this.assertStartupAllowed(sessionId, stopGeneration);
        await this.dependencies.repository.updateSession(sessionId, {
          status: SessionStatus.RUNNING,
        });
        this.assertStartupAllowed(sessionId, stopGeneration);
        const isWorking = this.dependencies.runtimeManager.isSessionWorking(sessionId);
        this.dependencies.sessionDomainService.setRuntimeSnapshot(sessionId, {
          phase: isWorking ? 'running' : 'idle',
          processState: 'alive',
          activity: isWorking ? 'WORKING' : 'IDLE',
          updatedAt: new Date().toISOString(),
        });
        return { handle, resolvedPreset, dispatchableNotificationCount };
      }
    );
  }

  private async dispatchQueuedNotificationsIfNeeded(
    sessionId: string,
    dispatchableNotificationCount: number
  ): Promise<void> {
    const messageQueueBridge = this.messageQueueBridge;
    if (dispatchableNotificationCount === 0 || !messageQueueBridge) {
      return;
    }
    try {
      await messageQueueBridge.tryDispatchNextMessage(sessionId);
    } catch (error) {
      logger.warn('Failed to dispatch queued workspace notifications', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private shouldSuppressReplayDuringAcpResume(
    sessionId: string,
    session: AgentSessionRecord
  ): boolean {
    return !!(
      session.providerSessionId &&
      this.dependencies.sessionDomainService.isHistoryHydrated(sessionId) &&
      this.dependencies.sessionDomainService.getTranscriptSnapshot(sessionId).length > 0
    );
  }

  private async applyStartupModePreset(
    sessionId: string,
    handle: AcpProcessHandle,
    startupModePreset: SessionStartupModePreset | undefined,
    workflow: string
  ): Promise<void> {
    await this.dependencies.sessionConfigService.applyStartupModePreset(
      sessionId,
      handle,
      startupModePreset,
      workflow,
      { persistSnapshot: this.persistAcpConfigSnapshot.bind(this) }
    );
  }

  private async applyConfiguredPermissionPreset(
    sessionId: string,
    session: AgentSessionRecord,
    handle: AcpProcessHandle,
    permissionPreset?: PermissionPreset
  ): Promise<void> {
    await this.dependencies.sessionConfigService.applyConfiguredPermissionPreset(
      sessionId,
      session,
      handle,
      permissionPreset
    );
  }

  private async persistAcpConfigSnapshot(
    sessionId: string,
    params: PersistAcpConfigSnapshotParams
  ): Promise<void> {
    await this.dependencies.sessionConfigService.persistAcpConfigSnapshot(sessionId, params);
  }

  private buildAcpChatBarCapabilities(handle: AcpProcessHandle): ChatBarCapabilities {
    return this.dependencies.sessionConfigService.buildAcpChatBarCapabilities(handle);
  }

  private assertStartupAllowed(sessionId: string, generation: number): void {
    this.dependencies.lifecycleGate.assertStartupAllowed({ sessionId, generation });
  }
}
