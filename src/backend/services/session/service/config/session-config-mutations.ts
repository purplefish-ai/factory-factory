import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { createLogger } from '@/backend/services/logger.service';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import {
  assertConfiguredAcpHandle,
  withConfiguredAcpHandle,
} from '@/backend/services/session/service/acp/acp-configured-handle';
import { resolveAcpModelSelection } from '@/backend/services/session/service/acp/acp-model-selection';
import { normalizeSessionConfigOptions } from '@/backend/services/session/service/acp/acp-session-config-options';
import type { SessionCallerGuard } from '@/backend/services/session/service/bridges';
import type { SessionRepository } from '@/backend/services/session/service/data/session.repository';
import type { QueuedMessage } from '@/shared/acp-protocol';
import { parseAcpConfigSnapshot } from './acp-config-snapshot';
import { SessionConfigMutationQueue } from './session-config-mutation-queue';
import { getConfigOptionValues, type SessionProvider } from './session-config-option-helpers';
import type { SessionConfigWriter } from './session-config-writer';
import type { SessionInactiveConfigOptions } from './session-inactive-config-options';
import { assertReadOnlyReviewConfigOption } from './session-permission-policy';
import { type AcceptedQueuedConfig, SessionQueuedSettings } from './session-queued-settings';
import { findCollaborationOption, resolveStartupModeTarget } from './session-startup-mode-preset';
import { configuredReasoningEffort } from './session-startup-reasoning';

const logger = createLogger('session');

/**
 * Live configuration edits: user and queued-message settings, observed native
 * updates, and stored edits for stopped sessions. Edits for one session are
 * serialized through the mutation queue.
 */
export class SessionConfigMutations {
  private readonly configUpdates: SessionConfigMutationQueue;
  private readonly queuedSettings: SessionQueuedSettings;

  constructor(
    private readonly runtimeManager: AcpRuntimeManager,
    private readonly repository: SessionRepository,
    private readonly writer: SessionConfigWriter,
    private readonly inactive: SessionInactiveConfigOptions,
    eventAuthority?: { assertOrdinary(sessionId: string): Promise<void> }
  ) {
    this.configUpdates = new SessionConfigMutationQueue(
      this.runtimeManager,
      (sessionId, configOptions) => this.writer.emitConfigOptions(sessionId, configOptions),
      eventAuthority?.assertOrdinary.bind(eventAuthority)
    );
    this.queuedSettings = new SessionQueuedSettings(this.runtimeManager, (sessionId, operation) =>
      this.configUpdates.run(sessionId, operation)
    );
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
      : this.writer.acceptRuntime(sessionId, handle);
    try {
      assertCurrent();
    } catch {
      return;
    }
    const normalizedConfigOptions = normalizeSessionConfigOptions(handle.provider, configOptions);
    handle.configOptions = normalizedConfigOptions;
    void this.writer
      .persistAcpConfigSnapshot(sessionId, {
        provider: handle.provider as SessionProvider,
        providerSessionId: handle.providerSessionId,
        configOptions: normalizedConfigOptions,
        assertCurrent,
      })
      .catch((error: unknown) => {
        logger.warn('Failed persisting native configuration update', { sessionId, error });
      });

    this.writer.emitConfigOptions(sessionId, normalizedConfigOptions);
    this.writer.emitCapabilities(
      sessionId,
      handle.provider as SessionProvider,
      handle.configOptions
    );
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
    guard?: SessionCallerGuard
  ): Promise<QueuedMessage['settings']> {
    return this.configUpdates.run(
      sessionId,
      () =>
        this.queuedSettings.configure(sessionId, message, {
          plan: () => this.setSessionCollaborationModeUnserialized(sessionId, 'plan', guard),
          model: (model) => this.setSessionModelUnserialized(sessionId, model, guard),
          reasoning: (effort) =>
            this.setSessionReasoningEffortUnserialized(sessionId, effort, guard),
        }),
      guard
    );
  }

  async setSessionModel(sessionId: string, model?: string, source?: 'user'): Promise<void> {
    await this.queuedSettings.capture(sessionId, source && model ? 'model' : undefined, () =>
      this.setSessionModelUnserialized(sessionId, model)
    )();
  }

  private async setSessionModelUnserialized(
    sessionId: string,
    model?: string,
    guard?: SessionCallerGuard
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
          target.value,
          guard
        );
      });
    }
    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const snapshot = parseAcpConfigSnapshot(session.providerMetadata);
    if (!snapshot) {
      return await this.setSessionConfigOptionUnserialized(sessionId, 'model', model, guard);
    }
    const target = resolveAcpModelSelection(session.provider, snapshot.configOptions, model);
    return await this.setSessionConfigOptionUnserialized(
      sessionId,
      target.configId,
      target.value,
      guard
    );
  }

  async setSessionCollaborationMode(sessionId: string, mode: 'plan'): Promise<void> {
    await this.configUpdates.run(sessionId, () =>
      this.setSessionCollaborationModeUnserialized(sessionId, mode)
    );
  }

  private async setSessionCollaborationModeUnserialized(
    sessionId: string,
    mode: 'plan',
    guard?: SessionCallerGuard
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

    await this.setSessionConfigOptionUnserialized(sessionId, modeOption.id, targetMode, guard);
  }

  async setSessionThinkingBudget(sessionId: string, maxTokens: number | null): Promise<void> {
    await this.queuedSettings.captureThinking(sessionId, maxTokens, () =>
      this.setSessionThinkingBudgetUnserialized(sessionId, maxTokens)
    )();
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
    await this.queuedSettings.capture(sessionId, source ? 'thought_level' : undefined, () =>
      this.setSessionReasoningEffortUnserialized(sessionId, reasoningEffort)
    )();
  }

  private async setSessionReasoningEffortUnserialized(
    sessionId: string,
    reasoningEffort: string | null,
    guard?: SessionCallerGuard
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
      this.writer.applyReasoningEffortTarget({
        sessionId,
        handle: acpHandle,
        targetReasoningEffort,
        source: requestedReasoningEffort ? 'message' : 'settings',
        assertCurrent: () => {
          guard?.assertCurrent?.();
          assertConfiguredAcpHandle(this.runtimeManager, sessionId, acpHandle);
        },
        guard,
      })
    );
  }

  async setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    await this.queuedSettings.capture(sessionId, configId, () =>
      this.setSessionConfigOptionUnserialized(sessionId, configId, value)
    )();
  }

  private async setSessionConfigOptionUnserialized(
    sessionId: string,
    configId: string,
    value: string,
    guard?: SessionCallerGuard
  ): Promise<AcceptedQueuedConfig | undefined> {
    const acpHandle = this.runtimeManager.getClient(sessionId);
    if (!acpHandle) {
      if (guard) {
        throw new Error('Retry runtime is unavailable');
      }
      return await this.updateInactiveSessionConfigOption(sessionId, configId, value);
    }

    while (acpHandle.configurationReady !== undefined) {
      await acpHandle.configurationReady;
    }
    assertConfiguredAcpHandle(this.runtimeManager, sessionId, acpHandle);
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

    await withConfiguredAcpHandle(
      this.runtimeManager,
      sessionId,
      acpHandle,
      () =>
        isModeOption
          ? this.runtimeManager.setSessionMode(sessionId, value)
          : isModelOption
            ? this.runtimeManager.setSessionModel(sessionId, value)
            : this.runtimeManager.setConfigOption(sessionId, configId, value),
      guard
    );
    if (guard) {
      await guard.check();
    }
    guard?.assertCurrent?.();

    assertConfiguredAcpHandle(this.runtimeManager, sessionId, acpHandle);
    const configOptions = structuredClone(acpHandle.configOptions);
    const accepted = this.writer.accept(sessionId, acpHandle, () => {
      guard?.assertCurrent?.();
      assertConfiguredAcpHandle(this.runtimeManager, sessionId, acpHandle);
    });
    if (
      !(await accepted.persist((assertCurrent) =>
        this.writer.snapshots.persist(sessionId, {
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
    this.writer.emitConfigOptions(sessionId, configOptions);
    return { provider: acpHandle.provider, configOptions };
  }

  private async updateInactiveSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<AcceptedQueuedConfig | undefined> {
    const update = await this.inactive.set(sessionId, configId, value);
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
    this.writer.emitConfigOptions(sessionId, configOptions);
    this.writer.emitCapabilities(sessionId, provider, configOptions);
    return update;
  }

  release(sessionId: string): void {
    this.queuedSettings.release(sessionId);
  }
}
