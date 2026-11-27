import { createLogger } from '@/backend/services/logger.service';
import type { SessionStartupIntent } from '@/backend/services/session/service/data/session-startup-intent';
import { SessionStartupIntentChangedError } from '@/backend/services/session/service/data/session-startup-intent';
import type { SessionRepository } from '@/backend/services/session/service/data/session.repository';
import type { SessionConfigOption } from '@/shared/acp-protocol/sdk-types';
import type { SessionLaunchSettings } from '@/shared/session-launch';
import type { Prisma } from '@prisma-gen/client';
import type { StoredAcpConfigSnapshot } from './acp-config-snapshot';
import type { SessionProvider } from './session-config-option-helpers';
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

/** A superseded read can release its place before I/O returns. An issued write must settle. */
class SnapshotTurn {
  finish!: () => void;
  readonly completion = new Promise<void>((resolve) => {
    this.finish = resolve;
  });
  private reading = false;
  private revoked?: { reason: unknown };

  constructor(private readonly assertCurrent?: () => void) {}

  startRead(): void {
    this.assertAccepted();
    this.reading = true;
  }

  readonly beforeWrite = (): void => {
    this.assertAccepted();
    this.reading = false;
  };

  releaseObsoleteRead(): void {
    if (this.reading && this.assertCurrent) {
      try {
        this.assertCurrent();
      } catch (reason) {
        this.revoked = { reason };
        this.finish();
      }
    }
  }

  assertAccepted(): void {
    if (this.revoked) {
      throw this.revoked.reason;
    }
    this.assertCurrent?.();
  }
}

/** Persist an accepted snapshot with its original guard through metadata reads and CAS retries. */
export class SessionConfigSnapshotPersistence {
  private readonly turns = new Map<string, SnapshotTurn>();

  constructor(private readonly repository: SessionRepository) {}

  async persist(sessionId: string, params: PersistAcpConfigSnapshotParams): Promise<void> {
    params.assertCurrent?.();
    const snapshot = buildSnapshot({
      ...params,
      configOptions: cloneOptions(params.configOptions),
    });
    if (!snapshot) {
      return;
    }
    const previous = this.turns.get(sessionId);
    const turn = new SnapshotTurn(params.assertCurrent);
    this.turns.set(sessionId, turn);
    try {
      if (previous) {
        previous.releaseObsoleteRead();
        await previous.completion;
      }
      await this.write(sessionId, params, snapshot, turn);
    } finally {
      turn.finish();
      if (this.turns.get(sessionId) === turn) {
        this.turns.delete(sessionId);
      }
    }
  }

  private async write(
    sessionId: string,
    params: PersistAcpConfigSnapshotParams,
    snapshot: StoredAcpConfigSnapshot,
    turn: SnapshotTurn
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      turn.startRead();
      try {
        await this.writeAttempt(sessionId, params, snapshot, attempt, turn);
        return;
      } catch (error) {
        turn.assertAccepted();
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
    attempt: number,
    turn: SnapshotTurn
  ): Promise<void> {
    if (
      !(params.requirePersistence || params.startupIntent || params.pendingLaunchSettingsPatch) &&
      params.existingMetadata === undefined
    ) {
      await this.repository.reconcileConfigSnapshot(
        sessionId,
        snapshotUpdate({}, snapshot, snapshot.observedModelId),
        turn.beforeWrite
      );
      return;
    }
    const source =
      attempt === 0 && params.existingMetadata !== undefined
        ? params.existingMetadata
        : (await this.repository.getSessionById(sessionId))?.providerMetadata;
    const metadata = metadataRecord(source);
    const update = snapshotUpdate(metadata, snapshot, snapshot.observedModelId);
    turn.assertAccepted();
    const intent = params.startupIntent;
    if (intent) {
      await this.repository.acknowledgeStartupConfiguration(
        sessionId,
        update,
        intent,
        turn.beforeWrite
      );
    } else if (params.pendingLaunchSettingsPatch) {
      await this.repository.updatePendingLaunchConfiguration(
        sessionId,
        update,
        params.pendingLaunchSettingsPatch,
        turn.beforeWrite
      );
    } else {
      await this.repository.updateSession(sessionId, update, turn.beforeWrite);
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
): { providerMetadata: Prisma.JsonObject; model?: string } {
  return {
    providerMetadata: {
      ...metadata,
      acpConfigSnapshot: snapshot,
      ...(observedModelId ? { observedModelId } : {}),
    } as Prisma.JsonObject,
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
