import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import type { AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { pendingSessionLaunchSettingsPatch } from '@/backend/services/session/service/data/session-launch-settings';
import type { SessionRepository } from '@/backend/services/session/service/data/session.repository';
import type { CodexModelCatalogService } from '@/backend/services/session/service/providers/codex-model-catalog.service';
import { NATIVE_DEFAULT_CODEX_ACCOUNT_ID } from '@/shared/codex-accounts';
import { parseAcpConfigSnapshot } from './acp-config-snapshot';
import type { AcceptedConfigCommit } from './session-config-commit-authority';
import {
  buildCodexConfigOptionsWithModelCatalog,
  getConfigOptionValues,
  type SessionProvider,
} from './session-config-option-helpers';
import type { SessionConfigWriter } from './session-config-writer';
import { assertReadOnlyReviewConfigOption } from './session-permission-policy';

type InactiveConfigOptions = {
  provider: SessionProvider;
  configOptions: SessionConfigOption[];
  accepted: AcceptedConfigCommit;
};

/** Edits the stored configuration of a session with no live or pending runtime. */
export class SessionInactiveConfigOptions {
  constructor(
    private readonly repository: SessionRepository,
    private readonly runtimeManager: Pick<AcpRuntimeManager, 'getClient' | 'getPendingClient'>,
    private readonly catalog: Pick<CodexModelCatalogService, 'getModels'>,
    private readonly writer: SessionConfigWriter
  ) {}

  /** Null asks the caller to route the same edit through its newly installed live runtime. */
  async set(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<InactiveConfigOptions | null> {
    await this.settlePendingRuntime(sessionId);
    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (this.runtimeManager.getClient(sessionId)) {
      return null;
    }
    const snapshot = parseAcpConfigSnapshot(session.providerMetadata);
    if (snapshot?.provider === session.provider) {
      assertReadOnlyReviewConfigOption(
        session.workflow,
        configId,
        value,
        snapshot.configOptions.find((option) => option.id === configId),
        session.provider
      );
      const configOptions = updateCachedConfigOptions(snapshot.configOptions, configId, value);
      const persisted = await this.persistWhileInactive(sessionId, (assertCurrent) =>
        this.writer.persistAcpConfigSnapshot(sessionId, {
          provider: snapshot.provider,
          providerSessionId: snapshot.providerSessionId,
          configOptions,
          existingMetadata: session.providerMetadata,
          requirePersistence: true,
          pendingLaunchSettingsPatch: pendingSessionLaunchSettingsPatch(
            session.providerMetadata,
            session.provider,
            snapshot.configOptions.find((option) => option.id === configId),
            value
          ),
          assertCurrent,
        })
      );
      return persisted
        ? { provider: session.provider, configOptions, accepted: persisted }
        : await this.set(sessionId, configId, value);
    }
    if (session.provider !== 'CODEX' || configId !== 'model') {
      throw new Error(
        `Cannot set config option for inactive session ${sessionId}: no cached ACP config available`
      );
    }
    const models = await this.catalog.getModels(
      session.codexAccountId ?? NATIVE_DEFAULT_CODEX_ACCOUNT_ID
    );
    await this.settlePendingRuntime(sessionId);
    const latest = await this.repository.getSessionById(sessionId);
    if (this.runtimeManager.getClient(sessionId)) {
      return null;
    }
    if (!latest) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (parseAcpConfigSnapshot(latest.providerMetadata)?.provider === latest.provider) {
      return await this.set(sessionId, configId, value);
    }
    if (
      models.length === 0 ||
      (value !== 'default' && !models.some((model) => model.id === value))
    ) {
      throw new Error(`Unsupported model "${value}" for CODEX`);
    }
    const configOptions = buildCodexConfigOptionsWithModelCatalog([], models, value);
    assertReadOnlyReviewConfigOption(
      latest.workflow,
      configId,
      value,
      configOptions.find((option) => option.id === configId),
      latest.provider
    );
    const accepted = await this.persistWhileInactive(sessionId, (assertCurrent) =>
      this.repository.updateSession(sessionId, { model: value }, assertCurrent)
    );
    if (!accepted) {
      return await this.set(sessionId, configId, value);
    }
    // This is explicit intent, not observed native configuration: leave provider metadata untouched.
    return { provider: 'CODEX', configOptions, accepted };
  }

  private async settlePendingRuntime(sessionId: string): Promise<void> {
    await this.runtimeManager.getPendingClient?.(sessionId)?.catch(() => undefined);
  }

  private async persistWhileInactive(
    sessionId: string,
    operation: (assertCurrent: () => void) => Promise<unknown>
  ): Promise<AcceptedConfigCommit | null> {
    const hasRuntime = () =>
      Boolean(
        this.runtimeManager.getClient(sessionId) ||
        this.runtimeManager.getPendingClient?.(sessionId) !== undefined
      );
    const assertCurrent = () => {
      if (hasRuntime()) {
        throw new Error('Session runtime changed before inactive configuration update');
      }
    };
    let accepted: AcceptedConfigCommit;
    try {
      assertCurrent();
      accepted = this.writer.authority.accept(sessionId, assertCurrent);
      if (
        !(await accepted.persist(async (guard) => {
          await operation(guard);
        }))
      ) {
        return null;
      }
    } catch (error) {
      if (!hasRuntime()) {
        throw error;
      }
      return null;
    }
    return hasRuntime() ? null : accepted;
  }
}

function updateCachedConfigOptions(
  configOptions: SessionConfigOption[],
  configId: string,
  value: string
): SessionConfigOption[] {
  if (!configOptions.some((option) => option.id === configId)) {
    throw new Error(`Unknown config option: ${configId}`);
  }
  return configOptions.map((option) => {
    if (option.id !== configId) {
      return option;
    }
    if (option.type !== 'select') {
      throw new Error(
        `Cannot set config option "${configId}" on an inactive session: unsupported type "${option.type}"`
      );
    }
    const allowedValues = getConfigOptionValues(option);
    if (allowedValues.length > 0 && !allowedValues.includes(value)) {
      throw new Error(
        `Unsupported value "${value}" for config option "${configId}"` +
          ` (allowed: ${allowedValues.join(', ')})`
      );
    }
    return { ...option, currentValue: value };
  });
}
