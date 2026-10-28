import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '../../resources/agent-session.accessor';
import type { StoredAcpConfigSnapshot } from './acp-config-snapshot';
import type { SessionProvider } from './session-config-option-helpers';
import type { SessionRepository } from './session.repository';

const logger = createLogger('session');

export type PersistAcpConfigSnapshotParams = {
  provider: SessionProvider;
  providerSessionId: string;
  configOptions: SessionConfigOption[];
  existingMetadata?: unknown;
  assertCurrent?: () => void;
};

/** Keep the accepted authority closure unchanged across metadata reads and CAS retries. */
export class SessionConfigSnapshotPersistence {
  constructor(private readonly repository: SessionRepository) {}

  async persist(sessionId: string, params: PersistAcpConfigSnapshotParams): Promise<void> {
    params.assertCurrent?.();
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

    params.assertCurrent?.();
    try {
      await this.repository.updateSession(
        sessionId,
        persistedUpdate,
        ...(params.assertCurrent ? ([params.assertCurrent] as const) : [])
      );
    } catch (error) {
      params.assertCurrent?.();
      logger.warn('Failed persisting ACP config snapshot to session metadata; retrying once', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.retryPersistAcpConfigSnapshot(sessionId, snapshot, params.assertCurrent);
    }
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
    assertCurrent?: () => void
  ): Promise<void> {
    try {
      const latestMetadataSource = (await this.repository.getSessionById(sessionId))
        ?.providerMetadata;
      assertCurrent?.();
      await this.repository.updateSession(
        sessionId,
        this.buildSnapshotPersistUpdate(latestMetadataSource, snapshot, snapshot.observedModelId),
        ...(assertCurrent ? ([assertCurrent] as const) : [])
      );
    } catch (retryError) {
      assertCurrent?.();
      logger.warn('Retry failed persisting ACP config snapshot to session metadata', {
        sessionId,
        error: retryError instanceof Error ? retryError.message : String(retryError),
      });
      throw retryError;
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

  private resolveObservedModel(configOptions: SessionConfigOption[]): string | undefined {
    const modelOption = configOptions.find((option) => option.category === 'model');
    const currentValue = modelOption?.currentValue;
    return currentValue ? String(currentValue) : undefined;
  }
}
