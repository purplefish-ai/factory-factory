import { join } from 'node:path';
import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { configService } from '@/backend/services/config.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import type { SessionCallerGuard } from '@/backend/services/session/service/bridges';
import { fetchAccountSessionLaunchOptions } from '@/backend/services/session/service/config/launch-options/session-launch-options-provider';
import { LaunchOptionsStore } from '@/backend/services/session/service/config/launch-options/session-launch-options-store';
import { SessionLaunchOptionsService } from '@/backend/services/session/service/config/launch-options/session-launch-options.service';
import type { SessionRepository } from '@/backend/services/session/service/data/session.repository';
import type { CodexModelCatalogService } from '@/backend/services/session/service/providers/codex-model-catalog.service';
import {
  sessionDomainService as defaultSessionDomainService,
  type SessionDomainService,
} from '@/backend/services/session/service/store/session-domain.service';
import { userSettingsService } from '@/backend/services/settings';
import type { QueuedMessage } from '@/shared/acp-protocol';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import type { SessionLaunchOptions } from '@/shared/session-launch';
import type { SessionPermissionPreset } from '@prisma-gen/client';
import { SessionConfigMutations } from './session-config-mutations';
import type { SessionProvider } from './session-config-option-helpers';
import {
  SessionConfigReader,
  type ResolvedSessionConfigProjection,
} from './session-config-projection';
import type { PersistAcpConfigSnapshotParams } from './session-config-snapshot-persistence';
import { SessionConfigWriter } from './session-config-writer';
import { SessionInactiveConfigOptions } from './session-inactive-config-options';
import { SessionStartupConfiguration } from './session-startup-configuration';
import type { CompleteStartupConfigurationParams } from './session-startup-configuration-finalizer';

export type { PersistAcpConfigSnapshotParams } from './session-config-snapshot-persistence';

export type SessionConfigServiceDependencies = {
  eventAuthority?: { assertOrdinary(sessionId: string): Promise<void> };
  repository: SessionRepository;
  runtimeManager: AcpRuntimeManager;
  codexModelCatalogService: Pick<CodexModelCatalogService, 'getModels'>;
  sessionDomainService?: SessionDomainService;
  launchOptionsService?: Pick<SessionLaunchOptionsService, 'getOptions'> &
    Partial<Pick<SessionLaunchOptionsService, 'warm' | 'stop'>>;
};

type SessionStartupModePreset = 'non_interactive' | 'plan';

/**
 * Session configuration API. Each responsibility has one owner:
 * `writer` accepts, persists and publishes native configuration writes;
 * `reader` projects live or stored configuration; `startup` applies launch
 * configuration to a new runtime; `mutations` applies live and stopped edits.
 */
export class SessionConfigService {
  readonly writer: SessionConfigWriter;
  readonly reader: SessionConfigReader;
  readonly startup: SessionStartupConfiguration;
  readonly mutations: SessionConfigMutations;

  private readonly stopOptions: () => Promise<void>;

  stopLaunchOptions(): Promise<void> {
    return this.stopOptions();
  }

  private readonly warmOptions: () => Promise<void>;

  warmLaunchOptions(): Promise<void> {
    return this.warmOptions();
  }

  constructor(options: SessionConfigServiceDependencies) {
    const { repository, runtimeManager, codexModelCatalogService } = options;
    const launchOptionsService =
      options.launchOptionsService ??
      new SessionLaunchOptionsService({
        fetchOptions: fetchAccountSessionLaunchOptions,
        store: new LaunchOptionsStore(
          join(configService.getBaseDir(), 'cache', 'session-launch-options.json')
        ),
        getSettings: () => userSettingsService.get(),
      });
    this.stopOptions = () => launchOptionsService.stop?.() ?? Promise.resolve();
    this.warmOptions = () => launchOptionsService.warm?.() ?? Promise.resolve();
    this.writer = new SessionConfigWriter(
      runtimeManager,
      repository,
      options.sessionDomainService ?? defaultSessionDomainService
    );
    this.reader = new SessionConfigReader(
      runtimeManager,
      repository,
      codexModelCatalogService,
      launchOptionsService
    );
    this.startup = new SessionStartupConfiguration(runtimeManager, repository, this.writer);
    this.mutations = new SessionConfigMutations(
      runtimeManager,
      repository,
      this.writer,
      new SessionInactiveConfigOptions(
        repository,
        runtimeManager,
        codexModelCatalogService,
        this.writer
      ),
      options.eventAuthority
    );
  }

  // Startup application

  requireSavedStartupAccess(handle: AcpProcessHandle, metadata: unknown): void {
    this.startup.requireSavedStartupAccess(handle, metadata);
  }

  applyStartupModel(sessionId: string, handle: AcpProcessHandle, model: string): Promise<void> {
    return this.startup.applyStartupModel(sessionId, handle, model);
  }

  applyStartupLaunchPlan(
    sessionId: string,
    session: AgentSessionRecord,
    handle: AcpProcessHandle,
    preset: SessionPermissionPreset | undefined,
    override?: boolean
  ): Promise<void> {
    return this.startup.applyStartupLaunchPlan(sessionId, session, handle, preset, override);
  }

  applyStartupModePreset(
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
    return this.startup.applyStartupModePreset(
      sessionId,
      handle,
      startupModePreset,
      workflow,
      options
    );
  }

  applyConfiguredPermissionPreset(
    sessionId: string,
    session: AgentSessionRecord,
    handle: AcpProcessHandle,
    preResolvedPreset?: SessionPermissionPreset
  ): Promise<void> {
    return this.startup.applyConfiguredPermissionPreset(
      sessionId,
      session,
      handle,
      preResolvedPreset
    );
  }

  applyConfiguredReasoningEffort(
    sessionId: string,
    handle: AcpProcessHandle,
    options?: {
      persistSnapshot?: boolean;
      emitUpdates?: boolean;
      session?: AgentSessionRecord;
      reasoningEffort?: string | null;
    }
  ): Promise<void> {
    return this.startup.applyConfiguredReasoningEffort(sessionId, handle, options);
  }

  completeStartupConfiguration(
    sessionId: string,
    params: CompleteStartupConfigurationParams
  ): Promise<void> {
    return this.startup.completeStartupConfiguration(sessionId, params);
  }

  // Read projection

  getLaunchOptions(input: {
    provider: SessionProvider;
    model?: string;
    codexAccountId?: string;
  }): Promise<SessionLaunchOptions> {
    return this.reader.getLaunchOptions(input);
  }

  getSessionConfigOptions(sessionId: string): SessionConfigOption[] {
    return this.reader.getSessionConfigOptions(sessionId);
  }

  getSessionConfigOptionsWithFallback(sessionId: string): Promise<SessionConfigOption[]> {
    return this.reader.getSessionConfigOptionsWithFallback(sessionId);
  }

  getSessionConfigProjection(sessionId: string): Promise<ResolvedSessionConfigProjection> {
    return this.reader.getSessionConfigProjection(sessionId);
  }

  getChatBarCapabilities(sessionId: string): Promise<ChatBarCapabilities> {
    return this.reader.getChatBarCapabilities(sessionId);
  }

  buildAcpChatBarCapabilities(handle: AcpProcessHandle): ChatBarCapabilities {
    return this.reader.buildAcpChatBarCapabilities(handle);
  }

  // Live mutations

  applyConfigOptionsUpdateDelta(
    sessionId: string,
    handle: AcpProcessHandle,
    configOptions: SessionConfigOption[],
    isCurrentSource?: () => boolean
  ): void {
    this.mutations.applyConfigOptionsUpdateDelta(sessionId, handle, configOptions, isCurrentSource);
  }

  resolveQueuedMessageSettings(
    sessionId: string,
    message: Pick<QueuedMessage, 'timestamp' | 'settings'>
  ): QueuedMessage['settings'] {
    return this.mutations.resolveQueuedMessageSettings(sessionId, message);
  }

  configureQueuedMessage(
    sessionId: string,
    message: Pick<QueuedMessage, 'timestamp' | 'settings'>,
    guard?: SessionCallerGuard
  ): Promise<QueuedMessage['settings']> {
    return this.mutations.configureQueuedMessage(sessionId, message, guard);
  }

  setSessionModel(sessionId: string, model?: string, source?: 'user'): Promise<void> {
    return this.mutations.setSessionModel(sessionId, model, source);
  }

  setSessionCollaborationMode(sessionId: string, mode: 'plan'): Promise<void> {
    return this.mutations.setSessionCollaborationMode(sessionId, mode);
  }

  setSessionThinkingBudget(sessionId: string, maxTokens: number | null): Promise<void> {
    return this.mutations.setSessionThinkingBudget(sessionId, maxTokens);
  }

  setSessionReasoningEffort(
    sessionId: string,
    reasoningEffort: string | null,
    source?: 'user'
  ): Promise<void> {
    return this.mutations.setSessionReasoningEffort(sessionId, reasoningEffort, source);
  }

  setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    return this.mutations.setSessionConfigOption(sessionId, configId, value);
  }

  // Commits

  persistAcpConfigSnapshot(
    sessionId: string,
    params: PersistAcpConfigSnapshotParams
  ): Promise<void> {
    return this.writer.persistAcpConfigSnapshot(sessionId, params);
  }

  releaseSessionConfiguration(sessionId: string): void {
    this.writer.release(sessionId);
    this.mutations.release(sessionId);
  }
}
