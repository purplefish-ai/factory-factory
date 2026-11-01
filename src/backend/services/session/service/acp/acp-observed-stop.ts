import type { ChildProcess } from 'node:child_process';
import type {
  ProviderSource,
  RuntimeStopEvidence,
} from '@/shared/acp-protocol/runtime-observation';
import { stopOwnedRuntimeGroup } from './acp-owned-group';
import type { AcpProcessHandle } from './acp-process-handle';
import type { AcpRuntimeMetadata } from './acp-runtime-contracts';
import type { AcpRuntimeQuiescence } from './acp-runtime-quiescence';

export class AcpObservedStop {
  private readonly spawnedGroups = new Map<
    string,
    { child: ChildProcess; ownedProcessGroup?: number; unsupportedProcessOverride: boolean }
  >();
  private readonly eventOwnedHandles = new Map<string, AcpProcessHandle>();
  private readonly observedStops = new Map<string, RuntimeStopEvidence>();
  private readonly strictStops = new Map<string, Promise<RuntimeStopEvidence>>();
  constructor(
    private readonly quiescence: AcpRuntimeQuiescence,
    private readonly port: {
      getHandle(id: string): AcpProcessHandle | undefined;
      getMetadata(handle: AcpProcessHandle): AcpRuntimeMetadata | undefined;
      beginStop(id: string): void;
      endStop(id: string): void;
      markManaged(child: ChildProcess): void;
      removeStopped(id: string, handle: AcpProcessHandle): void;
    }
  ) {}
  ids(): string[] {
    return [...new Set([...this.eventOwnedHandles.keys(), ...this.spawnedGroups.keys()])];
  }
  has(id: string): boolean {
    return this.eventOwnedHandles.has(id) || this.spawnedGroups.has(id);
  }
  registerSpawn(
    id: string,
    child: ChildProcess,
    group: number | undefined,
    unsupported: boolean
  ): () => Promise<RuntimeStopEvidence['status']> {
    this.spawnedGroups.set(id, {
      child,
      ownedProcessGroup: group,
      unsupportedProcessOverride: unsupported,
    });
    this.observedStops.delete(id);
    return async () => (await this.stopObservedRuntime(id, 'SYSTEM_STOP')).status;
  }
  register(id: string, handle: AcpProcessHandle, owned: boolean | undefined): void {
    if (owned) {
      this.spawnedGroups.delete(id);
      this.eventOwnedHandles.set(id, handle);
      this.observedStops.delete(id);
    }
  }
  async cleanupCandidate(id: string, handle: AcpProcessHandle): Promise<boolean> {
    if (this.eventOwnedHandles.get(id) !== handle) {
      return false;
    }
    const stop = await this.stopObservedRuntime(id, 'SYSTEM_STOP');
    if (stop.status !== 'LOCAL_RUNTIME_GROUP_STOPPED') {
      throw new Error('Event candidate cleanup is unconfirmed');
    }
    return true;
  }
  stopAndQuiesceObserved(
    sessionId: string,
    cause: RuntimeStopEvidence['cause'],
    expected?: ProviderSource
  ): Promise<RuntimeStopEvidence> {
    const existing = this.strictStops.get(sessionId);
    if (existing) {
      return existing;
    }
    const operation = this.quiescence
      .runObservedStop(sessionId, () => this.stopObservedRuntime(sessionId, cause, expected))
      .then(
        (results) =>
          results.find((result) => result.status === 'UNKNOWN') ??
          results[results.length - 1] ?? {
            version: 1 as const,
            cause,
            source: null,
            status: 'UNKNOWN' as const,
            observedAt: new Date().toISOString(),
          }
      )
      .finally(() => this.strictStops.delete(sessionId));
    this.strictStops.set(sessionId, operation);
    return operation;
  }

  async stopObservedRuntime(
    sessionId: string,
    cause: RuntimeStopEvidence['cause'],
    expected?: ProviderSource
  ): Promise<RuntimeStopEvidence> {
    this.port.beginStop(sessionId);
    const handle = this.eventOwnedHandles.get(sessionId) ?? this.port.getHandle(sessionId);
    const unknown: RuntimeStopEvidence = {
      version: 1,
      cause,
      source: null,
      status: 'UNKNOWN',
      observedAt: new Date().toISOString(),
    };
    try {
      if (!handle && this.spawnedGroups.has(sessionId)) {
        return await this.stopSpawn(sessionId, unknown);
      }
      if (!handle) {
        const previous = this.observedStops.get(sessionId);
        return previous &&
          (!expected || previous.source?.runtimeIncarnationId === expected.runtimeIncarnationId)
          ? { ...previous, cause }
          : unknown;
      }
      const metadata = this.port.getMetadata(handle);
      const source: ProviderSource | null =
        metadata && handle.eventLifecycleGeneration !== undefined
          ? {
              version: 1,
              provider: handle.provider,
              providerSessionId: handle.acpSessionId,
              runtimeIncarnationId: metadata.incarnationId,
              lifecycleGeneration: handle.eventLifecycleGeneration,
            }
          : null;
      this.port.markManaged(handle.child);
      attemptUnprovenDirectStop(handle);
      const status = await stopOwnedRuntimeGroup(handle, {
        assertOwned: () => {
          if (
            this.eventOwnedHandles.get(sessionId) !== handle ||
            (Boolean(this.port.getHandle(sessionId)) && this.port.getHandle(sessionId) !== handle)
          ) {
            throw new Error('Runtime ownership changed');
          }
        },
      });
      const evidence: RuntimeStopEvidence = {
        ...unknown,
        source,
        status: handle.unsupportedProcessOverride || !source ? 'UNKNOWN' : status,
        observedAt: new Date().toISOString(),
      };
      if (status === 'LOCAL_RUNTIME_GROUP_STOPPED') {
        this.port.removeStopped(sessionId, handle);
        this.eventOwnedHandles.delete(sessionId);
        this.observedStops.set(sessionId, evidence);
      }
      return evidence;
    } finally {
      this.port.endStop(sessionId);
    }
  }
  private async stopSpawn(
    sessionId: string,
    unknown: RuntimeStopEvidence
  ): Promise<RuntimeStopEvidence> {
    const spawn = this.spawnedGroups.get(sessionId);
    if (!spawn) {
      return unknown;
    }
    this.port.markManaged(spawn.child);
    attemptUnprovenDirectStop(spawn);
    const status = await stopOwnedRuntimeGroup(spawn, {
      assertOwned: () => {
        if (this.spawnedGroups.get(sessionId) !== spawn) {
          throw new Error('Spawn ownership changed');
        }
      },
    });
    const evidence = {
      ...unknown,
      status: spawn.unsupportedProcessOverride ? ('UNKNOWN' as const) : status,
      observedAt: new Date().toISOString(),
    };
    if (status === 'LOCAL_RUNTIME_GROUP_STOPPED') {
      this.spawnedGroups.delete(sessionId);
      this.observedStops.set(sessionId, evidence);
    }
    return evidence;
  }
}

function attemptUnprovenDirectStop(handle: {
  child: ChildProcess;
  ownedProcessGroup?: number;
}): void {
  if (!handle.ownedProcessGroup) {
    try {
      handle.child.kill('SIGTERM');
    } catch {
      /* Best effort only; never proof. */
    }
  }
}
