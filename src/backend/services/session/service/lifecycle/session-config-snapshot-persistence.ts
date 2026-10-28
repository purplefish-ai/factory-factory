import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { SessionLaunchSettings } from '@/shared/session-launch';
import type { StoredAcpConfigSnapshot } from './acp-config-snapshot';
import type { SessionProvider } from './session-config-option-helpers';
import { readSessionLaunchSettings } from './session-launch-settings';
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
};

/** Serialize every snapshot writer, including native events and the final startup commit. */
export class SessionConfigSnapshotPersistence {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(private readonly repository: SessionRepository) {}

  async persist(sessionId: string, params: PersistAcpConfigSnapshotParams): Promise<void> {
    const captured = { ...params, configOptions: cloneOptions(params.configOptions) };
    const previous = this.writes.get(sessionId) ?? Promise.resolve();
    const writing = previous.catch(() => undefined).then(() => this.write(sessionId, captured));
    this.writes.set(sessionId, writing);
    try {
      await writing;
    } finally {
      if (this.writes.get(sessionId) === writing) {
        this.writes.delete(sessionId);
      }
    }
  }

  private async write(sessionId: string, params: PersistAcpConfigSnapshotParams): Promise<void> {
    const snapshot = buildSnapshot(params);
    if (!snapshot) {
      return;
    }
    const consumedLaunch = readSessionLaunchSettings(params.existingMetadata);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.writeAttempt(sessionId, params, snapshot, consumedLaunch, attempt);
        return;
      } catch (error) {
        params.assertCurrent?.();
        logger.warn(
          attempt === 0
            ? 'Failed persisting ACP config snapshot to session metadata; retrying once'
            : 'Retry failed persisting ACP config snapshot to session metadata',
          { sessionId, error: error instanceof Error ? error.message : String(error) }
        );
        if (attempt === 1 && params.requirePersistence) {
          throw error;
        }
      }
    }
  }

  private async writeAttempt(
    sessionId: string,
    params: PersistAcpConfigSnapshotParams,
    snapshot: StoredAcpConfigSnapshot,
    consumedLaunch: ReturnType<typeof readSessionLaunchSettings>,
    attempt: number
  ): Promise<void> {
    const source =
      attempt === 0 && params.existingMetadata !== undefined
        ? params.existingMetadata
        : (await this.repository.getSessionById(sessionId))?.providerMetadata;
    const metadata = metadataRecord(source);
    // A retry refreshes other metadata but retains the final commit's consumed intent.
    if (consumedLaunch?.applied) {
      metadata.launchSettings = consumedLaunch;
    } else if (params.pendingLaunchSettingsPatch) {
      const latestLaunch = readSessionLaunchSettings(source);
      if (latestLaunch && !latestLaunch.applied) {
        metadata.launchSettings = { ...latestLaunch, ...params.pendingLaunchSettingsPatch };
      }
    }
    const update = snapshotUpdate(metadata, snapshot, snapshot.observedModelId);
    params.assertCurrent?.();
    await this.repository.updateSession(
      sessionId,
      update,
      ...(params.assertCurrent ? ([params.assertCurrent] as const) : [])
    );
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
