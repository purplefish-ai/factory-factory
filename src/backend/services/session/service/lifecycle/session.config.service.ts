import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { withConfiguredAcpHandle } from '@/backend/services/session/service/acp/acp-configured-handle';
import {
  confirmsAcpModelSelection,
  resolveAcpModelSelection,
} from '@/backend/services/session/service/acp/acp-model-selection';
import { normalizeSessionConfigOptions } from '@/backend/services/session/service/acp/acp-session-config-options';
import { fetchSessionLaunchOptionsFromAcp } from '@/backend/services/session/service/acp/session-launch-options-probe';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { userSettingsService } from '@/backend/services/settings';
import type { SessionDeltaEvent, QueuedMessage } from '@/shared/acp-protocol';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import type { SessionLaunchOptions } from '@/shared/session-launch';
import type { SessionPermissionPreset } from '@prisma-gen/client';
import { parseAcpConfigSnapshot } from './acp-config-snapshot';
import type { CodexModelCatalogService } from './codex-model-catalog.service';
import { SessionConfigCommitAuthority } from './session-config-commit-authority';
import { SessionConfigMutationQueue } from './session-config-mutation-queue';
import {
  buildCapabilitiesFromConfigOptions,
  getConfigOptionValues,
  type CodexModelCatalogEntry,
  type SessionProvider,
} from './session-config-option-helpers';
import {
  buildStoredConfigProjection,
  type ResolvedSessionConfigProjection,
  type SessionConfigProjection,
} from './session-config-projection';
import {
  SessionConfigSnapshotPersistence,
  type PersistAcpConfigSnapshotParams,
} from './session-config-snapshot-persistence';
export type { PersistAcpConfigSnapshotParams } from './session-config-snapshot-persistence';
import { setInactiveSessionConfigOption } from './session-inactive-config-options';
import { SessionLaunchOptionsService } from './session-launch-options.service';
import { readSessionLaunchSettings } from './session-launch-settings';
import {
  applyReadOnlyReviewPermissions,
  assertReadOnlyReviewConfigOption,
  resolveConfiguredAccessModeTarget,
  SessionStartupPermissions,
  SessionStartupTargetError,
} from './session-permission-policy';
import { type AcceptedQueuedConfig, SessionQueuedSettings } from './session-queued-settings';
import {
  applyReasoningEffortTarget,
  type ReasoningEffortTargetParams,
} from './session-reasoning-configuration';
import { restoreSavedNativeModes } from './session-saved-native-modes';
import {
  SessionStartupConfigurationFinalizer,
  type CompleteStartupConfigurationParams,
} from './session-startup-configuration-finalizer';
import {
  applyStartupCollaborationModePreset,
  findCollaborationOption,
  resolveStartupModeTarget,
} from './session-startup-mode-preset';
import { applyStartupLaunchPlan } from './session-startup-plan';
import { configuredReasoningEffort, startupReasoningTarget } from './session-startup-reasoning';
import { getWorkflowPermissionPreset } from './session-workflow-permissions';
import type { SessionRepository } from './session.repository';

const logger = createLogger('session');

const MAX_CONFIG_READ_RETIREMENTS = 3;

type SessionStartupModePreset = 'non_interactive' | 'plan';
type SessionConfigReadContext = {
  catalog?: Promise<CodexModelCatalogEntry[] | null>;
  retirements: number;
};

export type SessionConfigServiceDependencies = {
  repository: SessionRepository;
  runtimeManager: AcpRuntimeManager;
  codexModelCatalogService: Pick<CodexModelCatalogService, 'getModels'>;
  sessionDomainService?: SessionDomainService;
  launchOptionsService?: Pick<SessionLaunchOptionsService, 'getOptions'>;
};

export class SessionConfigService {
  private readonly startupPermissions = new SessionStartupPermissions();
  private readonly snapshotPersistence: SessionConfigSnapshotPersistence;
  private readonly startupFinalizer: SessionStartupConfigurationFinalizer;
  private readonly configAuthority = new SessionConfigCommitAuthority();
  private readonly launchOptionsService: Pick<SessionLaunchOptionsService, 'getOptions'>;
  private readonly configUpdates: SessionConfigMutationQueue;
  private readonly queuedSettings: SessionQueuedSettings;
  private readonly repository: SessionRepository;
  private readonly runtimeManager: AcpRuntimeManager;
  private readonly sessionDomainService: SessionDomainService;
  private readonly codexModelCatalogService: Pick<CodexModelCatalogService, 'getModels'>;

  constructor(options: SessionConfigServiceDependencies) {
    this.launchOptionsService =
      options.launchOptionsService ??
      new SessionLaunchOptionsService({
        fetchOptions: fetchSessionLaunchOptionsFromAcp,
        getSettings: () => userSettingsService.get(),
      });
    this.repository = options.repository;
    this.snapshotPersistence = new SessionConfigSnapshotPersistence(options.repository);
    this.startupFinalizer = new SessionStartupConfigurationFinalizer(
      this.snapshotPersistence,
      this.configAuthority,
      this.startupPermissions,
      this.repository
    );
    this.runtimeManager = options.runtimeManager;
    this.queuedSettings = new SessionQueuedSettings(this.runtimeManager);
    this.codexModelCatalogService = options.codexModelCatalogService;
    this.sessionDomainService = options.sessionDomainService ?? sessionDomainService;
    this.configUpdates = new SessionConfigMutationQueue(
      this.runtimeManager,
      (sessionId, configOptions) => {
        this.sessionDomainService.emitDelta(sessionId, {
          type: 'config_options_update',
          configOptions,
        } as SessionDeltaEvent);
      }
    );
  }

  requireSavedStartupAccess(handle: AcpProcessHandle, metadata: unknown): void {
    const snapshot = parseAcpConfigSnapshot(metadata);
    if (
      snapshot?.provider === handle.provider &&
      snapshot.providerSessionId === handle.providerSessionId
    ) {
      this.startupPermissions.capture(handle, snapshot.configOptions);
    }
  }

  async applyStartupModel(
    sessionId: string,
    handle: AcpProcessHandle,
    model: string
  ): Promise<void> {
    const assertCurrent = this.acceptRuntime(sessionId, handle);
    const target = resolveAcpModelSelection(handle.provider, handle.configOptions, model);
    if (
      handle.configOptions.find((option) => option.id === target.configId)?.currentValue !==
      target.value
    ) {
      await this.runtimeManager.setSessionModel(sessionId, target.value);
    }
    assertCurrent();
    if (
      !confirmsAcpModelSelection(
        handle.provider,
        model,
        target.value,
        handle.configOptions.find((option) => option.id === target.configId)?.currentValue
      )
    ) {
      throw new SessionStartupTargetError(new Error('Requested startup model was not applied'));
    }
    this.acceptConfiguration(sessionId, handle);
  }

  async applyStartupLaunchPlan(
    sessionId: string,
    session: AgentSessionRecord,
    handle: AcpProcessHandle,
    preset: SessionPermissionPreset | undefined,
    override?: boolean
  ): Promise<void> {
    const assertCurrent = this.acceptRuntime(sessionId, handle);
    try {
      await applyStartupLaunchPlan(
        sessionId,
        session,
        handle,
        preset,
        this.runtimeManager,
        override,
        () =>
          this.resolvePermissionPresetFromSettings(sessionId, session.workflow, session.provider),
        {
          assertCurrent,
          confirmTarget: (id, value) => {
            this.startupPermissions.expectLaunchTarget(handle, id, value);
            this.acceptConfiguration(sessionId, handle);
          },
        }
      );
    } catch (error) {
      assertCurrent();
      throw new SessionStartupTargetError(error);
    }
  }

  getLaunchOptions(input: {
    provider: SessionProvider;
    model?: string;
  }): Promise<SessionLaunchOptions> {
    return this.launchOptionsService.getOptions(input);
  }

  applyConfigOptionsUpdateDelta(
    sessionId: string,
    handle: AcpProcessHandle,
    configOptions: SessionConfigOption[],
    isCurrentSource?: () => boolean
  ): void {
    const assertCurrent = isCurrentSource
      ? () => {
          if (!isCurrentSource()) {
            throw new Error('Session runtime changed before configuration update');
          }
        }
      : this.acceptRuntime(sessionId, handle);
    try {
      assertCurrent();
    } catch {
      return;
    }
    const normalizedConfigOptions = normalizeSessionConfigOptions(handle.provider, configOptions);
    handle.configOptions = normalizedConfigOptions;
    void this.persistAcpConfigSnapshot(sessionId, {
      provider: handle.provider as SessionProvider,
      providerSessionId: handle.providerSessionId,
      configOptions: normalizedConfigOptions,
      assertCurrent,
    }).catch((error: unknown) => {
      logger.warn('Failed persisting native configuration update', { sessionId, error });
    });

    this.sessionDomainService.emitDelta(sessionId, {
      type: 'config_options_update',
      configOptions: normalizedConfigOptions,
    } as SessionDeltaEvent);
    this.sessionDomainService.emitDelta(sessionId, {
      type: 'chat_capabilities',
      capabilities: this.buildAcpChatBarCapabilities(handle),
    });
  }

  async applyStartupModePreset(
    sessionId: string,
    handle: AcpProcessHandle,
    startupModePreset: SessionStartupModePreset | undefined,
    workflow: string,
    options?: {
      persistSnapshot?: (
        sessionId: string,
        params: PersistAcpConfigSnapshotParams
      ) => Promise<void>;
    }
  ): Promise<void> {
    if (!startupModePreset) {
      return;
    }

    const didUpdate = await applyStartupCollaborationModePreset(
      this.runtimeManager,
      {
        sessionId,
        handle,
        startupModePreset,
        workflow,
        assertCurrent: this.acceptRuntime(sessionId, handle),
      },
      (id, value) => this.startupPermissions.authorizeRequestedTarget(handle, id, value)
    );

    if (!didUpdate) {
      return;
    }

    const persistSnapshot =
      options?.persistSnapshot ?? this.snapshotPersistence.persist.bind(this.snapshotPersistence);
    const configOptions = structuredClone(handle.configOptions);
    const accepted = this.acceptConfiguration(sessionId, handle);
    try {
      if (
        !(await accepted.persist((assertCurrent) =>
          persistSnapshot(sessionId, {
            provider: handle.provider as SessionProvider,
            providerSessionId: handle.providerSessionId,
            configOptions,
            assertCurrent,
          })
        ))
      ) {
        return;
      }
      if (!accepted.isCurrent()) {
        return;
      }

      this.sessionDomainService.emitDelta(sessionId, {
        type: 'config_options_update',
        configOptions,
      } as SessionDeltaEvent);
      this.sessionDomainService.emitDelta(sessionId, {
        type: 'chat_capabilities',
        capabilities: this.buildAcpChatBarCapabilities(handle),
      });
    } catch (error) {
      logger.warn('Failed persisting startup mode preset configuration snapshot', {
        sessionId,
        provider: handle.provider,
        workflow,
        startupModePreset,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async applyConfiguredPermissionPreset(
    sessionId: string,
    session: AgentSessionRecord,
    handle: AcpProcessHandle,
    preResolvedPreset?: SessionPermissionPreset
  ): Promise<void> {
    if (session.workflow === ADVERSARIAL_REVIEW_WORKFLOW) {
      this.startupPermissions.captureReview(handle);
      const changed = await applyReadOnlyReviewPermissions(sessionId, handle, this.runtimeManager);
      this.startupPermissions.assertCurrent(handle);
      if (changed) {
        await this.persistAndEmitConfigOptions(sessionId, handle);
      }
      this.startupPermissions.assertCurrent(handle);
      return;
    }

    if (await this.restoreNativeModes(sessionId, session, handle)) {
      return;
    }

    const accessModeOption = handle.configOptions.find(
      (option) => option.id === 'mode' || option.category === 'mode'
    );
    if (!accessModeOption) {
      return;
    }

    const permissionPreset =
      preResolvedPreset ??
      (await this.resolvePermissionPresetFromSettings(
        sessionId,
        session.workflow,
        session.provider
      ));

    // Claude plan mode is also its read-only access mode. Preserve planning.
    if (handle.provider === 'CLAUDE' && accessModeOption.currentValue === 'plan') {
      this.startupPermissions.expectAccess(handle, accessModeOption.id, 'plan');
      return;
    }
    const targetAccessMode = resolveConfiguredAccessModeTarget(
      handle.provider,
      accessModeOption,
      permissionPreset
    );
    if (!targetAccessMode) {
      throw new Error(
        `Configured ${permissionPreset} access mode is unavailable for ${handle.provider}`
      );
    }

    if (
      handle.configOptions.find((option) => option.id === accessModeOption.id)?.currentValue ===
      targetAccessMode
    ) {
      this.startupPermissions.capture(handle);
      return;
    }

    try {
      await this.runtimeManager.setConfigOption(sessionId, accessModeOption.id, targetAccessMode);
      this.startupPermissions.expectAccess(handle, accessModeOption.id, targetAccessMode);
      await this.persistAndEmitConfigOptions(sessionId, handle);
      this.startupPermissions.assertCurrent(handle);
    } catch (error) {
      logger.warn('Failed applying configured session permission preset', {
        sessionId,
        workflow: session.workflow,
        permissionPreset,
        targetAccessMode,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async restoreNativeModes(
    sessionId: string,
    session: AgentSessionRecord,
    handle: AcpProcessHandle
  ): Promise<boolean> {
    const snapshot = parseAcpConfigSnapshot(session.providerMetadata);
    if (snapshot) {
      this.startupPermissions.capture(
        handle,
        snapshot.configOptions,
        readSessionLaunchSettings(session.providerMetadata)?.planModeEnabled !== undefined
      );
    }
    const restored = await restoreSavedNativeModes(sessionId, session, handle, this.runtimeManager);
    if (restored === undefined) {
      return false;
    }
    this.startupPermissions.assertCurrent(handle);
    if (restored) {
      await this.persistAndEmitConfigOptions(sessionId, handle);
    }
    this.startupPermissions.assertCurrent(handle);
    return true;
  }

  private async persistAndEmitConfigOptions(
    sessionId: string,
    handle: AcpProcessHandle
  ): Promise<void> {
    const configOptions = structuredClone(handle.configOptions);
    const accepted = this.acceptConfiguration(sessionId, handle);
    if (
      !(await accepted.persist((assertCurrent) =>
        this.snapshotPersistence.persist(sessionId, {
          provider: handle.provider as SessionProvider,
          providerSessionId: handle.providerSessionId,
          configOptions,
          assertCurrent,
        })
      ))
    ) {
      return;
    }
    if (!accepted.isCurrent()) {
      return;
    }
    this.sessionDomainService.emitDelta(sessionId, {
      type: 'config_options_update',
      configOptions,
    } as SessionDeltaEvent);
    this.sessionDomainService.emitDelta(sessionId, {
      type: 'chat_capabilities',
      capabilities: this.buildAcpChatBarCapabilities(handle),
    });
  }

  getSessionConfigOptions(sessionId: string): SessionConfigOption[] {
    const acpHandle = this.runtimeManager.getClient(sessionId);
    return acpHandle ? [...acpHandle.configOptions] : [];
  }

  async getSessionConfigOptionsWithFallback(sessionId: string): Promise<SessionConfigOption[]> {
    let resolved = await this.getSessionConfigProjection(sessionId);
    for (;;) {
      const current = resolved.currentProjection();
      if ('retry' in current) {
        resolved = await current.retry;
        continue;
      }
      return current.configOptions;
    }
  }

  getSessionConfigProjection(sessionId: string): Promise<ResolvedSessionConfigProjection> {
    return this.readSessionConfigProjection(sessionId, { retirements: 0 });
  }

  private async readSessionConfigProjection(
    sessionId: string,
    context: SessionConfigReadContext
  ): Promise<ResolvedSessionConfigProjection> {
    const live = this.runtimeManager.getClient(sessionId);
    if (live && live.configOptions.length > 0) {
      return this.resolveConfigProjection(sessionId, null, context);
    }

    let session = await this.repository.getSessionById(sessionId);
    // A runtime installed during the read owns its options without catalog enrichment.
    const current = this.runtimeManager.getClient(sessionId);
    if (current && current.configOptions.length > 0) {
      return this.resolveConfigProjection(sessionId, null, context);
    }
    let modelCatalog = null;
    if (session?.provider === 'CODEX') {
      context.catalog ??= this.codexModelCatalogService.getModels().catch((error: unknown) => {
        logger.warn('Failed to refresh Codex model catalog from app-server fallback', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      modelCatalog = await context.catalog;
      // Passive discovery must not retain a selection from before a stopped edit.
      session = await this.repository.getSessionById(sessionId);
    }
    return this.resolveConfigProjection(
      sessionId,
      buildStoredConfigProjection(session, modelCatalog),
      context
    );
  }

  private resolveConfigProjection(
    sessionId: string,
    fallback: SessionConfigProjection | null,
    context: SessionConfigReadContext
  ): ResolvedSessionConfigProjection {
    const observedLive = this.runtimeManager.getClient(sessionId);
    const hadLiveOptions = !!observedLive?.configOptions.length;
    let retry: Promise<ResolvedSessionConfigProjection> | undefined;
    const refreshRetired = () => {
      if (!retry) {
        if (context.retirements >= MAX_CONFIG_READ_RETIREMENTS) {
          throw new Error('Session runtime retired repeatedly during configuration read');
        }
        context.retirements += 1;
        retry = this.readSessionConfigProjection(sessionId, context);
      }
      return { retry };
    };
    return {
      currentProjection: () => {
        const handle = this.runtimeManager.getClient(sessionId);
        if (!handle?.configOptions.length && (hadLiveOptions || !fallback)) {
          return refreshRetired();
        }
        if (!handle) {
          if (!fallback) {
            throw new Error('Session configuration requires a durable reread');
          }
          return fallback;
        }
        const configOptions = structuredClone(handle.configOptions);
        return {
          capabilities: buildCapabilitiesFromConfigOptions(
            handle.provider as SessionProvider,
            configOptions
          ),
          // Preserve the existing empty-handle contract: live capabilities, cached options.
          configOptions: configOptions.length > 0 ? configOptions : (fallback?.configOptions ?? []),
        };
      },
    };
  }

  resolveQueuedMessageSettings(
    sessionId: string,
    message: Pick<QueuedMessage, 'timestamp' | 'settings'>
  ): QueuedMessage['settings'] {
    return this.queuedSettings.resolve(sessionId, message);
  }

  configureQueuedMessage(
    sessionId: string,
    message: Pick<QueuedMessage, 'timestamp' | 'settings'>,
    supportsThinkingBudget = false
  ): Promise<QueuedMessage['settings']> {
    return this.configUpdates.run(sessionId, () =>
      this.queuedSettings.configure(sessionId, message, supportsThinkingBudget, {
        plan: () => this.setSessionCollaborationModeUnserialized(sessionId, 'plan'),
        thinking: (budget) => this.setSessionThinkingBudgetUnserialized(sessionId, budget),
        model: (model) => this.setSessionModelUnserialized(sessionId, model),
        reasoning: (effort) => this.setSessionReasoningEffortUnserialized(sessionId, effort),
      })
    );
  }

  async setSessionModel(sessionId: string, model?: string, source?: 'user'): Promise<void> {
    await this.configUpdates.run(
      sessionId,
      this.queuedSettings.capture(sessionId, source && model ? 'model' : undefined, () =>
        this.setSessionModelUnserialized(sessionId, model)
      )
    );
  }

  private async setSessionModelUnserialized(
    sessionId: string,
    model?: string
  ): Promise<AcceptedQueuedConfig | undefined> {
    if (!model) {
      return;
    }
    const handle = this.runtimeManager.getClient(sessionId);
    if (handle) {
      return await withConfiguredAcpHandle(this.runtimeManager, sessionId, handle, async () => {
        const target = resolveAcpModelSelection(handle.provider, handle.configOptions, model);
        return await this.setSessionConfigOptionUnserialized(
          sessionId,
          target.configId,
          target.value
        );
      });
    }
    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const snapshot = parseAcpConfigSnapshot(session.providerMetadata);
    if (!snapshot) {
      return await this.setSessionConfigOptionUnserialized(sessionId, 'model', model);
    }
    const target = resolveAcpModelSelection(session.provider, snapshot.configOptions, model);
    return await this.setSessionConfigOptionUnserialized(sessionId, target.configId, target.value);
  }

  async setSessionCollaborationMode(sessionId: string, mode: 'plan'): Promise<void> {
    await this.configUpdates.run(sessionId, () =>
      this.setSessionCollaborationModeUnserialized(sessionId, mode)
    );
  }

  private async setSessionCollaborationModeUnserialized(
    sessionId: string,
    mode: 'plan'
  ): Promise<void> {
    const acpHandle = this.runtimeManager.getClient(sessionId);
    if (!acpHandle) {
      logger.debug('No ACP handle for setSessionCollaborationMode', { sessionId, mode });
      return;
    }

    const modeOption = findCollaborationOption(acpHandle.provider, acpHandle.configOptions);
    if (!modeOption) {
      return;
    }

    const availableModeValues = getConfigOptionValues(modeOption);
    const targetMode = resolveStartupModeTarget(
      acpHandle.provider as SessionProvider,
      mode,
      availableModeValues
    );
    if (!targetMode || modeOption.currentValue === targetMode) {
      return;
    }

    await this.setSessionConfigOptionUnserialized(sessionId, modeOption.id, targetMode);
  }

  async setSessionThinkingBudget(sessionId: string, maxTokens: number | null): Promise<void> {
    await this.configUpdates.run(
      sessionId,
      this.queuedSettings.captureThinking(sessionId, maxTokens, () =>
        this.setSessionThinkingBudgetUnserialized(sessionId, maxTokens)
      )
    );
  }

  private async setSessionThinkingBudgetUnserialized(
    sessionId: string,
    maxTokens: number | null
  ): Promise<void> {
    const acpHandle = this.runtimeManager.getClient(sessionId);
    if (acpHandle) {
      const thoughtOption = acpHandle.configOptions.find(
        (option) => option.category === 'thought_level'
      );
      if (thoughtOption && maxTokens != null) {
        const availableValues = getConfigOptionValues(thoughtOption);
        const thinkingBudget = String(maxTokens);
        if (availableValues.length > 0 && !availableValues.includes(thinkingBudget)) {
          logger.debug('Skipping unsupported thinking budget for ACP session', {
            sessionId,
            provider: acpHandle.provider,
            maxTokens,
            availableValues,
          });
          return;
        }

        await this.setSessionConfigOptionUnserialized(sessionId, thoughtOption.id, thinkingBudget);
      }
      return;
    }

    logger.debug('No ACP handle for setSessionThinkingBudget', { sessionId, maxTokens });
  }

  async setSessionReasoningEffort(
    sessionId: string,
    reasoningEffort: string | null,
    source?: 'user'
  ): Promise<void> {
    await this.configUpdates.run(
      sessionId,
      this.queuedSettings.capture(sessionId, source ? 'thought_level' : undefined, () =>
        this.setSessionReasoningEffortUnserialized(sessionId, reasoningEffort)
      )
    );
  }

  private async setSessionReasoningEffortUnserialized(
    sessionId: string,
    reasoningEffort: string | null
  ): Promise<void> {
    const acpHandle = this.runtimeManager.getClient(sessionId);
    if (!acpHandle) {
      logger.debug('No ACP handle for setSessionReasoningEffort', { sessionId, reasoningEffort });
      return;
    }

    const requestedReasoningEffort = reasoningEffort?.trim();
    const targetReasoningEffort =
      requestedReasoningEffort ||
      (await configuredReasoningEffort(sessionId, acpHandle.provider as SessionProvider));
    if (!targetReasoningEffort) {
      return;
    }

    await withConfiguredAcpHandle(this.runtimeManager, sessionId, acpHandle, () =>
      this.applyReasoningEffortTarget({
        sessionId,
        handle: acpHandle,
        targetReasoningEffort,
        source: requestedReasoningEffort ? 'message' : 'settings',
        assertCurrent: () => this.assertCurrentConfiguredHandle(sessionId, acpHandle),
      })
    );
  }

  async applyConfiguredReasoningEffort(
    sessionId: string,
    handle: AcpProcessHandle,
    options?: {
      persistSnapshot?: boolean;
      emitUpdates?: boolean;
      session?: AgentSessionRecord;
      reasoningEffort?: string | null;
    }
  ): Promise<void> {
    const assertCurrent = this.acceptRuntime(sessionId, handle);
    try {
      const target = await startupReasoningTarget(
        sessionId,
        handle,
        options?.session,
        options?.reasoningEffort
      );
      const targetReasoningEffort = target.value;
      if (!targetReasoningEffort) {
        return;
      }

      await this.applyReasoningEffortTarget({
        sessionId,
        handle,
        targetReasoningEffort,
        source: 'settings',
        strict: target.strict,
        normalizeUnsupported: target.normalizeUnsupported,
        assertCurrent,
        ...(target.strict && !target.normalizeUnsupported
          ? {
              confirmTarget: (id: string, value: string) =>
                this.startupPermissions.expectLaunchTarget(handle, id, value),
            }
          : {}),
        persistSnapshot: options?.persistSnapshot,
        emitUpdates: options?.emitUpdates,
      });
    } catch (error) {
      assertCurrent();
      throw new SessionStartupTargetError(error);
    }
  }

  async setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    await this.configUpdates.run(
      sessionId,
      this.queuedSettings.capture(sessionId, configId, () =>
        this.setSessionConfigOptionUnserialized(sessionId, configId, value)
      )
    );
  }

  private async setSessionConfigOptionUnserialized(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<AcceptedQueuedConfig | undefined> {
    const acpHandle = this.runtimeManager.getClient(sessionId);
    if (!acpHandle) {
      return await this.updateInactiveSessionConfigOption(sessionId, configId, value);
    }

    while (acpHandle.configurationReady !== undefined) {
      await acpHandle.configurationReady;
    }
    this.assertCurrentConfiguredHandle(sessionId, acpHandle);
    const selectedOption = acpHandle.configOptions.find((option) => option.id === configId);
    const isModeOption = configId === 'mode' || selectedOption?.category === 'mode';
    const isModelOption = configId === 'model' || selectedOption?.category === 'model';
    if (isModelOption) {
      value = resolveAcpModelSelection(acpHandle.provider, acpHandle.configOptions, value).value;
    }
    if (
      isModeOption ||
      configId === 'collaboration_mode' ||
      selectedOption?.category === 'collaboration_mode'
    ) {
      const session = await this.repository.getSessionById(sessionId);
      assertReadOnlyReviewConfigOption(
        session?.workflow,
        configId,
        value,
        selectedOption,
        acpHandle.provider
      );
    }

    await withConfiguredAcpHandle(this.runtimeManager, sessionId, acpHandle, () =>
      isModeOption
        ? this.runtimeManager.setSessionMode(sessionId, value)
        : isModelOption
          ? this.runtimeManager.setSessionModel(sessionId, value)
          : this.runtimeManager.setConfigOption(sessionId, configId, value)
    );

    this.assertCurrentConfiguredHandle(sessionId, acpHandle);
    const configOptions = structuredClone(acpHandle.configOptions);
    const accepted = this.acceptConfiguration(sessionId, acpHandle, () =>
      this.assertCurrentConfiguredHandle(sessionId, acpHandle)
    );
    if (
      !(await accepted.persist((assertCurrent) =>
        this.snapshotPersistence.persist(sessionId, {
          provider: acpHandle.provider as SessionProvider,
          providerSessionId: acpHandle.providerSessionId,
          configOptions,
          assertCurrent,
        })
      ))
    ) {
      return;
    }
    if (!accepted.isCurrent()) {
      return;
    }
    this.sessionDomainService.emitDelta(sessionId, {
      type: 'config_options_update',
      configOptions,
    } as SessionDeltaEvent);
    return { provider: acpHandle.provider, configOptions };
  }

  private async updateInactiveSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<AcceptedQueuedConfig | undefined> {
    const update = await setInactiveSessionConfigOption(sessionId, configId, value, {
      repository: this.repository,
      runtimeManager: this.runtimeManager,
      catalog: this.codexModelCatalogService,
      persistSnapshot: this.persistAcpConfigSnapshot.bind(this),
      accept: (assertCurrent) => this.configAuthority.accept(sessionId, assertCurrent),
    });
    if (!update) {
      return await this.setSessionConfigOptionUnserialized(sessionId, configId, value);
    }
    if (
      this.runtimeManager.getClient(sessionId) ||
      this.runtimeManager.getPendingClient?.(sessionId) !== undefined
    ) {
      return await this.setSessionConfigOptionUnserialized(sessionId, configId, value);
    }
    if (!update.accepted.isCurrent()) {
      return;
    }
    const { provider, configOptions } = update;
    this.sessionDomainService.emitDelta(sessionId, {
      type: 'config_options_update',
      configOptions,
    } as SessionDeltaEvent);
    this.sessionDomainService.emitDelta(sessionId, {
      type: 'chat_capabilities',
      capabilities: buildCapabilitiesFromConfigOptions(provider, configOptions),
    });
    return update;
  }

  private assertCurrentConfiguredHandle(sessionId: string, handle: AcpProcessHandle): void {
    if (
      this.runtimeManager.getClient(sessionId) !== handle ||
      this.runtimeManager.isStopInProgress(sessionId) ||
      handle.configurationReady !== undefined
    ) {
      throw new Error('Session runtime changed before configuration update');
    }
  }

  async getChatBarCapabilities(sessionId: string): Promise<ChatBarCapabilities> {
    const handle = this.runtimeManager.getClient(sessionId);
    if (handle && handle.configOptions.length === 0) {
      return this.buildAcpChatBarCapabilities(handle);
    }
    let resolved = await this.getSessionConfigProjection(sessionId);
    for (;;) {
      const current = resolved.currentProjection();
      if ('retry' in current) {
        resolved = await current.retry;
        continue;
      }
      return current.capabilities;
    }
  }

  buildAcpChatBarCapabilities(handle: AcpProcessHandle): ChatBarCapabilities {
    return buildCapabilitiesFromConfigOptions(
      handle.provider as SessionProvider,
      handle.configOptions
    );
  }

  async persistAcpConfigSnapshot(
    sessionId: string,
    params: PersistAcpConfigSnapshotParams
  ): Promise<void> {
    const handle = this.runtimeManager.getClient(sessionId);
    params.assertCurrent?.();
    const configOptions =
      handle?.provider === params.provider && handle.providerSessionId === params.providerSessionId
        ? handle.configOptions
        : params.configOptions;
    const accepted = this.acceptConfiguration(sessionId, handle, params.assertCurrent);
    await accepted.persist((assertCurrent) =>
      this.snapshotPersistence.persist(sessionId, { ...params, configOptions, assertCurrent })
    );
  }

  releaseSessionConfiguration(sessionId: string): void {
    this.configAuthority.release(sessionId);
    this.queuedSettings.release(sessionId);
  }

  async completeStartupConfiguration(
    sessionId: string,
    params: CompleteStartupConfigurationParams
  ): Promise<void> {
    await this.startupFinalizer.complete(sessionId, params);
  }

  private acceptConfiguration(
    sessionId: string,
    handle?: AcpProcessHandle,
    assertCurrent?: () => void
  ) {
    return this.configAuthority.accept(
      sessionId,
      assertCurrent ?? this.acceptRuntime(sessionId, handle)
    );
  }

  private acceptRuntime(sessionId: string, handle?: AcpProcessHandle): () => void {
    return () => {
      if (
        handle &&
        (this.runtimeManager.getClient(sessionId) !== handle ||
          this.runtimeManager.isStopInProgress(sessionId))
      ) {
        throw new Error('Session runtime changed before configuration update');
      }
    };
  }

  private async resolvePermissionPresetFromSettings(
    sessionId: string,
    workflow: string,
    provider: SessionProvider
  ): Promise<SessionPermissionPreset> {
    const fallback: SessionPermissionPreset = getWorkflowPermissionPreset(workflow, provider);
    try {
      const settings = await userSettingsService.get();
      return getWorkflowPermissionPreset(workflow, provider, settings);
    } catch (error) {
      logger.warn('Failed loading user permission presets; using defaults', {
        sessionId,
        workflow,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }

  private applyReasoningEffortTarget(params: ReasoningEffortTargetParams): Promise<void> {
    return applyReasoningEffortTarget(params, {
      runtimeManager: this.runtimeManager,
      acceptConfiguration: (assertCurrent) =>
        this.acceptConfiguration(params.sessionId, params.handle, assertCurrent),
      persistSnapshot: this.persistAcpConfigSnapshot.bind(this),
      emitDelta: this.sessionDomainService.emitDelta.bind(this.sessionDomainService),
    });
  }
}
