import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { withConfiguredAcpHandle } from '@/backend/services/session/service/acp/acp-configured-handle';
import { resolveAcpModelSelection } from '@/backend/services/session/service/acp/acp-model-selection';
import { normalizeSessionConfigOptions } from '@/backend/services/session/service/acp/acp-session-config-options';
import { fetchSessionLaunchOptionsFromAcp } from '@/backend/services/session/service/acp/session-launch-options-probe';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { userSettingsService } from '@/backend/services/settings';
import type { SessionDeltaEvent } from '@/shared/acp-protocol';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import type { SessionLaunchOptions } from '@/shared/session-launch';
import type { SessionPermissionPreset } from '@prisma-gen/client';
import { parseAcpConfigSnapshot } from './acp-config-snapshot';
import type { CodexModelCatalogService } from './codex-model-catalog.service';
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
import { setInactiveSessionConfigOption } from './session-inactive-config-options';
import { SessionLaunchOptionsService } from './session-launch-options.service';
import {
  applyReadOnlyReviewPermissions,
  assertReadOnlyReviewConfigOption,
  resolveConfiguredAccessModeTarget,
} from './session-permission-policy';
import {
  applyReasoningEffortTarget,
  type ReasoningEffortTargetParams,
} from './session-reasoning-configuration';
import { restoreSavedNativeModes } from './session-saved-native-modes';
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
export type { PersistAcpConfigSnapshotParams } from './session-config-snapshot-persistence';

export type SessionConfigServiceDependencies = {
  repository: SessionRepository;
  runtimeManager: AcpRuntimeManager;
  codexModelCatalogService: Pick<CodexModelCatalogService, 'getModels'>;
  sessionDomainService?: SessionDomainService;
  launchOptionsService?: Pick<SessionLaunchOptionsService, 'getOptions'>;
};

export class SessionConfigService {
  private readonly launchOptionsService: Pick<SessionLaunchOptionsService, 'getOptions'>;
  private readonly snapshotPersistence: SessionConfigSnapshotPersistence;
  private readonly configUpdates: SessionConfigMutationQueue;
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
    this.snapshotPersistence = new SessionConfigSnapshotPersistence(this.repository);
    this.runtimeManager = options.runtimeManager;
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

  applyStartupLaunchPlan(
    sessionId: string,
    session: AgentSessionRecord,
    handle: AcpProcessHandle,
    preset: SessionPermissionPreset | undefined,
    override?: boolean
  ): Promise<void> {
    return applyStartupLaunchPlan(
      sessionId,
      session,
      handle,
      preset,
      this.runtimeManager,
      override,
      () => this.resolvePermissionPresetFromSettings(sessionId, session.workflow, session.provider)
    );
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
      : undefined;
    if (isCurrentSource && !isCurrentSource()) {
      return;
    }
    const normalizedConfigOptions = normalizeSessionConfigOptions(handle.provider, configOptions);
    handle.configOptions = normalizedConfigOptions;
    void this.persistAcpConfigSnapshot(sessionId, {
      provider: handle.provider as SessionProvider,
      providerSessionId: handle.providerSessionId,
      configOptions: normalizedConfigOptions,
      ...(assertCurrent ? { assertCurrent } : {}),
    }).catch((error: unknown) => {
      logger.warn('Failed persisting native ACP configuration update', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
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

    const modeResult = await this.applyStartupCollaborationModePreset({
      sessionId,
      handle,
      startupModePreset,
      workflow,
      configOptions: handle.configOptions,
    });
    const didUpdate = modeResult.didUpdate;

    if (!didUpdate) {
      return;
    }

    const persistSnapshot = options?.persistSnapshot ?? this.persistAcpConfigSnapshot.bind(this);
    handle.configOptions = modeResult.configOptions;
    try {
      await persistSnapshot(sessionId, {
        provider: handle.provider as SessionProvider,
        providerSessionId: handle.providerSessionId,
        configOptions: modeResult.configOptions,
      });

      this.sessionDomainService.emitDelta(sessionId, {
        type: 'config_options_update',
        configOptions: modeResult.configOptions,
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
      if (await applyReadOnlyReviewPermissions(sessionId, handle, this.runtimeManager)) {
        await this.persistAndEmitConfigOptions(sessionId, handle);
      }
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

    const currentAccessMode = accessModeOption.currentValue
      ? String(accessModeOption.currentValue)
      : null;
    if (currentAccessMode === targetAccessMode) {
      return;
    }

    try {
      const configOptions = await this.runtimeManager.setConfigOption(
        sessionId,
        accessModeOption.id,
        targetAccessMode
      );
      if (
        configOptions.find((option) => option.id === accessModeOption.id)?.currentValue !==
        targetAccessMode
      ) {
        throw new Error('Configured session access mode was not applied');
      }
      handle.configOptions = configOptions;
      await this.persistAndEmitConfigOptions(sessionId, handle);
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
    const restored = await restoreSavedNativeModes(sessionId, session, handle, this.runtimeManager);
    if (restored === undefined) {
      return false;
    }
    if (restored) {
      await this.persistAndEmitConfigOptions(sessionId, handle);
    }
    return true;
  }

  private async persistAndEmitConfigOptions(
    sessionId: string,
    handle: AcpProcessHandle
  ): Promise<void> {
    const configOptions = handle.configOptions;
    await this.persistAcpConfigSnapshot(sessionId, {
      provider: handle.provider as SessionProvider,
      providerSessionId: handle.providerSessionId,
      configOptions,
    });
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

  async setSessionModel(sessionId: string, model?: string): Promise<void> {
    await this.configUpdates.run(sessionId, () =>
      this.setSessionModelUnserialized(sessionId, model)
    );
  }

  private async setSessionModelUnserialized(sessionId: string, model?: string): Promise<void> {
    if (!model) {
      return;
    }
    const handle = this.runtimeManager.getClient(sessionId);
    if (handle) {
      await withConfiguredAcpHandle(this.runtimeManager, sessionId, handle, async () => {
        const target = resolveAcpModelSelection(handle.provider, handle.configOptions, model);
        await this.setSessionConfigOptionUnserialized(sessionId, target.configId, target.value);
      });
      return;
    }
    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const snapshot = parseAcpConfigSnapshot(session.providerMetadata);
    if (!snapshot) {
      await this.setSessionConfigOptionUnserialized(sessionId, 'model', model);
      return;
    }
    const target = resolveAcpModelSelection(session.provider, snapshot.configOptions, model);
    await this.setSessionConfigOptionUnserialized(sessionId, target.configId, target.value);
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

    const modeOption = this.findCollaborationOption(acpHandle.provider, acpHandle.configOptions);
    if (!modeOption) {
      return;
    }

    const availableModeValues = getConfigOptionValues(modeOption);
    const targetMode = this.resolveStartupModeTarget(
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
    await this.configUpdates.run(sessionId, () =>
      this.setSessionThinkingBudgetUnserialized(sessionId, maxTokens)
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
    reasoningEffort: string | null
  ): Promise<void> {
    await this.configUpdates.run(sessionId, () =>
      this.setSessionReasoningEffortUnserialized(sessionId, reasoningEffort)
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
      persistSnapshot: options?.persistSnapshot,
      emitUpdates: options?.emitUpdates,
    });
  }

  async setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    await this.configUpdates.run(sessionId, () =>
      this.setSessionConfigOptionUnserialized(sessionId, configId, value)
    );
  }

  private async setSessionConfigOptionUnserialized(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<void> {
    const acpHandle = this.runtimeManager.getClient(sessionId);
    if (!acpHandle) {
      const update = await setInactiveSessionConfigOption(sessionId, configId, value, {
        repository: this.repository,
        runtimeManager: this.runtimeManager,
        catalog: this.codexModelCatalogService,
        persistSnapshot: this.persistAcpConfigSnapshot.bind(this),
      });
      if (!update) {
        await this.setSessionConfigOptionUnserialized(sessionId, configId, value);
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
      return;
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

    const configOptions = await withConfiguredAcpHandle(
      this.runtimeManager,
      sessionId,
      acpHandle,
      () =>
        isModeOption
          ? this.runtimeManager.setSessionMode(sessionId, value)
          : isModelOption
            ? this.runtimeManager.setSessionModel(sessionId, value)
            : this.runtimeManager.setConfigOption(sessionId, configId, value)
    );

    this.assertCurrentConfiguredHandle(sessionId, acpHandle);
    await this.persistAcpConfigSnapshot(sessionId, {
      provider: acpHandle.provider as SessionProvider,
      providerSessionId: acpHandle.providerSessionId,
      configOptions,
      assertCurrent: () => this.assertCurrentConfiguredHandle(sessionId, acpHandle),
    });
    this.assertCurrentConfiguredHandle(sessionId, acpHandle);
    this.sessionDomainService.emitDelta(sessionId, {
      type: 'config_options_update',
      configOptions,
    } as SessionDeltaEvent);
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

  persistAcpConfigSnapshot(
    sessionId: string,
    params: PersistAcpConfigSnapshotParams
  ): Promise<void> {
    return this.snapshotPersistence.persist(sessionId, params);
  }

  private async applyStartupCollaborationModePreset(params: {
    sessionId: string;
    handle: AcpProcessHandle;
    startupModePreset: SessionStartupModePreset;
    workflow: string;
    configOptions: SessionConfigOption[];
  }): Promise<{ configOptions: SessionConfigOption[]; didUpdate: boolean }> {
    const modeOption = this.findCollaborationOption(params.handle.provider, params.configOptions);
    if (!modeOption) {
      return { configOptions: params.configOptions, didUpdate: false };
    }

    const availableModeValues = getConfigOptionValues(modeOption);
    const targetMode = this.resolveStartupModeTarget(
      params.handle.provider as SessionProvider,
      params.startupModePreset,
      availableModeValues
    );
    if (!targetMode) {
      logger.debug('Startup mode preset not available in ACP mode options', {
        sessionId: params.sessionId,
        provider: params.handle.provider,
        workflow: params.workflow,
        startupModePreset: params.startupModePreset,
        availableModeValues,
      });
      return { configOptions: params.configOptions, didUpdate: false };
    }

    const currentMode = modeOption.currentValue ? String(modeOption.currentValue) : null;
    if (currentMode === targetMode) {
      return { configOptions: params.configOptions, didUpdate: false };
    }

    try {
      const configOptions =
        modeOption.id === 'mode'
          ? await this.runtimeManager.setSessionMode(params.sessionId, targetMode)
          : await this.runtimeManager.setConfigOption(params.sessionId, modeOption.id, targetMode);
      return { configOptions, didUpdate: true };
    } catch (error) {
      logger.warn('Failed applying startup mode preset', {
        sessionId: params.sessionId,
        provider: params.handle.provider,
        workflow: params.workflow,
        startupModePreset: params.startupModePreset,
        targetMode,
        error: error instanceof Error ? error.message : String(error),
      });
      return { configOptions: params.configOptions, didUpdate: false };
    }
  }

  private findCollaborationOption(provider: string, configOptions: SessionConfigOption[]) {
    return configOptions.find((option) =>
      provider === 'CODEX'
        ? option.id === 'collaboration_mode' || option.category === 'collaboration_mode'
        : option.id === 'mode' || option.category === 'mode'
    );
  }

  private resolveStartupModeTarget(
    provider: SessionProvider,
    startupModePreset: SessionStartupModePreset,
    availableModeValues: string[]
  ): string | null {
    if (availableModeValues.length === 0) {
      return null;
    }

    if (startupModePreset === 'plan') {
      return this.findModeValue(availableModeValues, ['plan']);
    }

    if (provider === 'CLAUDE') {
      return this.findModeValue(availableModeValues, [
        'bypassPermissions',
        'dangerouslySkipPermissions',
        'dangerousSkipPermissions',
        'acceptEdits',
      ]);
    }

    return this.findModeValue(availableModeValues, ['default']);
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
      persistSnapshot: this.persistAcpConfigSnapshot.bind(this),
      emitDelta: this.sessionDomainService.emitDelta.bind(this.sessionDomainService),
    });
  }

  private findModeValue(
    availableModeValues: string[],
    preferredModeValues: string[]
  ): string | null {
    if (availableModeValues.length === 0 || preferredModeValues.length === 0) {
      return null;
    }

    const availableByNormalized = new Map<string, string>();
    for (const value of availableModeValues) {
      availableByNormalized.set(this.normalizeModeValue(value), value);
    }

    for (const preferredValue of preferredModeValues) {
      const match = availableByNormalized.get(this.normalizeModeValue(preferredValue));
      if (match) {
        return match;
      }
    }

    return null;
  }

  private normalizeModeValue(value: string): string {
    return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
  }
}
