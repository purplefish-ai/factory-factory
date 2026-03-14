import type { SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk';
import type { SessionPermissionPreset } from '@prisma-gen/client';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import {
  type AcpProcessHandle,
  type AcpRuntimeManager,
  fetchCodexModelCatalogFromAppServer,
} from '@/backend/services/session/service/acp';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { userSettingsAccessor } from '@/backend/services/settings';
import type { SessionDeltaEvent } from '@/shared/acp-protocol';
import { type ChatBarCapabilities, EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import type { SessionRepository } from './session.repository';

const logger = createLogger('session');
const CODEX_MODEL_CATALOG_CACHE_TTL_MS = 30_000;

type SessionProvider = 'CLAUDE' | 'CODEX';
type SessionStartupModePreset = 'non_interactive' | 'plan';
type CodexModelEntry = Awaited<ReturnType<typeof fetchCodexModelCatalogFromAppServer>>[number];
type CachedCodexModelCatalog = {
  fetchedAtMs: number;
  models: CodexModelEntry[];
};
type StoredAcpConfigSnapshot = {
  provider: SessionProvider;
  providerSessionId: string;
  capturedAt: string;
  configOptions: SessionConfigOption[];
  observedModelId?: string;
};

export type PersistAcpConfigSnapshotParams = {
  provider: SessionProvider;
  providerSessionId: string;
  configOptions: SessionConfigOption[];
  existingMetadata?: unknown;
};

export type SessionConfigServiceDependencies = {
  repository: SessionRepository;
  runtimeManager: AcpRuntimeManager;
  sessionDomainService?: SessionDomainService;
};

export class SessionConfigService {
  private readonly repository: SessionRepository;
  private readonly runtimeManager: AcpRuntimeManager;
  private readonly sessionDomainService: SessionDomainService;
  private cachedCodexModelCatalog: CachedCodexModelCatalog | null = null;
  private codexModelCatalogRequest: Promise<CodexModelEntry[] | null> | null = null;

  constructor(options: SessionConfigServiceDependencies) {
    this.repository = options.repository;
    this.runtimeManager = options.runtimeManager;
    this.sessionDomainService = options.sessionDomainService ?? sessionDomainService;
  }

  applyConfigOptionsUpdateDelta(
    sessionId: string,
    handle: AcpProcessHandle,
    configOptions: SessionConfigOption[]
  ): void {
    handle.configOptions = configOptions;
    void this.persistAcpConfigSnapshot(sessionId, {
      provider: handle.provider as SessionProvider,
      providerSessionId: handle.providerSessionId,
      configOptions: handle.configOptions,
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
    const executionResult = await this.applyStartupExecutionModePreset({
      sessionId,
      handle,
      startupModePreset,
      workflow,
      configOptions: modeResult.configOptions,
    });
    const didUpdate = modeResult.didUpdate || executionResult.didUpdate;

    if (!didUpdate) {
      return;
    }

    const persistSnapshot = options?.persistSnapshot ?? this.persistAcpConfigSnapshot.bind(this);
    handle.configOptions = executionResult.configOptions;
    try {
      await persistSnapshot(sessionId, {
        provider: handle.provider as SessionProvider,
        providerSessionId: handle.providerSessionId,
        configOptions: executionResult.configOptions,
      });

      this.sessionDomainService.emitDelta(sessionId, {
        type: 'config_options_update',
        configOptions: executionResult.configOptions,
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
    const executionModeOption = handle.configOptions.find(
      (option) => option.id === 'execution_mode' || option.category === 'permission'
    );
    if (!executionModeOption) {
      return;
    }

    const permissionPreset =
      preResolvedPreset ??
      (await this.resolvePermissionPresetFromSettings(sessionId, session.workflow));

    const targetExecutionMode = this.resolveConfiguredExecutionModeTarget(
      executionModeOption,
      permissionPreset
    );
    if (!targetExecutionMode) {
      return;
    }

    const currentExecutionMode = executionModeOption.currentValue
      ? String(executionModeOption.currentValue)
      : null;
    if (currentExecutionMode === targetExecutionMode) {
      return;
    }

    try {
      const configOptions = await this.runtimeManager.setConfigOption(
        sessionId,
        executionModeOption.id,
        targetExecutionMode
      );
      handle.configOptions = configOptions;
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
    } catch (error) {
      logger.warn('Failed applying configured session permission preset', {
        sessionId,
        workflow: session.workflow,
        permissionPreset,
        targetExecutionMode,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

    const cachedSnapshot = this.extractAcpConfigSnapshot(session.providerMetadata);
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
    const acpHandle = this.runtimeManager.getClient(sessionId);
    if (acpHandle) {
      const modelOption = acpHandle.configOptions.find((option) => option.category === 'model');
      if (modelOption && model) {
        const availableValues = this.getConfigOptionValues(modelOption);
        if (availableValues.length > 0 && !availableValues.includes(model)) {
          logger.debug('Skipping unsupported model for ACP session', {
            sessionId,
            provider: acpHandle.provider,
            model,
            availableValues,
          });
          return;
        }

        await this.setSessionConfigOption(sessionId, modelOption.id, model);
      }
      return;
    }

    logger.debug('No ACP handle for setSessionModel', { sessionId, model });
  }

  async setSessionThinkingBudget(sessionId: string, maxTokens: number | null): Promise<void> {
    const acpHandle = this.runtimeManager.getClient(sessionId);
    if (acpHandle) {
      const thoughtOption = acpHandle.configOptions.find(
        (option) => option.category === 'thought_level'
      );
      if (thoughtOption && maxTokens != null) {
        await this.setSessionConfigOption(sessionId, thoughtOption.id, String(maxTokens));
      }
      return;
    }

    logger.debug('No ACP handle for setSessionThinkingBudget', { sessionId, maxTokens });
  }

  async setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    const acpHandle = this.runtimeManager.getClient(sessionId);
    if (!acpHandle) {
      const configOptions = await this.setCachedSessionConfigOption(sessionId, configId, value);
      this.sessionDomainService.emitDelta(sessionId, {
        type: 'config_options_update',
        configOptions,
      } as SessionDeltaEvent);
      return;
    }

    const selectedOption = acpHandle.configOptions.find((option) => option.id === configId);
    const isModeOption = configId === 'mode' || selectedOption?.category === 'mode';
    const isModelOption = configId === 'model' || selectedOption?.category === 'model';

    const configOptions = isModeOption
      ? await this.runtimeManager.setSessionMode(sessionId, value)
      : isModelOption
        ? await this.runtimeManager.setSessionModel(sessionId, value)
        : await this.runtimeManager.setConfigOption(sessionId, configId, value);

    this.sessionDomainService.emitDelta(sessionId, {
      type: 'config_options_update',
      configOptions,
    } as SessionDeltaEvent);

    const acpHandleAfterUpdate = this.runtimeManager.getClient(sessionId);
    if (acpHandleAfterUpdate) {
      await this.persistAcpConfigSnapshot(sessionId, {
        provider: acpHandleAfterUpdate.provider as SessionProvider,
        providerSessionId: acpHandleAfterUpdate.providerSessionId,
        configOptions,
      });
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

    const cachedSnapshot = this.extractAcpConfigSnapshot(session.providerMetadata);
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
        return this.buildCapabilitiesFromConfigOptions(
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
      return this.buildCapabilitiesFromConfigOptions(
        session.provider,
        cachedSnapshot.configOptions,
        cachedSnapshot.observedModelId
      );
    }

    return EMPTY_CHAT_BAR_CAPABILITIES;
  }

  buildAcpChatBarCapabilities(handle: AcpProcessHandle): ChatBarCapabilities {
    return this.buildCapabilitiesFromConfigOptions(
      handle.provider as SessionProvider,
      handle.configOptions
    );
  }

  async persistAcpConfigSnapshot(
    sessionId: string,
    params: PersistAcpConfigSnapshotParams
  ): Promise<void> {
    if (params.configOptions.length === 0) {
      return;
    }

    const configOptionsForStorage = this.cloneConfigOptionsForStorage(params.configOptions);
    const observedModelId = this.resolveObservedModel(configOptionsForStorage);
    const metadataSource =
      params.existingMetadata ??
      (await this.repository.getSessionById(sessionId))?.providerMetadata ??
      null;

    const snapshot: StoredAcpConfigSnapshot = {
      provider: params.provider,
      providerSessionId: params.providerSessionId,
      capturedAt: new Date().toISOString(),
      configOptions: configOptionsForStorage,
      ...(observedModelId ? { observedModelId } : {}),
    };

    const persistedUpdate = this.buildSnapshotPersistUpdate(
      metadataSource,
      snapshot,
      observedModelId
    );

    try {
      await this.repository.updateSession(sessionId, persistedUpdate);
    } catch (error) {
      logger.warn('Failed persisting ACP config snapshot to session metadata; retrying once', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.retryPersistAcpConfigSnapshot(sessionId, snapshot, observedModelId);
    }
  }

  private async applyStartupCollaborationModePreset(params: {
    sessionId: string;
    handle: AcpProcessHandle;
    startupModePreset: SessionStartupModePreset;
    workflow: string;
    configOptions: SessionConfigOption[];
  }): Promise<{ configOptions: SessionConfigOption[]; didUpdate: boolean }> {
    const modeOption = params.configOptions.find((option) => option.category === 'mode');
    if (!modeOption) {
      return { configOptions: params.configOptions, didUpdate: false };
    }

    const availableModeValues = this.getConfigOptionValues(modeOption);
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
      const configOptions = await this.runtimeManager.setSessionMode(params.sessionId, targetMode);
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

  private async applyStartupExecutionModePreset(params: {
    sessionId: string;
    handle: AcpProcessHandle;
    startupModePreset: SessionStartupModePreset;
    workflow: string;
    configOptions: SessionConfigOption[];
  }): Promise<{ configOptions: SessionConfigOption[]; didUpdate: boolean }> {
    const executionModeOption = params.configOptions.find(
      (option) => option.id === 'execution_mode' || option.category === 'permission'
    );
    const targetExecutionMode = this.resolveStartupExecutionModeTarget(
      params.handle.provider as SessionProvider,
      params.workflow,
      params.startupModePreset,
      executionModeOption
    );
    if (!(executionModeOption && targetExecutionMode)) {
      return { configOptions: params.configOptions, didUpdate: false };
    }

    const currentExecutionMode = executionModeOption.currentValue
      ? String(executionModeOption.currentValue)
      : null;
    if (currentExecutionMode === targetExecutionMode) {
      return { configOptions: params.configOptions, didUpdate: false };
    }

    try {
      const configOptions = await this.runtimeManager.setConfigOption(
        params.sessionId,
        executionModeOption.id,
        targetExecutionMode
      );
      return { configOptions, didUpdate: true };
    } catch (error) {
      logger.warn('Failed applying startup execution-mode preset', {
        sessionId: params.sessionId,
        provider: params.handle.provider,
        workflow: params.workflow,
        startupModePreset: params.startupModePreset,
        targetExecutionMode,
        error: error instanceof Error ? error.message : String(error),
      });
      return { configOptions: params.configOptions, didUpdate: false };
    }
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

    return this.findModeValue(availableModeValues, [
      'fullAccess',
      'full_access',
      'full-access',
      'code',
    ]);
  }

  private resolveStartupExecutionModeTarget(
    provider: SessionProvider,
    workflow: string,
    startupModePreset: SessionStartupModePreset,
    executionModeOption: SessionConfigOption | undefined
  ): string | null {
    if (
      provider !== 'CODEX' ||
      workflow !== 'ratchet' ||
      startupModePreset !== 'non_interactive' ||
      !executionModeOption
    ) {
      return null;
    }

    const availableValues = this.getConfigOptionValues(executionModeOption);
    const yoloByValue = this.findModeValue(availableValues, ['["never","danger-full-access"]']);
    if (yoloByValue) {
      return yoloByValue;
    }

    const yoloByName = this.getSelectOptions(executionModeOption).find((option) =>
      /yolo/i.test(option.name ?? '')
    );
    return yoloByName?.value ?? null;
  }

  private async resolvePermissionPresetFromSettings(
    sessionId: string,
    workflow: string
  ): Promise<SessionPermissionPreset> {
    const fallback: SessionPermissionPreset = workflow === 'ratchet' ? 'YOLO' : 'STRICT';
    try {
      const settings = await userSettingsAccessor.get();
      return workflow === 'ratchet'
        ? settings.ratchetPermissions
        : settings.defaultWorkspacePermissions;
    } catch (error) {
      logger.warn('Failed loading user permission presets; using defaults', {
        sessionId,
        workflow,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }

  private resolveConfiguredExecutionModeTarget(
    executionModeOption: SessionConfigOption,
    permissionPreset: SessionPermissionPreset
  ): string | null {
    const availableValues = this.getConfigOptionValues(executionModeOption);
    const preferredValuesByPreset: Record<SessionPermissionPreset, string[]> = {
      STRICT: [
        '["on-request","workspace-write"]',
        '["on-request","read-only"]',
        '["on-request","danger-full-access"]',
      ],
      RELAXED: [
        '["on-failure","workspace-write"]',
        '["on-failure","read-only"]',
        '["on-failure","danger-full-access"]',
      ],
      YOLO: [
        '["never","danger-full-access"]',
        '["never","workspace-write"]',
        '["never","read-only"]',
      ],
    };
    const preferredValues = preferredValuesByPreset[permissionPreset];
    const byValue = this.findModeValue(availableValues, preferredValues);
    if (byValue) {
      return byValue;
    }

    const byName = this.getSelectOptions(executionModeOption).find((option) => {
      const name = option.name ?? '';
      if (permissionPreset === 'STRICT') {
        return /on request/i.test(name);
      }
      if (permissionPreset === 'RELAXED') {
        return /on failure/i.test(name);
      }
      return /yolo|never ask/i.test(name);
    });
    return byName?.value ?? null;
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

  private async setCachedSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<SessionConfigOption[]> {
    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const snapshot = this.extractAcpConfigSnapshot(session.providerMetadata);
    if (!snapshot || snapshot.provider !== session.provider) {
      throw new Error(
        `Cannot set config option for inactive session ${sessionId}: no cached ACP config available`
      );
    }

    const configOptions = this.updateCachedConfigOptions(snapshot.configOptions, configId, value);
    await this.persistAcpConfigSnapshot(sessionId, {
      provider: snapshot.provider,
      providerSessionId: snapshot.providerSessionId,
      configOptions,
      existingMetadata: session.providerMetadata,
    });
    return configOptions;
  }

  private updateCachedConfigOptions(
    configOptions: SessionConfigOption[],
    configId: string,
    value: string
  ): SessionConfigOption[] {
    let didUpdate = false;
    const nextConfigOptions = configOptions.map((option) => {
      if (option.id !== configId) {
        return option;
      }

      const allowedValues = this.getConfigOptionValues(option);
      if (allowedValues.length > 0 && !allowedValues.includes(value)) {
        throw new Error(
          `Unsupported value "${value}" for config option "${configId}"` +
            ` (allowed: ${allowedValues.join(', ')})`
        );
      }

      didUpdate = true;
      return {
        ...option,
        currentValue: value,
      };
    });

    if (!didUpdate) {
      throw new Error(`Unknown config option: ${configId}`);
    }

    return nextConfigOptions;
  }

  private async refreshCodexFallbackConfigOptionsFromAppServer(params: {
    sessionId: string;
    session: AgentSessionRecord;
    cachedSnapshot: StoredAcpConfigSnapshot | null;
    configOptions: SessionConfigOption[];
  }): Promise<SessionConfigOption[]> {
    const modelCatalog = await this.getCodexModelCatalogFromAppServer();
    if (!modelCatalog || modelCatalog.length === 0) {
      return params.configOptions;
    }

    const nextConfigOptions = this.buildCodexConfigOptionsWithModelCatalog(
      params.configOptions,
      modelCatalog,
      params.cachedSnapshot?.observedModelId ?? params.session.model
    );

    if (
      params.cachedSnapshot &&
      params.cachedSnapshot.provider === 'CODEX' &&
      JSON.stringify(params.cachedSnapshot.configOptions) !== JSON.stringify(nextConfigOptions)
    ) {
      await this.persistAcpConfigSnapshot(params.sessionId, {
        provider: 'CODEX',
        providerSessionId: params.cachedSnapshot.providerSessionId,
        configOptions: nextConfigOptions,
        existingMetadata: params.session.providerMetadata,
      });
    }

    return nextConfigOptions;
  }

  private buildCodexConfigOptionsWithModelCatalog(
    existingConfigOptions: SessionConfigOption[],
    modelCatalog: CodexModelEntry[],
    fallbackModel?: string
  ): SessionConfigOption[] {
    if (modelCatalog.length === 0) {
      return existingConfigOptions;
    }

    const nextConfigOptions = [...existingConfigOptions];
    const resolvedModelValue = this.upsertCodexModelOption(
      nextConfigOptions,
      modelCatalog,
      fallbackModel
    );
    if (!resolvedModelValue) {
      return existingConfigOptions;
    }

    this.upsertCodexReasoningOption(nextConfigOptions, modelCatalog, resolvedModelValue);
    return nextConfigOptions;
  }

  private upsertCodexModelOption(
    configOptions: SessionConfigOption[],
    modelCatalog: CodexModelEntry[],
    fallbackModel?: string
  ): string | null {
    const modelOptionIndex = configOptions.findIndex((option) => option.category === 'model');
    const existingModelOption =
      modelOptionIndex >= 0 ? (configOptions[modelOptionIndex] ?? null) : null;
    const currentModelValue =
      this.readConfigOptionCurrentValue(existingModelOption) ??
      this.toNonEmptyString(fallbackModel);
    const resolvedModelValue = this.resolveCodexModelValue(currentModelValue, modelCatalog);
    if (!resolvedModelValue) {
      return null;
    }

    const normalizedModelOption: SessionConfigOption = {
      id: existingModelOption?.id ?? 'model',
      category: 'model',
      name: existingModelOption?.name ?? 'Model',
      type: 'select',
      currentValue: resolvedModelValue,
      options: modelCatalog.map((model) => ({
        value: model.id,
        name: model.displayName,
        ...(model.description ? { description: model.description } : {}),
      })),
    };

    if (modelOptionIndex >= 0) {
      configOptions[modelOptionIndex] = normalizedModelOption;
    } else {
      configOptions.push(normalizedModelOption);
    }

    return resolvedModelValue;
  }

  private upsertCodexReasoningOption(
    configOptions: SessionConfigOption[],
    modelCatalog: CodexModelEntry[],
    selectedModelId: string
  ): void {
    const reasoningOptionIndex = this.findReasoningOptionIndex(configOptions);
    const existingReasoningOption =
      reasoningOptionIndex >= 0 ? (configOptions[reasoningOptionIndex] ?? null) : null;
    const selectedModel = modelCatalog.find((model) => model.id === selectedModelId);
    const reasoningCatalog = (selectedModel?.supportedReasoningEfforts ?? []).filter(
      (entry) => entry.reasoningEffort.trim().length > 0
    );

    if (reasoningCatalog.length === 0) {
      if (reasoningOptionIndex >= 0) {
        configOptions.splice(reasoningOptionIndex, 1);
      }
      return;
    }

    const reasoningSelectOptions = reasoningCatalog.map((entry) => ({
      value: entry.reasoningEffort,
      name: entry.reasoningEffort,
      ...(entry.description ? { description: entry.description } : {}),
    }));
    const resolvedReasoningValue =
      this.resolveCodexReasoningValue(
        this.readConfigOptionCurrentValue(existingReasoningOption),
        selectedModel?.defaultReasoningEffort,
        reasoningSelectOptions.map((entry) => entry.value)
      ) ?? reasoningSelectOptions[0]?.value;

    if (!resolvedReasoningValue) {
      if (reasoningOptionIndex >= 0) {
        configOptions.splice(reasoningOptionIndex, 1);
      }
      return;
    }

    const normalizedReasoningOption: SessionConfigOption = {
      id: existingReasoningOption?.id ?? 'reasoning_effort',
      category: existingReasoningOption?.category ?? 'thought_level',
      name: existingReasoningOption?.name ?? 'Reasoning Effort',
      type: 'select',
      currentValue: resolvedReasoningValue,
      options: reasoningSelectOptions,
    };

    if (reasoningOptionIndex >= 0) {
      configOptions[reasoningOptionIndex] = normalizedReasoningOption;
    } else {
      configOptions.push(normalizedReasoningOption);
    }
  }

  private findReasoningOptionIndex(configOptions: SessionConfigOption[]): number {
    return configOptions.findIndex(
      (option) =>
        option.id === 'reasoning_effort' ||
        option.category === 'thought_level' ||
        option.category === 'reasoning'
    );
  }

  private resolveCodexModelValue(
    currentModelValue: string | null,
    modelCatalog: CodexModelEntry[]
  ): string | null {
    if (currentModelValue && modelCatalog.some((model) => model.id === currentModelValue)) {
      return currentModelValue;
    }
    return modelCatalog.find((model) => model.isDefault)?.id ?? modelCatalog[0]?.id ?? null;
  }

  private resolveCodexReasoningValue(
    currentReasoningValue: string | null,
    defaultReasoningValue: string | undefined,
    reasoningValues: string[]
  ): string | null {
    const values = new Set(reasoningValues);
    if (currentReasoningValue && values.has(currentReasoningValue)) {
      return currentReasoningValue;
    }
    if (defaultReasoningValue && values.has(defaultReasoningValue)) {
      return defaultReasoningValue;
    }
    return reasoningValues[0] ?? null;
  }

  private readConfigOptionCurrentValue(option: SessionConfigOption | null): string | null {
    if (!option) {
      return null;
    }
    return this.toNonEmptyString(option.currentValue);
  }

  private toNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  }

  private async getCodexModelCatalogFromAppServer(): Promise<CodexModelEntry[] | null> {
    const now = Date.now();
    if (
      this.cachedCodexModelCatalog &&
      now - this.cachedCodexModelCatalog.fetchedAtMs < CODEX_MODEL_CATALOG_CACHE_TTL_MS
    ) {
      return this.cachedCodexModelCatalog.models;
    }

    if (this.codexModelCatalogRequest !== null) {
      return await this.codexModelCatalogRequest;
    }

    this.codexModelCatalogRequest = (async () => {
      try {
        const modelCatalog = await fetchCodexModelCatalogFromAppServer();
        this.cachedCodexModelCatalog = {
          fetchedAtMs: Date.now(),
          models: modelCatalog,
        };
        return modelCatalog;
      } catch (error) {
        logger.warn('Failed to refresh Codex model catalog from app-server fallback', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      } finally {
        this.codexModelCatalogRequest = null;
      }
    })();

    return await this.codexModelCatalogRequest;
  }

  private buildCapabilitiesFromConfigOptions(
    provider: SessionProvider,
    configOptions: SessionConfigOption[],
    fallbackModel?: string
  ): ChatBarCapabilities {
    const modelOption = configOptions.find((option) => option.category === 'model');
    const modeOption = configOptions.find((option) => option.category === 'mode');
    const thoughtOption = configOptions.find(
      (option) =>
        option.category === 'thought_level' ||
        option.id === 'reasoning_effort' ||
        option.category === 'reasoning'
    );
    const selectedModel = modelOption?.currentValue
      ? String(modelOption.currentValue)
      : (fallbackModel ?? undefined);
    const modelOptions = this.buildModelOptions(modelOption, selectedModel);
    const isCodexProvider = provider === 'CODEX';
    const reasoningOptions =
      isCodexProvider && thoughtOption
        ? this.getSelectOptions(thoughtOption).map((option) => ({
            value: option.value,
            label: option.name ?? option.value,
            ...(option.description ? { description: option.description } : {}),
          }))
        : [];
    const reasoningValues = new Set(reasoningOptions.map((option) => option.value));
    const selectedReasoning =
      isCodexProvider &&
      thoughtOption?.currentValue &&
      typeof thoughtOption.currentValue === 'string' &&
      reasoningValues.has(thoughtOption.currentValue)
        ? thoughtOption.currentValue
        : undefined;
    const modeDescriptors = modeOption
      ? [
          ...this.getConfigOptionValues(modeOption),
          ...this.getSelectOptions(modeOption)
            .map((entry) => entry.name ?? '')
            .filter((value) => value.trim().length > 0),
        ]
      : [];
    const planModeEnabled = modeDescriptors.some((entry) => /plan/i.test(entry));

    return {
      provider,
      model: {
        enabled: modelOptions.length > 0,
        options: modelOptions,
        ...(selectedModel ? { selected: selectedModel } : {}),
      },
      reasoning: {
        enabled: reasoningOptions.length > 0,
        options: reasoningOptions,
        ...(selectedReasoning ? { selected: selectedReasoning } : {}),
      },
      thinking: {
        enabled: !isCodexProvider && !!thoughtOption,
      },
      planMode: { enabled: planModeEnabled },
      attachments: isCodexProvider
        ? { enabled: false, kinds: [] }
        : { enabled: true, kinds: ['image', 'text'] },
      slashCommands: { enabled: false },
      usageStats: { enabled: false, contextWindow: false },
      rewind: { enabled: false },
    };
  }

  private buildModelOptions(
    modelOption: SessionConfigOption | undefined,
    selectedModel: string | undefined
  ): Array<{ value: string; label: string }> {
    if (!modelOption) {
      return selectedModel ? [{ value: selectedModel, label: selectedModel }] : [];
    }

    const byValue = new Map<string, string>();
    for (const option of this.getSelectOptions(modelOption)) {
      if (!byValue.has(option.value)) {
        byValue.set(option.value, option.name ?? option.value);
      }
    }
    if (selectedModel && !byValue.has(selectedModel)) {
      byValue.set(selectedModel, selectedModel);
    }

    return Array.from(byValue.entries()).map(([value, label]) => ({ value, label }));
  }

  private getSelectOptions(option: SessionConfigOption): SessionConfigSelectOption[] {
    return option.options.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        return [];
      }
      if ('value' in entry && typeof entry.value === 'string') {
        return [entry];
      }
      if ('options' in entry && Array.isArray(entry.options)) {
        return entry.options.filter(
          (grouped): grouped is SessionConfigSelectOption =>
            typeof grouped === 'object' && grouped !== null && typeof grouped.value === 'string'
        );
      }
      return [];
    });
  }

  private getConfigOptionValues(option: SessionConfigOption): string[] {
    return this.getSelectOptions(option).map((entry) => entry.value);
  }

  private buildSnapshotPersistUpdate(
    metadataSource: unknown,
    snapshot: StoredAcpConfigSnapshot,
    observedModelId: string | undefined
  ): {
    providerMetadata: AgentSessionRecord['providerMetadata'];
    model?: string;
  } {
    const nextMetadata: Record<string, unknown> = {
      ...this.toMetadataRecord(metadataSource),
      acpConfigSnapshot: snapshot,
    };
    if (observedModelId) {
      nextMetadata.observedModelId = observedModelId;
    }

    return {
      providerMetadata: nextMetadata as AgentSessionRecord['providerMetadata'],
      ...(observedModelId ? { model: observedModelId } : {}),
    };
  }

  private async retryPersistAcpConfigSnapshot(
    sessionId: string,
    snapshot: StoredAcpConfigSnapshot,
    observedModelId: string | undefined
  ): Promise<void> {
    try {
      const latestMetadataSource = (await this.repository.getSessionById(sessionId))
        ?.providerMetadata;
      await this.repository.updateSession(
        sessionId,
        this.buildSnapshotPersistUpdate(latestMetadataSource, snapshot, observedModelId)
      );
    } catch (retryError) {
      logger.warn('Retry failed persisting ACP config snapshot to session metadata', {
        sessionId,
        error: retryError instanceof Error ? retryError.message : String(retryError),
      });
    }
  }

  private cloneConfigOptionsForStorage(
    configOptions: SessionConfigOption[]
  ): SessionConfigOption[] {
    try {
      return structuredClone(configOptions);
    } catch {
      return configOptions;
    }
  }

  private toMetadataRecord(metadata: unknown): Record<string, unknown> {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      return {};
    }
    return { ...(metadata as Record<string, unknown>) };
  }

  private extractAcpConfigSnapshot(metadata: unknown): StoredAcpConfigSnapshot | null {
    const record = this.toMetadataRecord(metadata);
    const snapshot = record.acpConfigSnapshot;
    if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
      return null;
    }

    const candidate = snapshot as Record<string, unknown>;
    const provider = candidate.provider;
    const providerSessionId = candidate.providerSessionId;
    const configOptions = candidate.configOptions;
    const observedModelId = candidate.observedModelId;

    if (provider !== 'CLAUDE' && provider !== 'CODEX') {
      return null;
    }
    if (typeof providerSessionId !== 'string' || providerSessionId.length === 0) {
      return null;
    }
    if (!Array.isArray(configOptions)) {
      return null;
    }

    return {
      provider,
      providerSessionId,
      capturedAt:
        typeof candidate.capturedAt === 'string' ? candidate.capturedAt : new Date(0).toISOString(),
      configOptions: configOptions as SessionConfigOption[],
      ...(typeof observedModelId === 'string' ? { observedModelId } : {}),
    };
  }

  private resolveObservedModel(configOptions: SessionConfigOption[]): string | undefined {
    const modelOption = configOptions.find((option) => option.category === 'model');
    const currentValue = modelOption?.currentValue;
    return currentValue ? String(currentValue) : undefined;
  }
}
