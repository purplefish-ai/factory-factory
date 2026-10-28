import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { withConfiguredAcpHandle } from '@/backend/services/session/service/acp/acp-configured-handle';
import { resolveAcpModelSelection } from '@/backend/services/session/service/acp/acp-model-selection';
import { normalizeSessionConfigOptions } from '@/backend/services/session/service/acp/acp-session-config-options';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { userSettingsService } from '@/backend/services/settings';
import type { SessionDeltaEvent } from '@/shared/acp-protocol';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import { type ChatBarCapabilities, EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import type { SessionPermissionPreset } from '@prisma-gen/client';
import { parseAcpConfigSnapshot, type StoredAcpConfigSnapshot } from './acp-config-snapshot';
import type { CodexModelCatalogService } from './codex-model-catalog.service';
import { SessionConfigCommitAuthority } from './session-config-commit-authority';
import { SessionConfigMutationQueue } from './session-config-mutation-queue';
import {
  buildCapabilitiesFromConfigOptions,
  buildCodexConfigOptionsWithModelCatalog,
  getConfigOptionValues,
  findModeValue,
  type SessionProvider,
} from './session-config-option-helpers';
import {
  SessionConfigSnapshotPersistence,
  type PersistAcpConfigSnapshotParams,
} from './session-config-snapshot-persistence';
export type { PersistAcpConfigSnapshotParams } from './session-config-snapshot-persistence';
import { setInactiveSessionConfigOption } from './session-inactive-config-options';
import {
  applyReadOnlyReviewPermissions,
  assertReadOnlyReviewConfigOption,
  resolveConfiguredAccessModeTarget,
  SessionStartupPermissions,
} from './session-permission-policy';
import { restoreSavedNativeModes } from './session-saved-native-modes';
import { getWorkflowPermissionPreset } from './session-workflow-permissions';
import type { SessionRepository } from './session.repository';

const logger = createLogger('session');

type SessionStartupModePreset = 'non_interactive' | 'plan';

export type SessionConfigServiceDependencies = {
  repository: SessionRepository;
  runtimeManager: AcpRuntimeManager;
  codexModelCatalogService: Pick<CodexModelCatalogService, 'getModels'>;
  sessionDomainService?: SessionDomainService;
};

export class SessionConfigService {
  private readonly startupPermissions = new SessionStartupPermissions();
  private readonly snapshotPersistence: SessionConfigSnapshotPersistence;
  private readonly configAuthority = new SessionConfigCommitAuthority();
  private readonly configUpdates: SessionConfigMutationQueue;
  private readonly repository: SessionRepository;
  private readonly runtimeManager: AcpRuntimeManager;
  private readonly sessionDomainService: SessionDomainService;
  private readonly codexModelCatalogService: Pick<CodexModelCatalogService, 'getModels'>;

  constructor(options: SessionConfigServiceDependencies) {
    this.repository = options.repository;
    this.snapshotPersistence = new SessionConfigSnapshotPersistence(
      options.repository,
      options.runtimeManager,
      this.configAuthority,
      (handle, metadata) => this.startupPermissions.assertCurrent(handle, metadata)
    );
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

  applyConfigOptionsUpdateDelta(
    sessionId: string,
    handle: AcpProcessHandle,
    configOptions: SessionConfigOption[]
  ): void {
    if (
      this.runtimeManager.getClient(sessionId) !== handle ||
      this.runtimeManager.isStopInProgress(sessionId)
    ) {
      return;
    }
    const normalizedConfigOptions = normalizeSessionConfigOptions(handle.provider, configOptions);
    handle.configOptions = normalizedConfigOptions;
    void this.persistAcpConfigSnapshot(sessionId, {
      provider: handle.provider as SessionProvider,
      providerSessionId: handle.providerSessionId,
      configOptions: normalizedConfigOptions,
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

    const didUpdate = await this.applyStartupCollaborationModePreset({
      sessionId,
      handle,
      startupModePreset,
      workflow,
    });

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
      this.startupPermissions.capture(handle, snapshot.configOptions);
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
    const liveConfigOptions = this.getSessionConfigOptions(sessionId);
    if (liveConfigOptions.length > 0) {
      return liveConfigOptions;
    }

    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      return [];
    }

    const cachedSnapshot = parseAcpConfigSnapshot(session.providerMetadata);
    const snapshotConfigOptions =
      cachedSnapshot && cachedSnapshot.provider === session.provider
        ? [...cachedSnapshot.configOptions]
        : [];

    if (session.provider === 'CODEX') {
      const refreshedCodexOptions = await this.refreshCodexFallbackConfigOptionsFromAppServer({
        sessionId,
        session,
        cachedSnapshot,
        configOptions: snapshotConfigOptions,
      });
      if (refreshedCodexOptions.length > 0) {
        return refreshedCodexOptions;
      }
    }

    if (snapshotConfigOptions.length > 0) {
      return snapshotConfigOptions;
    }

    return [];
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
      (await this.resolveConfiguredReasoningEffortFromSettings(
        sessionId,
        acpHandle.provider as SessionProvider
      ));
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
    }
  ): Promise<void> {
    const targetReasoningEffort = await this.resolveConfiguredReasoningEffortFromSettings(
      sessionId,
      handle.provider as SessionProvider
    );
    if (!targetReasoningEffort) {
      return;
    }

    await this.applyReasoningEffortTarget({
      sessionId,
      handle,
      targetReasoningEffort,
      source: 'settings',
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
      await this.updateInactiveSessionConfigOption(sessionId, configId, value);
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
  }

  private async updateInactiveSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<void> {
    const update = await setInactiveSessionConfigOption(sessionId, configId, value, {
      repository: this.repository,
      runtimeManager: this.runtimeManager,
      catalog: this.codexModelCatalogService,
      persistSnapshot: this.persistAcpConfigSnapshot.bind(this),
      accept: (assertCurrent) => this.configAuthority.accept(sessionId, assertCurrent),
    });
    if (!update) {
      await this.setSessionConfigOptionUnserialized(sessionId, configId, value);
      return;
    }
    if (
      this.runtimeManager.getClient(sessionId) ||
      this.runtimeManager.getPendingClient?.(sessionId) !== undefined
    ) {
      await this.setSessionConfigOptionUnserialized(sessionId, configId, value);
      return;
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
    return;
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
    const acpHandle = this.runtimeManager.getClient(sessionId);
    if (acpHandle) {
      return this.buildAcpChatBarCapabilities(acpHandle);
    }

    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      return EMPTY_CHAT_BAR_CAPABILITIES;
    }

    const cachedSnapshot = parseAcpConfigSnapshot(session.providerMetadata);
    if (session.provider === 'CODEX') {
      const snapshotConfigOptions =
        cachedSnapshot && cachedSnapshot.provider === 'CODEX'
          ? [...cachedSnapshot.configOptions]
          : [];
      const refreshedCodexOptions = await this.refreshCodexFallbackConfigOptionsFromAppServer({
        sessionId,
        session,
        cachedSnapshot,
        configOptions: snapshotConfigOptions,
      });

      if (refreshedCodexOptions.length > 0) {
        return buildCapabilitiesFromConfigOptions(
          'CODEX',
          refreshedCodexOptions,
          cachedSnapshot?.observedModelId ?? session.model
        );
      }

      return {
        ...EMPTY_CHAT_BAR_CAPABILITIES,
        provider: 'CODEX',
      };
    }

    if (cachedSnapshot && cachedSnapshot.provider === session.provider) {
      return buildCapabilitiesFromConfigOptions(
        session.provider,
        cachedSnapshot.configOptions,
        cachedSnapshot.observedModelId
      );
    }

    return EMPTY_CHAT_BAR_CAPABILITIES;
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
    await this.snapshotPersistence.persistCurrent(sessionId, params);
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

  private async applyStartupCollaborationModePreset(params: {
    sessionId: string;
    handle: AcpProcessHandle;
    startupModePreset: SessionStartupModePreset;
    workflow: string;
  }): Promise<boolean> {
    const modeOption = this.findCollaborationOption(
      params.handle.provider,
      params.handle.configOptions
    );
    if (!modeOption) {
      return false;
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
      return false;
    }

    const currentMode = modeOption.currentValue ? String(modeOption.currentValue) : null;
    if (currentMode === targetMode) {
      return false;
    }

    try {
      await (modeOption.id === 'mode'
        ? this.runtimeManager.setSessionMode(params.sessionId, targetMode)
        : this.runtimeManager.setConfigOption(params.sessionId, modeOption.id, targetMode));
      return true;
    } catch (error) {
      logger.warn('Failed applying startup mode preset', {
        sessionId: params.sessionId,
        provider: params.handle.provider,
        workflow: params.workflow,
        startupModePreset: params.startupModePreset,
        targetMode,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
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
      return findModeValue(availableModeValues, ['plan']);
    }

    if (provider === 'CLAUDE') {
      return findModeValue(availableModeValues, [
        'bypassPermissions',
        'dangerouslySkipPermissions',
        'dangerousSkipPermissions',
        'acceptEdits',
      ]);
    }

    return findModeValue(availableModeValues, ['default']);
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

  private async resolveConfiguredReasoningEffortFromSettings(
    sessionId: string,
    provider: SessionProvider
  ): Promise<string | null> {
    try {
      const settings = await userSettingsService.get();
      const value =
        provider === 'CLAUDE'
          ? settings.defaultClaudeReasoningEffort
          : settings.defaultCodexReasoningEffort;
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
    } catch (error) {
      logger.warn('Failed loading user reasoning-effort defaults; using provider default', {
        sessionId,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async applyReasoningEffortTarget(params: {
    sessionId: string;
    handle: AcpProcessHandle;
    targetReasoningEffort: string;
    source: 'message' | 'settings';
    persistSnapshot?: boolean;
    emitUpdates?: boolean;
    assertCurrent?: () => void;
  }): Promise<void> {
    const reasoningOption = params.handle.configOptions.find(
      (option) =>
        option.id === 'reasoning_effort' ||
        option.id === 'thought_level' ||
        option.category === 'thought_level' ||
        option.category === 'reasoning'
    );
    if (!reasoningOption) {
      logger.debug('Skipping reasoning-effort default because provider has no effort option', {
        sessionId: params.sessionId,
        provider: params.handle.provider,
        source: params.source,
      });
      return;
    }

    const availableValues = getConfigOptionValues(reasoningOption);
    if (availableValues.length > 0 && !availableValues.includes(params.targetReasoningEffort)) {
      logger.debug('Skipping unsupported reasoning effort for ACP session', {
        sessionId: params.sessionId,
        provider: params.handle.provider,
        reasoningEffort: params.targetReasoningEffort,
        availableValues,
        source: params.source,
      });
      return;
    }

    const currentReasoningEffort = reasoningOption.currentValue
      ? String(reasoningOption.currentValue)
      : null;
    if (currentReasoningEffort === params.targetReasoningEffort) {
      return;
    }

    await this.runtimeManager.setConfigOption(
      params.sessionId,
      reasoningOption.id,
      params.targetReasoningEffort
    );
    params.assertCurrent?.();
    const configOptions = structuredClone(params.handle.configOptions);
    const accepted = this.acceptConfiguration(
      params.sessionId,
      params.handle,
      params.assertCurrent
    );
    if (
      !(await accepted.persist(async (assertCurrent) => {
        if (params.persistSnapshot !== false) {
          await this.snapshotPersistence.persist(params.sessionId, {
            provider: params.handle.provider as SessionProvider,
            providerSessionId: params.handle.providerSessionId,
            configOptions,
            assertCurrent,
          });
        }
      }))
    ) {
      return;
    }
    if (!accepted.isCurrent()) {
      return;
    }
    if (params.emitUpdates !== false) {
      this.sessionDomainService.emitDelta(params.sessionId, {
        type: 'config_options_update',
        configOptions,
      } as SessionDeltaEvent);
      this.sessionDomainService.emitDelta(params.sessionId, {
        type: 'chat_capabilities',
        capabilities: this.buildAcpChatBarCapabilities(params.handle),
      });
    }
  }

  private async refreshCodexFallbackConfigOptionsFromAppServer(params: {
    sessionId: string;
    session: AgentSessionRecord;
    cachedSnapshot: StoredAcpConfigSnapshot | null;
    configOptions: SessionConfigOption[];
  }): Promise<SessionConfigOption[]> {
    const modelCatalog = await this.codexModelCatalogService.getModels().catch((error: unknown) => {
      logger.warn('Failed to refresh Codex model catalog from app-server fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    // Catalog reads only enrich display options. They never confirm or persist a model.
    const latest = await this.repository.getSessionById(params.sessionId);
    const liveOptions = this.getSessionConfigOptions(params.sessionId);
    if (liveOptions.length > 0) {
      return liveOptions;
    }
    const latestSnapshot = parseAcpConfigSnapshot(latest?.providerMetadata);
    const configOptions =
      latestSnapshot?.provider === 'CODEX' ? latestSnapshot.configOptions : params.configOptions;
    if (!modelCatalog || modelCatalog.length === 0) {
      return configOptions;
    }
    return buildCodexConfigOptionsWithModelCatalog(
      configOptions,
      modelCatalog,
      latest?.model ?? params.session.model
    );
  }
}
