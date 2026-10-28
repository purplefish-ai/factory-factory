import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import type { AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { parseAcpConfigSnapshot } from './acp-config-snapshot';
import type { CodexModelCatalogService } from './codex-model-catalog.service';
import {
  buildCodexConfigOptionsWithModelCatalog,
  getConfigOptionValues,
  type SessionProvider,
} from './session-config-option-helpers';
import type { PersistAcpConfigSnapshotParams } from './session-config-snapshot-persistence';
import { pendingSessionLaunchSettingsPatch } from './session-launch-settings';
import { assertReadOnlyReviewConfigOption } from './session-permission-policy';
import type { SessionRepository } from './session.repository';

type InactiveConfigOptions = { provider: SessionProvider; configOptions: SessionConfigOption[] };
type InactiveConfigDependencies = {
  repository: SessionRepository;
  runtimeManager: Pick<AcpRuntimeManager, 'getClient' | 'getPendingClient'>;
  catalog: Pick<CodexModelCatalogService, 'getModels'>;
  persistSnapshot(sessionId: string, params: PersistAcpConfigSnapshotParams): Promise<void>;
};

/** Null asks the caller to route the same edit through its newly installed live runtime. */
export async function setInactiveSessionConfigOption(
  sessionId: string,
  configId: string,
  value: string,
  deps: InactiveConfigDependencies
): Promise<InactiveConfigOptions | null> {
  await settlePendingRuntime(sessionId, deps);
  const session = await deps.repository.getSessionById(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (deps.runtimeManager.getClient(sessionId)) {
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
    const persisted = await persistWhileInactive(sessionId, deps, (assertCurrent) =>
      deps.persistSnapshot(sessionId, {
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
      ? { provider: session.provider, configOptions }
      : await setInactiveSessionConfigOption(sessionId, configId, value, deps);
  }
  if (session.provider !== 'CODEX' || configId !== 'model') {
    throw new Error(
      `Cannot set config option for inactive session ${sessionId}: no cached ACP config available`
    );
  }
  const models = await deps.catalog.getModels();
  await settlePendingRuntime(sessionId, deps);
  const latest = await deps.repository.getSessionById(sessionId);
  if (deps.runtimeManager.getClient(sessionId)) {
    return null;
  }
  if (!latest) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (parseAcpConfigSnapshot(latest.providerMetadata)?.provider === latest.provider) {
    return await setInactiveSessionConfigOption(sessionId, configId, value, deps);
  }
  if (models.length === 0 || (value !== 'default' && !models.some((model) => model.id === value))) {
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
  if (
    !(await persistWhileInactive(sessionId, deps, (assertCurrent) =>
      deps.repository.updateSession(sessionId, { model: value }, assertCurrent)
    ))
  ) {
    return await setInactiveSessionConfigOption(sessionId, configId, value, deps);
  }
  // This is explicit intent, not observed native configuration: leave provider metadata untouched.
  return { provider: 'CODEX', configOptions };
}

async function settlePendingRuntime(
  sessionId: string,
  deps: InactiveConfigDependencies
): Promise<void> {
  await deps.runtimeManager.getPendingClient?.(sessionId)?.catch(() => undefined);
}

async function persistWhileInactive(
  sessionId: string,
  deps: InactiveConfigDependencies,
  operation: (assertCurrent: () => void) => Promise<unknown>
): Promise<boolean> {
  const hasRuntime = () =>
    Boolean(
      deps.runtimeManager.getClient(sessionId) ||
      deps.runtimeManager.getPendingClient?.(sessionId) !== undefined
    );
  const assertCurrent = () => {
    if (hasRuntime()) {
      throw new Error('Session runtime changed before inactive configuration update');
    }
  };
  try {
    assertCurrent();
    await operation(assertCurrent);
  } catch (error) {
    if (!hasRuntime()) {
      throw error;
    }
    return false;
  }
  return !hasRuntime();
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
