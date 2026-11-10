import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { createLogger } from '@/backend/services/logger.service';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { isReasoningConfigOption } from '@/backend/services/session/service/acp/acp-config-option-identification';
import type { SessionCallerGuard } from '@/backend/services/session/service/bridges';
import type { SessionRepository } from '@/backend/services/session/service/data/session.repository';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import {
  type AcceptedConfigCommit,
  SessionConfigCommitAuthority,
} from './session-config-commit-authority';
import {
  buildCapabilitiesFromConfigOptions,
  getConfigOptionValues,
  type SessionProvider,
} from './session-config-option-helpers';
import {
  SessionConfigSnapshotPersistence,
  type PersistAcpConfigSnapshotParams,
} from './session-config-snapshot-persistence';

const logger = createLogger('session');

export type ReasoningEffortTargetParams = {
  guard?: SessionCallerGuard;
  sessionId: string;
  handle: AcpProcessHandle;
  targetReasoningEffort: string;
  source: 'message' | 'settings';
  strict?: boolean;
  normalizeUnsupported?: boolean;
  persistSnapshot?: boolean;
  emitUpdates?: boolean;
  assertCurrent?: () => void;
  confirmTarget?: (id: string, value: string) => void;
};

/**
 * Commits native configuration writes: accepts them against the current
 * runtime and newer commits, persists the snapshot, and publishes the result.
 * Live edits and startup application both write through this owner.
 */
export class SessionConfigWriter {
  readonly authority = new SessionConfigCommitAuthority();
  readonly snapshots: SessionConfigSnapshotPersistence;

  constructor(
    private readonly runtimeManager: AcpRuntimeManager,
    repository: SessionRepository,
    private readonly sessionDomainService: SessionDomainService
  ) {
    this.snapshots = new SessionConfigSnapshotPersistence(repository);
  }

  acceptRuntime(sessionId: string, handle?: AcpProcessHandle): () => void {
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

  accept(
    sessionId: string,
    handle?: AcpProcessHandle,
    assertCurrent?: () => void
  ): AcceptedConfigCommit {
    return this.authority.accept(sessionId, assertCurrent ?? this.acceptRuntime(sessionId, handle));
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
    const accepted = this.accept(sessionId, handle, params.assertCurrent);
    await accepted.persist((assertCurrent) =>
      this.snapshots.persist(sessionId, { ...params, configOptions, assertCurrent })
    );
  }

  /** Persists the handle's current options, then publishes them while still accepted. */
  async persistAndEmit(sessionId: string, handle: AcpProcessHandle): Promise<void> {
    const configOptions = structuredClone(handle.configOptions);
    const accepted = this.accept(sessionId, handle);
    if (
      !(await accepted.persist((assertCurrent) =>
        this.snapshots.persist(sessionId, {
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
    this.emitConfigOptions(sessionId, configOptions);
    this.emitCapabilities(sessionId, handle.provider as SessionProvider, handle.configOptions);
  }

  emitConfigOptions(sessionId: string, configOptions: SessionConfigOption[]): void {
    this.sessionDomainService.emitDelta(sessionId, {
      type: 'config_options_update',
      configOptions,
    });
  }

  emitCapabilities(
    sessionId: string,
    provider: SessionProvider,
    configOptions: SessionConfigOption[]
  ): void {
    this.sessionDomainService.emitDelta(sessionId, {
      type: 'chat_capabilities',
      capabilities: buildCapabilitiesFromConfigOptions(provider, configOptions),
    });
  }

  async applyReasoningEffortTarget(params: ReasoningEffortTargetParams): Promise<void> {
    if (params.guard) {
      await params.guard.check();
    }
    params.guard?.assertCurrent?.();
    params.assertCurrent?.();
    const reasoningOption = supportedReasoningOption(params);
    if (!reasoningOption) {
      return;
    }
    const currentReasoningEffort = reasoningOption.currentValue
      ? String(reasoningOption.currentValue)
      : null;
    const alreadyConfirmed = currentReasoningEffort === params.targetReasoningEffort;
    if (!alreadyConfirmed) {
      await this.runtimeManager.setConfigOption(
        params.sessionId,
        reasoningOption.id,
        params.targetReasoningEffort
      );
    }
    if (params.guard) {
      await params.guard.check();
    }
    params.guard?.assertCurrent?.();
    params.assertCurrent?.();
    const configOptions = structuredClone(params.handle.configOptions);
    if (
      params.strict &&
      configOptions.find((option) => option.id === reasoningOption.id)?.currentValue !==
        params.targetReasoningEffort
    ) {
      throw new Error('Requested reasoning effort was not applied');
    }
    params.confirmTarget?.(reasoningOption.id, params.targetReasoningEffort);
    const accepted = this.accept(params.sessionId, params.handle, params.assertCurrent);
    const persisted = await accepted.persist(async (assertCurrent) => {
      if (params.persistSnapshot !== false) {
        await this.persistAcpConfigSnapshot(params.sessionId, {
          provider: params.handle.provider as SessionProvider,
          providerSessionId: params.handle.providerSessionId,
          configOptions,
          assertCurrent,
        });
      }
    });
    if (!(persisted && accepted.isCurrent())) {
      return;
    }
    if (params.emitUpdates !== false) {
      this.emitConfigOptions(params.sessionId, configOptions);
      this.emitCapabilities(
        params.sessionId,
        params.handle.provider as SessionProvider,
        params.handle.configOptions
      );
    }
  }

  release(sessionId: string): void {
    this.authority.release(sessionId);
  }
}

function supportedReasoningOption(
  params: ReasoningEffortTargetParams
): SessionConfigOption | undefined {
  const reasoningOption = params.handle.configOptions.find(isReasoningConfigOption);
  if (!reasoningOption) {
    if (params.strict && !params.normalizeUnsupported) {
      throw new Error('Unsupported reasoning effort: selected model has no thinking control');
    }
    logger.debug('Skipping reasoning-effort default because provider has no effort option', {
      sessionId: params.sessionId,
      provider: params.handle.provider,
      source: params.source,
    });
    return undefined;
  }

  const availableValues = getConfigOptionValues(reasoningOption);
  if (
    (params.strict || availableValues.length > 0) &&
    !availableValues.includes(params.targetReasoningEffort)
  ) {
    if (params.strict && !params.normalizeUnsupported) {
      throw new Error(`Unsupported reasoning effort: ${params.targetReasoningEffort}`);
    }
    logger.debug('Skipping unsupported reasoning effort for ACP session', {
      sessionId: params.sessionId,
      provider: params.handle.provider,
      reasoningEffort: params.targetReasoningEffort,
      availableValues,
      source: params.source,
    });
    return undefined;
  }

  return reasoningOption;
}
