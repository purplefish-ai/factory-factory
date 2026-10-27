import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import type { AcpRuntimeManager } from '@/backend/services/session/service/acp';
import { parseAcpConfigSnapshot } from './acp-config-snapshot';
import type { CodexModelCatalogService } from './codex-model-catalog.service';
import {
  buildCodexConfigOptionsWithModelCatalog,
  getConfigOptionValues,
  type SessionProvider,
} from './session-config-option-helpers';
import { assertReadOnlyReviewConfigOption } from './session-permission-policy';
import type { SessionRepository } from './session.repository';

type InactiveConfigOptions = { provider: SessionProvider; configOptions: SessionConfigOption[] };
type InactiveConfigDependencies = {
  repository: SessionRepository;
  runtimeManager: Pick<AcpRuntimeManager, 'getClient' | 'getPendingClient'>;
  catalog: Pick<CodexModelCatalogService, 'getModels'>;
  persistSnapshot(
    sessionId: string,
    params: {
      provider: SessionProvider;
      providerSessionId: string;
      configOptions: SessionConfigOption[];
      existingMetadata?: unknown;
    }
  ): Promise<void>;
};

/** Null asks the caller to route the same edit through its newly installed live runtime. */
export async function setInactiveSessionConfigOption(
  sessionId: string,
  configId: string,
  value: string,
  deps: InactiveConfigDependencies
): Promise<InactiveConfigOptions | null> {
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
    await deps.persistSnapshot(sessionId, {
      provider: snapshot.provider,
      providerSessionId: snapshot.providerSessionId,
      configOptions,
      existingMetadata: session.providerMetadata,
    });
    return { provider: session.provider, configOptions };
  }
  if (session.provider !== 'CODEX' || configId !== 'model') {
    throw new Error(
      `Cannot set config option for inactive session ${sessionId}: no cached ACP config available`
    );
  }
  const models = await deps.catalog.getModels();
  await deps.runtimeManager.getPendingClient?.(sessionId);
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
  const assertInactive = () => {
    if (
      deps.runtimeManager.getClient(sessionId) ||
      deps.runtimeManager.getPendingClient?.(sessionId) !== undefined
    ) {
      throw new Error('Session runtime changed before model intent update');
    }
  };
  try {
    await deps.repository.updateSession(sessionId, { model: value }, assertInactive);
  } catch (error) {
    if (deps.runtimeManager.getClient(sessionId)) {
      return null;
    }
    throw error;
  }
  if (deps.runtimeManager.getClient(sessionId)) {
    return null;
  }
  // This is explicit intent, not observed native configuration: leave provider metadata untouched.
  return { provider: 'CODEX', configOptions };
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
