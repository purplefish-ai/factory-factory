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
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import { SessionStatus } from '@/shared/core';
import type { AcpEventProcessor } from './acp-event-processor';
import type { SessionContextService } from './session-context.service';
import { type SessionLifecycleGate, SessionStartupCancelledError } from './session-lifecycle-gate';
import type { SessionAcpEnvironmentPort } from './session-lifecycle.types';
import type { SessionNotificationDeliveryService } from './session-notification-delivery.service';
import { restorePRResumeConfig } from './session-pr-resume-config';
import type { SessionRuntimeExitCoordinator } from './session-runtime-exit.coordinator';
import type { StopSessionOptions } from './session-termination.coordinator';
import type {
  PersistAcpConfigSnapshotParams,
  SessionConfigService,
} from './session.config.service';
import { toErrorMessage } from './session.error-message';
import type { SessionRepository } from './session.repository';

const logger = createLogger('session');

export type SessionStartupModePreset = 'non_interactive' | 'plan';

export type GetOrCreateSessionClientOptions = {
  assertCurrent?: () => Promise<void>;
  resumePolicy?: 'allow_fallback' | 'require_existing';
  thinkingEnabled?: boolean;
  model?: string;
  reasoningEffort?: string;
};

export type StartSessionOptions = {
  assertCurrent?: () => Promise<void>;
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
    | 'hasClientCreationOperation'
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

type OwnedStartupRuntime = { handle?: AcpProcessHandle; shared: boolean };

export class SessionStartupCoordinator {
  private readonly startupOwners = new WeakMap<AcpProcessHandle, OwnedStartupRuntime>();
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
      const ownership: OwnedStartupRuntime = { shared: false };
      try {
        const session = await this.dependencies.repository.getSessionById(sessionId);
        if (!session) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        await this.assertCreationAllowed(sessionId, stopGeneration, options?.assertCurrent);
        this.assertWorkflowCanStart(session);

        const existingClient = this.dependencies.runtimeManager.getClient(sessionId);
        if (existingClient) {
          this.dependencies.lifecycleGate.establishStartup(lease);
          throw new Error('Session is already running');
        }

        const { handle, resolvedPreset, dispatchableNotificationCount } =
          await this.getOrCreateAcpSessionClient(
            sessionId,
            { assertCurrent: options?.assertCurrent },
            session,
            stopGeneration,
            ownership
          );
        this.dependencies.lifecycleGate.establishStartup(lease);
        await this.assertCreationAllowed(sessionId, stopGeneration, options?.assertCurrent);
        await this.applyStartupModePreset(
          sessionId,
          handle,
          options?.startupModePreset,
          session.workflow
        );
        await this.assertCreationAllowed(sessionId, stopGeneration, options?.assertCurrent);
        await this.applyConfiguredPermissionPreset(sessionId, session, handle, resolvedPreset);
        await this.assertCreationAllowed(sessionId, stopGeneration, options?.assertCurrent);
        await this.dispatchQueuedNotificationsIfNeeded(sessionId, dispatchableNotificationCount);
        await this.assertCreationAllowed(sessionId, stopGeneration, options?.assertCurrent);

        const initialPrompt = options?.initialPrompt ?? 'Continue with the task.';
        const shouldSendInitialPrompt = this.shouldSendInitialPrompt(
          dispatchableNotificationCount,
          options
        );
        if (shouldSendInitialPrompt && initialPrompt) {
          await this.dependencies.sendSessionMessage(sessionId, initialPrompt);
        }
        await this.assertCreationAllowed(sessionId, stopGeneration, options?.assertCurrent);

        logger.info('Session started', { sessionId, provider: session.provider });
      } catch (error) {
        if (options?.assertCurrent && this.canFinishOwnedStartup(sessionId, ownership)) {
          await this.dependencies.stopSession(sessionId, {
            reason: 'SYSTEM_STOP',
            recordLifecycleEvent: false,
            cleanupTransientRatchetSession: false,
          });
        }
        throw error;
      }
    });
  }

  async restartSession(sessionId: string, options?: StartSessionOptions): Promise<void> {
    const session = await this.dependencies.repository.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.assertWorkflowCanStart(session);
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
    if (!hadClient && options.resumePolicy !== 'require_existing') {
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
    options: {
      assertCurrent?: () => Promise<void>;
      model?: string;
      purpose?: 'active' | 'browse';
      resumePolicy?: 'allow_fallback' | 'require_existing';
    },
    session: AgentSessionRecord,
    permissionPreset: PermissionPreset | undefined,
    stopGeneration: number,
    registration: AcpClientCreationOperation,
    ownership?: OwnedStartupRuntime
  ): Promise<{ handle: AcpProcessHandle; dispatchableNotificationCount: number }> {
    const sessionContext = await this.dependencies.contextService.load(sessionId, session);
    if (!sessionContext) {
      throw new Error(`Session context not ready: ${sessionId}`);
    }
    await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);

    const browseOnly = options.purpose === 'browse';
    if (!browseOnly) {
      await this.dependencies.repository.markWorkspaceHasHadSessions(sessionContext.workspaceId);
      await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);
    }
    this.dependencies.acpEventProcessor.registerSessionContext(sessionId, {
      workspaceId: sessionContext.workspaceId,
      workingDir: sessionContext.workingDir,
      provider: session.provider,
      workflow: session.workflow,
    });

    const handlers = this.createStartupHandlers(
      sessionId,
      browseOnly,
      stopGeneration,
      options.assertCurrent,
      ownership
    );

    this.dependencies.acpEventProcessor.setReplaySuppression(
      sessionId,
      this.shouldSuppressReplayDuringAcpResume(sessionId, session)
    );

    const clientOptions: AcpClientOptions = {
      provider: session.provider,
      purpose: options.purpose,
      workingDir: sessionContext.workingDir,
      model: options.model ?? sessionContext.model,
      permissionPreset,
      sessionId,
      resumeProviderSessionId: session.providerSessionId ?? undefined,
      resumePolicy: options.resumePolicy,
      mcpServers: this.dependencies.acpEnvironment.getMcpServers({
        workspaceId: sessionContext.workspaceId,
        parentWorkspaceId: sessionContext.parentWorkspaceId,
      }),
    };

    await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);
    const creationPromise = this.dependencies.runtimeManager.getOrCreateClient(
      sessionId,
      clientOptions,
      handlers,
      {
        workspaceId: sessionContext.workspaceId,
        workingDir: sessionContext.workingDir,
      }
    );
    let handle: AcpProcessHandle | undefined;
    try {
      handle = await creationPromise;
      this.markRuntimeShared(handle, ownership);
      await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);
      if (browseOnly) {
        return { handle, dispatchableNotificationCount: 0 };
      }
      if (options.resumePolicy === 'require_existing') {
        this.assertExistingConversation(session, handle, true);
        await restorePRResumeConfig(session, handle, () =>
          this.assertStartupAllowed(sessionId, stopGeneration)
        );
      } else {
        await this.dependencies.sessionConfigService.applyConfiguredReasoningEffort(
          sessionId,
          handle,
          { persistSnapshot: false, emitUpdates: false }
        );
      }
      if (session.workflow === ADVERSARIAL_REVIEW_WORKFLOW) {
        await this.dependencies.sessionConfigService.applyConfiguredPermissionPreset(
          sessionId,
          session,
          handle,
          permissionPreset
        );
      }
      await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);
      await this.persistAcpConfigSnapshot(sessionId, {
        provider: handle.provider as PersistAcpConfigSnapshotParams['provider'],
        providerSessionId: handle.providerSessionId,
        configOptions: handle.configOptions,
        existingMetadata:
          handle.sessionCreationOutcome?.kind === 'resume_fallback'
            ? ((await this.dependencies.repository.getSessionById(sessionId))?.providerMetadata ??
              undefined)
            : (session.providerMetadata ?? undefined),
      });
      await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);
    } catch (error) {
      await this.cleanupFailedClientCreation(
        sessionId,
        session.workflow,
        handle,
        registration,
        ownership
      );
      throw error;
    }

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

    await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);
    if (options.resumePolicy === 'require_existing') {
      return { handle, dispatchableNotificationCount: 0 };
    }
    const { dispatchableCount } = await this.dependencies.notificationDelivery.recoverPending({
      sessionId,
      workspaceId: sessionContext.workspaceId,
      assertAllowed: () =>
        this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent),
    });
    await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);
    return { handle, dispatchableNotificationCount: dispatchableCount };
  }

  private shouldSendInitialPrompt(count: number, options?: StartSessionOptions): boolean {
    return (
      count === 0 || (typeof options?.initialPrompt === 'string' && !options.initialPromptIsDefault)
    );
  }

  private createStartupHandlers(
    sessionId: string,
    browseOnly: boolean,
    stopGeneration: number,
    assertCurrent?: () => Promise<void>,
    ownership?: OwnedStartupRuntime
  ): ReturnType<SessionRuntimeExitCoordinator['createHandlers']> {
    const handlers = this.dependencies.runtimeExitCoordinator.createHandlers({
      sessionId,
      persistProviderSessionId: !browseOnly,
    });
    if (ownership) {
      handlers.onRuntimeCreated = (handle) => {
        ownership.handle = handle;
        this.startupOwners.set(handle, ownership);
      };
    }
    const persistIdentity = handlers.onSessionId;
    if (assertCurrent && persistIdentity) {
      handlers.onSessionId = async (id, providerSessionId) => {
        await this.assertCreationAllowed(sessionId, stopGeneration, assertCurrent);
        await persistIdentity(id, providerSessionId);
        await this.assertCreationAllowed(sessionId, stopGeneration, assertCurrent);
      };
    }
    return handlers;
  }

  private async cleanupFailedClientCreation(
    sessionId: string,
    workflow: string | undefined,
    handle: AcpProcessHandle | undefined,
    registration: AcpClientCreationOperation,
    ownership?: OwnedStartupRuntime
  ): Promise<void> {
    const isOnlyOperation = registration.isOnlyOperation();
    try {
      if (
        handle &&
        (!ownership || this.canCleanupOwnedRuntime(sessionId, ownership)) &&
        (isOnlyOperation || workflow === ADVERSARIAL_REVIEW_WORKFLOW)
      ) {
        await this.dependencies.runtimeManager.stopClient(sessionId);
      }
    } finally {
      if (isOnlyOperation && this.canUpdateFailedStartupState(sessionId, ownership)) {
        this.dependencies.acpEventProcessor.clearSessionState(sessionId);
      }
    }
  }

  private async getOrCreateAcpSessionClient(
    sessionId: string,
    options: GetOrCreateSessionClientOptions,
    session: AgentSessionRecord,
    stopGeneration: number,
    ownership?: OwnedStartupRuntime
  ): Promise<{
    handle: AcpProcessHandle;
    resolvedPreset?: PermissionPreset;
    dispatchableNotificationCount: number;
  }> {
    await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);
    this.assertWorkflowCanStart(session);
    const existingAcp = this.dependencies.runtimeManager.getClient(sessionId);
    if (existingAcp) {
      this.markRuntimeShared(existingAcp, ownership);
      if (options.resumePolicy === 'require_existing') {
        this.assertExistingConversation(session, existingAcp, false);
      }
      if (session.workflow === ADVERSARIAL_REVIEW_WORKFLOW) {
        try {
          await this.dependencies.sessionConfigService.applyConfiguredPermissionPreset(
            sessionId,
            session,
            existingAcp
          );
        } catch (error) {
          const stopReservation = this.dependencies.lifecycleGate.reserveStop(sessionId);
          try {
            await this.dependencies.runtimeManager.stopClient(sessionId);
            this.dependencies.sessionDomainService.setRuntimeSnapshot(sessionId, {
              phase: 'error',
              processState: 'stopped',
              activity: 'IDLE',
              errorMessage: `Failed to start agent: ${toErrorMessage(error)}`,
              updatedAt: new Date().toISOString(),
            });
          } finally {
            try {
              this.dependencies.acpEventProcessor.clearSessionState(sessionId);
            } finally {
              stopReservation?.release();
            }
          }
          throw error;
        }
      }
      await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);
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
    const resolvedPreset =
      options.resumePolicy === 'require_existing'
        ? undefined
        : await this.dependencies.contextService.resolvePermissionPreset(session);
    await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);

    return await this.dependencies.runtimeManager.runClientCreationOperation(
      sessionId,
      'active',
      async (registration) => {
        let handle: AcpProcessHandle | undefined;
        let dispatchableNotificationCount = 0;
        try {
          const created = await this.createAcpClient(
            sessionId,
            options,
            session,
            resolvedPreset,
            stopGeneration,
            registration,
            ownership
          );
          handle = created.handle;
          dispatchableNotificationCount = created.dispatchableNotificationCount;
          await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);
          await this.dependencies.repository.updateSession(sessionId, {
            status: SessionStatus.RUNNING,
          });
          await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);
          const isWorking = this.dependencies.runtimeManager.isSessionWorking(sessionId);
          this.dependencies.sessionDomainService.setRuntimeSnapshot(sessionId, {
            phase: isWorking ? 'running' : 'idle',
            processState: 'alive',
            activity: isWorking ? 'WORKING' : 'IDLE',
            updatedAt: new Date().toISOString(),
          });
          return { handle, resolvedPreset, dispatchableNotificationCount };
        } catch (error) {
          if (options.assertCurrent) {
            await this.cleanupFailedClientCreation(
              sessionId,
              session.workflow,
              handle ?? this.dependencies.runtimeManager.getClient(sessionId) ?? undefined,
              registration,
              ownership
            );
          }
          if (this.canUpdateFailedStartupState(sessionId, ownership)) {
            this.dependencies.sessionDomainService.setRuntimeSnapshot(sessionId, {
              phase: 'error',
              processState: 'stopped',
              activity: 'IDLE',
              errorMessage: `Failed to start agent: ${toErrorMessage(error)}`,
              updatedAt: new Date().toISOString(),
            });
          }
          throw error;
        }
      }
    );
  }

  private markRuntimeShared(handle: AcpProcessHandle, caller?: OwnedStartupRuntime): void {
    const owner = this.startupOwners.get(handle);
    if (owner && owner !== caller) {
      owner.shared = true;
    }
  }

  private canCleanupOwnedRuntime(sessionId: string, ownership: OwnedStartupRuntime): boolean {
    return (
      !!ownership.handle &&
      !ownership.shared &&
      this.dependencies.runtimeManager.getClient(sessionId) === ownership.handle
    );
  }

  private canUpdateFailedStartupState(sessionId: string, ownership?: OwnedStartupRuntime): boolean {
    if (!ownership) {
      return true;
    }
    const current = this.dependencies.runtimeManager.getClient(sessionId);
    return !ownership.shared && (!current || current === ownership.handle);
  }

  private canFinishOwnedStartup(sessionId: string, ownership: OwnedStartupRuntime): boolean {
    const current = this.dependencies.runtimeManager.getClient(sessionId);
    return (
      !!ownership.handle &&
      !ownership.shared &&
      !this.dependencies.runtimeManager.hasClientCreationOperation(sessionId) &&
      (!current || current === ownership.handle)
    );
  }

  private assertWorkflowCanStart(session: AgentSessionRecord): void {
    if (session.workflow === 'ratchet') {
      throw new Error('Legacy ratchet sessions cannot be started');
    }
  }

  private assertExistingConversation(
    session: AgentSessionRecord,
    handle: AcpProcessHandle,
    cold: boolean
  ): void {
    if (
      !session.providerSessionId ||
      handle.provider !== session.provider ||
      handle.providerSessionId !== session.providerSessionId ||
      handle.sessionCreationOutcome.kind === 'resume_fallback' ||
      (cold && handle.sessionCreationOutcome.kind !== 'resumed')
    ) {
      throw new Error('Required existing conversation could not be restored');
    }
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

  private async assertCreationAllowed(
    sessionId: string,
    generation: number,
    assertCurrent?: () => Promise<void>
  ): Promise<void> {
    this.assertStartupAllowed(sessionId, generation);
    await assertCurrent?.();
    this.assertStartupAllowed(sessionId, generation);
  }

  private assertStartupAllowed(sessionId: string, generation: number): void {
    this.dependencies.lifecycleGate.assertStartupAllowed({ sessionId, generation });
  }
}
