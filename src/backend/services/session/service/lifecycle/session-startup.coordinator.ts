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
import {
  assertSessionAccountBinding,
  resolveSessionCodexContext,
  type SessionCodexAccountPort,
} from './session-codex-account';
import type { SessionContextService } from './session-context.service';
import { type SessionLifecycleGate, SessionStartupCancelledError } from './session-lifecycle-gate';
import type { SessionAcpEnvironmentPort } from './session-lifecycle.types';
import type { SessionNotificationDeliveryService } from './session-notification-delivery.service';
import {
  SessionStartupPermissionError,
  SessionStartupTargetError,
} from './session-permission-policy';
import type { SessionRuntimeExitCoordinator } from './session-runtime-exit.coordinator';
import { stopStartupConfigurationFailure } from './session-startup-config-failure';
import { SessionStartupPersistenceError } from './session-startup-configuration-finalizer';
import {
  prepareSessionHistoryForResume,
  type SessionStartupHistoryDependencies,
} from './session-startup-history';
import { prepareSessionStartup } from './session-startup-preparation';
import { SessionStartupRequest } from './session-startup-request';
import type { StopSessionOptions } from './session-termination.coordinator';
import { getAcpWorkState } from './session-work-state';
import type {
  PersistAcpConfigSnapshotParams,
  SessionConfigService,
} from './session.config.service';
import { toErrorMessage } from './session.error-message';
import type { SessionRepository } from './session.repository';

const isTerminalConfigFailure = (error: unknown) =>
  error instanceof SessionStartupPermissionError ||
  error instanceof SessionStartupPersistenceError ||
  error instanceof SessionStartupTargetError;

const logger = createLogger('session');

export type SessionStartupModePreset = 'non_interactive' | 'plan';

export type GetOrCreateSessionClientOptions = {
  assertCurrent?: () => Promise<void>;
  resumePolicy?: 'allow_fallback' | 'require_existing';
  thinkingEnabled?: boolean;
  model?: string;
  reasoningEffort?: string | null;
  planModeEnabled?: boolean;
  startupModePreset?: SessionStartupModePreset;
};

export type StartSessionOptions = {
  assertCurrent?: () => Promise<void>;
  initialPrompt?: string;
  initialPromptIsDefault?: boolean;
  startupModePreset?: SessionStartupModePreset;
};

export type SessionStartupCoordinatorDependencies = {
  accounts?: SessionCodexAccountPort;
  hydrateProviderHistory: SessionStartupHistoryDependencies['hydrateProviderHistory'];
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
    'emitDelta' | 'getTranscriptSnapshot' | 'getHistoryHydrationSource' | 'setRuntimeSnapshot'
  >;
  sessionConfigService: Pick<
    SessionConfigService,
    | 'requireSavedStartupAccess'
    | 'applyStartupModel'
    | 'applyConfiguredPermissionPreset'
    | 'applyConfiguredReasoningEffort'
    | 'applyStartupModePreset'
    | 'applyStartupLaunchPlan'
    | 'buildAcpChatBarCapabilities'
    | 'persistAcpConfigSnapshot'
    | 'completeStartupConfiguration'
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

        const { dispatchableNotificationCount } = await this.getOrCreateAcpSessionClient(
          sessionId,
          { assertCurrent: options?.assertCurrent, startupModePreset: options?.startupModePreset },
          session,
          stopGeneration,
          ownership
        );
        this.dependencies.lifecycleGate.establishStartup(lease);
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
    const { handle, dispatchableNotificationCount } = await this.getOrCreateAcpSessionClient(
      session.id,
      options,
      session,
      lease.generation
    );
    this.dependencies.lifecycleGate.establishStartup(lease);
    this.assertStartupAllowed(session.id, lease.generation);
    if (!hadClient && options.resumePolicy !== 'require_existing') {
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
      startupModePreset?: SessionStartupModePreset;
      reasoningEffort?: string | null;
      planModeEnabled?: boolean;
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

    const codexAccountContext = await resolveSessionCodexContext(
      session,
      this.dependencies.accounts
    );
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

    const suppressReplay = await prepareSessionHistoryForResume(
      sessionId,
      sessionContext,
      this.dependencies,
      codexAccountContext
    );
    await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);
    if (suppressReplay !== undefined) {
      this.dependencies.acpEventProcessor.setReplaySuppression(sessionId, suppressReplay);
    }

    const clientOptions: AcpClientOptions = {
      provider: session.provider,
      codexAccountContext,
      purpose: options.purpose,
      deferPromptReadiness: !browseOnly,
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
    const latest = await this.dependencies.repository.getSessionById(sessionId);
    await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);
    if (!latest) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    assertSessionAccountBinding(session, latest);
    clientOptions.model = options.model ?? latest.model;
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
    let request: SessionStartupRequest | undefined;
    try {
      handle = await creationPromise;
      this.markRuntimeShared(handle, ownership);
      if (browseOnly) {
        await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);
        return { handle, dispatchableNotificationCount: 0 };
      }
      if (options.resumePolicy === 'require_existing') {
        this.assertExistingConversation(session, handle, true);
      }
      const configuredHandle = handle;
      const assertConfiguredRuntime = () => {
        this.assertStartupAllowed(sessionId, stopGeneration);
        if (this.dependencies.runtimeManager.getClient(sessionId) !== configuredHandle) {
          throw new Error('Session runtime changed during configuration');
        }
      };
      const candidateRequest = new SessionStartupRequest(
        assertConfiguredRuntime,
        () => Boolean(ownership?.shared || !registration.isOnlyOperation()),
        options.assertCurrent
      );
      request = candidateRequest;
      await candidateRequest.check();
      const prepare = () =>
        prepareSessionStartup(
          sessionId,
          configuredHandle,
          { ...options, permissionPreset },
          {
            repository: this.dependencies.repository,
            config: this.dependencies.sessionConfigService,
            assertCurrent: assertConfiguredRuntime,
            checkCurrent: () => candidateRequest.check(),
            isRequestFailure: (error: unknown) => candidateRequest.isRequestFailure(error),
          }
        );
      await this.withPermissionFailureStop(
        sessionId,
        configuredHandle,
        stopGeneration,
        async () => {
          const intent = await prepare();
          await this.dependencies.sessionConfigService.completeStartupConfiguration(sessionId, {
            handle: configuredHandle,
            intent,
            prepare,
            assertCurrent: assertConfiguredRuntime,
            beforeComplete: () => candidateRequest.check(),
            complete: () => configuredHandle.completeConfiguration(assertConfiguredRuntime),
          });
        },
        undefined,
        true
      );
      candidateRequest.rejectCancelledRequest();
    } catch (error) {
      if (!(isTerminalConfigFailure(error) || request?.preservesSharedCandidate(error))) {
        handle?.failConfiguration(error);
      }
      await this.cleanupFailedClientCreation(
        sessionId,
        session.workflow,
        handle,
        registration,
        stopGeneration,
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
    stopGeneration: number,
    ownership?: OwnedStartupRuntime
  ): Promise<void> {
    const isOnlyOperation = registration.isOnlyOperation();
    try {
      if (
        handle &&
        this.canUpdateFailedStartupState(sessionId, ownership, stopGeneration) &&
        this.dependencies.runtimeManager.getClient(sessionId) === handle &&
        (!ownership || this.canCleanupOwnedRuntime(sessionId, ownership)) &&
        (isOnlyOperation || workflow === ADVERSARIAL_REVIEW_WORKFLOW)
      ) {
        await this.dependencies.runtimeManager.stopClient(sessionId);
      }
    } catch (error) {
      logger.warn('Failed to stop runtime after client creation failure', {
        sessionId,
        error: toErrorMessage(error),
      });
    } finally {
      const current = this.dependencies.runtimeManager.getClient(sessionId);
      if (
        isOnlyOperation &&
        (!current || current === handle) &&
        this.canUpdateFailedStartupState(sessionId, ownership, stopGeneration)
      ) {
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
      if (session.workflow === ADVERSARIAL_REVIEW_WORKFLOW || options.startupModePreset) {
        await this.configureExistingClient(
          sessionId,
          session,
          existingAcp,
          stopGeneration,
          options
        );
      }
      await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);
      const isWorking = this.dependencies.runtimeManager.isSessionWorking(sessionId);
      this.dependencies.sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: isWorking ? 'running' : 'idle',
        processState: 'alive',
        activity: isWorking ? 'WORKING' : 'IDLE',
        ...getAcpWorkState(this.dependencies.runtimeManager.getClient(sessionId)),
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

    const startupOwnership = ownership ?? { shared: false };
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
            startupOwnership
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
            ...getAcpWorkState(this.dependencies.runtimeManager.getClient(sessionId)),
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
              stopGeneration,
              startupOwnership
            );
          }
          if (this.canUpdateFailedStartupState(sessionId, startupOwnership, stopGeneration)) {
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
      if (caller) {
        // Coalesced borrowers keep shared status after the original creation
        // operation finishes; they never acquire cleanup ownership of its handle.
        caller.shared = true;
      }
    }
  }

  private canCleanupOwnedRuntime(sessionId: string, ownership: OwnedStartupRuntime): boolean {
    return (
      !!ownership.handle &&
      !ownership.shared &&
      this.dependencies.runtimeManager.getClient(sessionId) === ownership.handle
    );
  }

  private canUpdateFailedStartupState(
    sessionId: string,
    ownership?: OwnedStartupRuntime,
    generation?: number
  ): boolean {
    if (
      generation !== undefined &&
      (this.dependencies.lifecycleGate.isSessionStopping(sessionId) ||
        !this.dependencies.lifecycleGate.isGenerationCurrent(sessionId, generation))
    ) {
      return false;
    }
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

  private async applyStartupModePreset(
    sessionId: string,
    handle: AcpProcessHandle,
    startupModePreset: SessionStartupModePreset | undefined,
    workflow: string
  ): Promise<void> {
    // Native access was already restored (or initialized) before persistence.
    // The legacy Claude execution preset must not broaden it to bypassPermissions.
    if (handle.provider === 'CLAUDE' && startupModePreset === 'non_interactive') {
      return;
    }
    await this.dependencies.sessionConfigService.applyStartupModePreset(
      sessionId,
      handle,
      startupModePreset,
      workflow,
      { persistSnapshot: this.persistAcpConfigSnapshot.bind(this) }
    );
  }

  private async configureExistingClient(
    sessionId: string,
    session: AgentSessionRecord,
    handle: AcpProcessHandle,
    stopGeneration: number,
    options: GetOrCreateSessionClientOptions
  ): Promise<void> {
    const configuration = handle.beginConfiguration();
    try {
      await this.applyStartupModePreset(
        sessionId,
        handle,
        options.startupModePreset,
        session.workflow
      );
      await this.reapplyReviewPermissions(sessionId, session, handle, stopGeneration);
      await this.assertCreationAllowed(sessionId, stopGeneration, options.assertCurrent);
      if (this.dependencies.runtimeManager.getClient(sessionId) !== handle) {
        throw new Error('Session runtime changed during configuration');
      }
      configuration.complete();
    } catch (error) {
      configuration.fail(error);
      throw error;
    }
  }

  private async reapplyReviewPermissions(
    sessionId: string,
    session: AgentSessionRecord,
    handle: AcpProcessHandle,
    stopGeneration: number,
    permissionPreset?: PermissionPreset,
    ownership?: OwnedStartupRuntime
  ): Promise<void> {
    if (session.workflow === ADVERSARIAL_REVIEW_WORKFLOW) {
      await this.applyConfiguredPermissionPreset(
        sessionId,
        session,
        handle,
        stopGeneration,
        permissionPreset,
        ownership
      );
    }
  }

  private async applyConfiguredPermissionPreset(
    sessionId: string,
    session: AgentSessionRecord,
    handle: AcpProcessHandle,
    stopGeneration: number,
    permissionPreset?: PermissionPreset,
    ownership?: OwnedStartupRuntime
  ): Promise<void> {
    await this.withPermissionFailureStop(
      sessionId,
      handle,
      stopGeneration,
      () =>
        this.dependencies.sessionConfigService.applyConfiguredPermissionPreset(
          sessionId,
          session,
          handle,
          permissionPreset
        ),
      ownership
    );
  }

  private async withPermissionFailureStop(
    sessionId: string,
    handle: AcpProcessHandle,
    stopGeneration: number,
    operation: () => Promise<void>,
    ownership?: OwnedStartupRuntime,
    onlyTerminalConfigFailure = false
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (onlyTerminalConfigFailure && !isTerminalConfigFailure(error)) {
        throw error;
      }
      if (isTerminalConfigFailure(error)) {
        handle.failConfiguration(error);
      }

      return stopStartupConfigurationFailure(sessionId, handle, stopGeneration, error, {
        runtimeManager: this.dependencies.runtimeManager,
        lifecycleGate: this.dependencies.lifecycleGate,
        sessionDomainService: this.dependencies.sessionDomainService,
        acpEventProcessor: this.dependencies.acpEventProcessor,
        canUpdateState: (generation) =>
          this.canUpdateFailedStartupState(sessionId, ownership, generation),
      });
    }
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
