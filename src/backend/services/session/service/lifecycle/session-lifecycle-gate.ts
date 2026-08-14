import type { SessionStartupLease } from './session-lifecycle.types';

type SessionLifecycleGateDependencies = {
  isRuntimeStopInProgress(sessionId: string): boolean;
};

type StartupGenerationReferences = {
  count: number;
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
  private readonly startupGenerationReferences = new Map<number, StartupGenerationReferences>();
  private readonly establishedGenerations = new Set<number>();

  constructor(private readonly dependencies: SessionLifecycleGateDependencies) {}

  async runStartup<T>(
    sessionId: string,
    operation: (lease: SessionStartupLease) => Promise<T>
  ): Promise<T> {
    const lease = { sessionId, generation: this.getGeneration(sessionId) };
    const currentReferences = this.startupGenerationReferences.get(lease.generation);
    this.startupGenerationReferences.set(lease.generation, {
      count: (currentReferences?.count ?? 0) + 1,
    });
    try {
      return await operation(lease);
    } finally {
      this.releaseStartupLease(lease);
    }
  }

  establishStartup(lease: SessionStartupLease): void {
    if (this.isGenerationCurrent(lease.sessionId, lease.generation)) {
      this.establishedGenerations.add(lease.generation);
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
    if (this.stoppingSessions.has(sessionId) || this.shutdownSessions.has(sessionId)) {
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
        this.deleteGeneration(sessionId);
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
    this.deleteGeneration(sessionId);
  }

  isSessionStopping(sessionId: string): boolean {
    return (
      this.stoppingSessions.has(sessionId) ||
      this.shutdownSessions.has(sessionId) ||
      this.dependencies.isRuntimeStopInProgress(sessionId)
    );
  }

  isStopReserved(sessionId: string): boolean {
    return this.stoppingSessions.has(sessionId);
  }

  getGeneration(sessionId: string): number {
    return this.stopGenerations.get(sessionId) ?? this.advanceGeneration(sessionId);
  }

  isGenerationCurrent(sessionId: string, generation: number): boolean {
    return this.stopGenerations.get(sessionId) === generation;
  }

  private releaseStartupLease(lease: SessionStartupLease): void {
    const references = this.startupGenerationReferences.get(lease.generation);
    if (!references) {
      return;
    }
    if (references.count > 1) {
      this.startupGenerationReferences.set(lease.generation, {
        count: references.count - 1,
      });
      return;
    }

    this.startupGenerationReferences.delete(lease.generation);
    if (
      !(
        this.establishedGenerations.has(lease.generation) || this.isSessionStopping(lease.sessionId)
      ) &&
      this.isGenerationCurrent(lease.sessionId, lease.generation)
    ) {
      this.deleteGeneration(lease.sessionId);
    }
  }

  private advanceGeneration(sessionId: string): number {
    this.deleteGeneration(sessionId);
    this.stopGenerationCounter += 1;
    this.stopGenerations.set(sessionId, this.stopGenerationCounter);
    return this.stopGenerationCounter;
  }

  private deleteGeneration(sessionId: string): void {
    const generation = this.stopGenerations.get(sessionId);
    if (generation === undefined) {
      return;
    }
    this.stopGenerations.delete(sessionId);
    this.establishedGenerations.delete(generation);
  }
}
