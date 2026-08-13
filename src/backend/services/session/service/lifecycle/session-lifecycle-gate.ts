import type { SessionStartupLease } from './session-lifecycle.types';

type SessionLifecycleGateDependencies = {
  isRuntimeStopInProgress(sessionId: string): boolean;
};

export class SessionStartupCancelledError extends Error {
  constructor() {
    super('Session is currently being stopped');
    this.name = 'SessionStartupCancelledError';
  }
}

export class SessionLifecycleGate {
  private readonly stoppingSessions = new Set<string>();
  private readonly shutdownSessions = new Set<string>();
  private stopGenerationCounter = 0;
  private readonly stopGenerations = new Map<string, number>();
  private readonly startupGenerationReferences = new Map<number, number>();

  constructor(private readonly dependencies: SessionLifecycleGateDependencies) {}

  async runStartup<T>(
    sessionId: string,
    operation: (lease: SessionStartupLease) => Promise<T>
  ): Promise<T> {
    const lease = { sessionId, generation: this.getGeneration(sessionId) };
    this.startupGenerationReferences.set(
      lease.generation,
      (this.startupGenerationReferences.get(lease.generation) ?? 0) + 1
    );
    let succeeded = false;
    try {
      const result = await operation(lease);
      succeeded = true;
      return result;
    } finally {
      this.releaseStartupLease(lease, succeeded);
    }
  }

  assertStartupAllowed(lease: SessionStartupLease): void {
    if (
      this.isSessionStopping(lease.sessionId) ||
      !this.isGenerationCurrent(lease.sessionId, lease.generation)
    ) {
      throw new SessionStartupCancelledError();
    }
  }

  reserveStop(sessionId: string): { generation: number; release(): void } | null {
    if (this.stoppingSessions.has(sessionId)) {
      return null;
    }

    const generation = this.advanceGeneration(sessionId);
    this.stoppingSessions.add(sessionId);
    let released = false;
    return {
      generation,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.stoppingSessions.delete(sessionId);
        this.stopGenerations.delete(sessionId);
      },
    };
  }

  reserveShutdown(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      if (this.shutdownSessions.has(sessionId)) {
        continue;
      }
      this.advanceGeneration(sessionId);
      this.shutdownSessions.add(sessionId);
    }
  }

  releaseShutdown(sessionId: string): void {
    this.shutdownSessions.delete(sessionId);
    this.stopGenerations.delete(sessionId);
  }

  isSessionStopping(sessionId: string): boolean {
    return (
      this.stoppingSessions.has(sessionId) ||
      this.shutdownSessions.has(sessionId) ||
      this.dependencies.isRuntimeStopInProgress(sessionId)
    );
  }

  getGeneration(sessionId: string): number {
    return this.stopGenerations.get(sessionId) ?? this.advanceGeneration(sessionId);
  }

  isGenerationCurrent(sessionId: string, generation: number): boolean {
    return this.stopGenerations.get(sessionId) === generation;
  }

  private releaseStartupLease(lease: SessionStartupLease, succeeded: boolean): void {
    const referenceCount = this.startupGenerationReferences.get(lease.generation);
    if (referenceCount === undefined) {
      return;
    }
    if (referenceCount > 1) {
      this.startupGenerationReferences.set(lease.generation, referenceCount - 1);
      return;
    }

    this.startupGenerationReferences.delete(lease.generation);
    if (
      !(succeeded || this.isSessionStopping(lease.sessionId)) &&
      this.isGenerationCurrent(lease.sessionId, lease.generation)
    ) {
      this.stopGenerations.delete(lease.sessionId);
    }
  }

  private advanceGeneration(sessionId: string): number {
    this.stopGenerationCounter += 1;
    this.stopGenerations.set(sessionId, this.stopGenerationCounter);
    return this.stopGenerationCounter;
  }
}
