import type { AcpRuntimePurpose } from './acp-runtime-events';

export type AcpClientCreationOperation = {
  isOnlyOperation(): boolean;
};

type CreationRecord = {
  barrier: Promise<void>;
  purpose: AcpRuntimePurpose;
};

export async function raceWithSoftTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<undefined>((resolve) => {
    timeout = setTimeout(() => resolve(undefined), timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export class AcpRuntimeQuiescence {
  private readonly creationRecords = new Map<string, Set<CreationRecord>>();
  private readonly quiescenceOperations = new Map<string, Promise<void>>();

  constructor(private readonly port: { stopClient(sessionId: string): Promise<void> }) {}

  runClientCreationOperation<T>(
    sessionId: string,
    purpose: AcpRuntimePurpose,
    operation: (registration: AcpClientCreationOperation) => Promise<T>
  ): Promise<T> {
    if (this.quiescenceOperations.has(sessionId)) {
      return Promise.reject(
        new Error(`ACP session stop requested; cannot create client ${sessionId}`)
      );
    }

    let releaseBarrier!: () => void;
    const record: CreationRecord = {
      barrier: new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      }),
      purpose,
    };
    const records = this.creationRecords.get(sessionId) ?? new Set<CreationRecord>();
    records.add(record);
    this.creationRecords.set(sessionId, records);

    let operationPromise: Promise<T>;
    try {
      operationPromise = operation({ isOnlyOperation: () => records.size === 1 });
    } catch (error) {
      operationPromise = Promise.reject(error);
    }
    return operationPromise.finally(() => {
      releaseBarrier();
      records.delete(record);
      if (records.size === 0) {
        this.creationRecords.delete(sessionId);
      }
    });
  }

  stopAndQuiesce(sessionId: string): Promise<void> {
    const existing = this.quiescenceOperations.get(sessionId);
    if (existing) {
      return existing;
    }

    let resolveOperation!: () => void;
    let rejectOperation!: (reason?: unknown) => void;
    const quiescenceOperation = new Promise<void>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    this.quiescenceOperations.set(sessionId, quiescenceOperation);
    const barriers = [...(this.creationRecords.get(sessionId) ?? [])].map(({ barrier }) => barrier);

    void this.runStopAndQuiesce(sessionId, barriers)
      .then(resolveOperation, rejectOperation)
      .finally(() => {
        if (this.quiescenceOperations.get(sessionId) === quiescenceOperation) {
          this.quiescenceOperations.delete(sessionId);
        }
      });
    return quiescenceOperation;
  }

  getTrackedSessionIds(): string[] {
    return [...this.creationRecords.keys()];
  }

  isBrowseOnlySession(sessionId: string): boolean {
    const records = this.creationRecords.get(sessionId);
    return (
      records !== undefined &&
      records.size > 0 &&
      [...records].every(({ purpose }) => purpose === 'browse')
    );
  }

  async waitForAll(): Promise<void> {
    await Promise.all(
      [...this.creationRecords.values()]
        .flatMap((records) => [...records])
        .map(({ barrier }) => barrier)
    );
  }

  private async runStopAndQuiesce(sessionId: string, barriers: Promise<void>[]): Promise<void> {
    let firstStopError: unknown;
    let firstStopRejected = false;
    try {
      await this.port.stopClient(sessionId);
    } catch (error) {
      firstStopRejected = true;
      firstStopError = error;
    }

    await Promise.all(barriers);
    if (barriers.length === 0) {
      if (firstStopRejected) {
        throw firstStopError;
      }
      return;
    }
    await this.port.stopClient(sessionId);
  }
}
