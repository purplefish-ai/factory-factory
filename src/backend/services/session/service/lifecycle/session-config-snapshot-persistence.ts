import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { SessionLaunchSettings } from '@/shared/session-launch';
import type { StoredAcpConfigSnapshot } from './acp-config-snapshot';
import type { SessionProvider } from './session-config-option-helpers';
import type { SessionStartupIntent } from './session-startup-intent';
import { SessionStartupIntentChangedError } from './session-startup-intent';
import type { SessionRepository } from './session.repository';
const logger = createLogger('session');
export type PersistAcpConfigSnapshotParams = {
  provider: SessionProvider;
  providerSessionId: string;
  configOptions: SessionConfigOption[];
  existingMetadata?: unknown;
  pendingLaunchSettingsPatch?: SessionLaunchSettings;
  assertCurrent?: () => void;
  requirePersistence?: boolean;
  startupIntent?: SessionStartupIntent;
};

/** Persist an accepted snapshot with its original guard through metadata reads and CAS retries. */
export class SessionConfigSnapshotPersistence {
  constructor(private readonly repository: SessionRepository) {}

  async persist(sessionId: string, params: PersistAcpConfigSnapshotParams): Promise<void> {
    params.assertCurrent?.();
    await this.write(sessionId, { ...params, configOptions: cloneOptions(params.configOptions) });
  }

  private async write(sessionId: string, params: PersistAcpConfigSnapshotParams): Promise<void> {
    const snapshot = buildSnapshot(params);
    if (!snapshot) {
      return;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.writeAttempt(sessionId, params, snapshot, attempt);
        return;
      } catch (error) {
        params.assertCurrent?.();
        if (error instanceof SessionStartupIntentChangedError) {
          throw error;
        }
        logPersistenceFailure(sessionId, attempt, error);
        if (attempt === 1) {
          throw error;
        }
      }
    }
  }

  private async writeAttempt(
    sessionId: string,
    params: PersistAcpConfigSnapshotParams,
    snapshot: StoredAcpConfigSnapshot,
    attempt: number
  ): Promise<void> {
    const source =
      attempt === 0 && params.existingMetadata !== undefined
        ? params.existingMetadata
        : (await this.repository.getSessionById(sessionId))?.providerMetadata;
    const metadata = metadataRecord(source);
    const update = snapshotUpdate(metadata, snapshot, snapshot.observedModelId);
    params.assertCurrent?.();
    const intent = params.startupIntent;
    if (intent) {
      await this.repository.acknowledgeStartupConfiguration(
        sessionId,
        update,
        intent,
        params.assertCurrent
      );
    } else if (params.pendingLaunchSettingsPatch) {
      await this.repository.updatePendingLaunchConfiguration(
        sessionId,
        update,
        params.pendingLaunchSettingsPatch,
        params.assertCurrent
      );
    } else {
      await this.repository.updateSession(sessionId, update, params.assertCurrent);
    }
  }
}
function buildSnapshot(
  params: PersistAcpConfigSnapshotParams
): StoredAcpConfigSnapshot | undefined {
  if (params.configOptions.length === 0) {
    if (params.requirePersistence) {
      throw new Error('Cannot finalize startup without native configuration');
    }
    return undefined;
  }
  const currentModel = params.configOptions.find(
    (option) => option.category === 'model'
  )?.currentValue;
  const observedModelId = currentModel ? String(currentModel) : undefined;
  return {
    provider: params.provider,
    providerSessionId: params.providerSessionId,
    capturedAt: new Date().toISOString(),
    configOptions: params.configOptions,
    ...(observedModelId ? { observedModelId } : {}),
  };
}

function snapshotUpdate(
  metadata: Record<string, unknown>,
  snapshot: StoredAcpConfigSnapshot,
  observedModelId: string | undefined
): { providerMetadata: AgentSessionRecord['providerMetadata']; model?: string } {
  return {
    providerMetadata: {
      ...metadata,
      acpConfigSnapshot: snapshot,
      ...(observedModelId ? { observedModelId } : {}),
    } as AgentSessionRecord['providerMetadata'],
    ...(observedModelId ? { model: observedModelId } : {}),
  };
}
function cloneOptions(options: SessionConfigOption[]): SessionConfigOption[] {
  try {
    return structuredClone(options);
  } catch {
    return options;
  }
}
function metadataRecord(metadata: unknown): Record<string, unknown> {
  return typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
}

function logPersistenceFailure(sessionId: string, attempt: number, error: unknown): void {
  logger.warn(
    attempt === 0
      ? 'Failed persisting ACP config snapshot to session metadata; retrying once'
      : 'Retry failed persisting ACP config snapshot to session metadata',
    {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    }
  );
}
