import { EventEmitter } from 'node:events';
import {
  createInitialSessionRuntimeState,
  type SessionRuntimePhase,
  type SessionRuntimeState,
} from '@/shared/session-runtime';

export type SessionRuntimeEvent =
  | {
      type: 'session_runtime_snapshot';
      sessionId: string;
      data: {
        sessionRuntime: SessionRuntimeState;
      };
    }
  | {
      type: 'session_runtime_updated';
      sessionId: string;
      data: {
        sessionRuntime: SessionRuntimeState;
      };
    };

interface RuntimeUpdateInput {
  phase?: SessionRuntimePhase;
  processState?: SessionRuntimeState['processState'];
  activity?: SessionRuntimeState['activity'];
  lastExit?: SessionRuntimeState['lastExit'];
}

class SessionRuntimeStoreService {
  private runtimes = new Map<string, SessionRuntimeState>();
  private emitter = new EventEmitter();

  onEvent(listener: (event: SessionRuntimeEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }

  hasEventListener(listener: (event: SessionRuntimeEvent) => void): boolean {
    return this.emitter.listeners('event').includes(listener);
  }

  getRuntime(sessionId: string): SessionRuntimeState {
    const existing = this.runtimes.get(sessionId);
    if (existing) {
      return existing;
    }
    const initial = createInitialSessionRuntimeState();
    this.runtimes.set(sessionId, initial);
    return initial;
  }

  emitSnapshot(sessionId: string): void {
    const sessionRuntime = this.getRuntime(sessionId);
    this.emitter.emit('event', {
      type: 'session_runtime_snapshot',
      sessionId,
      data: { sessionRuntime },
    } satisfies SessionRuntimeEvent);
  }

  markLoading(sessionId: string): SessionRuntimeState {
    return this.updateRuntime(sessionId, {
      phase: 'loading',
      activity: 'IDLE',
    });
  }

  markStarting(sessionId: string): SessionRuntimeState {
    return this.updateRuntime(sessionId, {
      phase: 'starting',
      processState: 'alive',
      activity: 'IDLE',
    });
  }

  markRunning(sessionId: string): SessionRuntimeState {
    return this.updateRuntime(sessionId, {
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
    });
  }

  markIdle(sessionId: string, processState: SessionRuntimeState['processState'] = 'alive') {
    return this.updateRuntime(sessionId, {
      phase: 'idle',
      processState,
      activity: 'IDLE',
    });
  }

  markStopping(sessionId: string): SessionRuntimeState {
    return this.updateRuntime(sessionId, {
      phase: 'stopping',
      activity: 'IDLE',
    });
  }

  markError(sessionId: string): SessionRuntimeState {
    return this.updateRuntime(sessionId, {
      phase: 'error',
      activity: 'IDLE',
    });
  }

  syncFromClient(
    sessionId: string,
    clientState: { isRunning: boolean; isWorking: boolean }
  ): SessionRuntimeState {
    const phase: SessionRuntimePhase = clientState.isWorking ? 'running' : 'idle';
    const processState: SessionRuntimeState['processState'] = clientState.isRunning
      ? 'alive'
      : 'stopped';
    const activity: SessionRuntimeState['activity'] = clientState.isWorking ? 'WORKING' : 'IDLE';

    return this.updateRuntime(sessionId, { phase, processState, activity });
  }

  markProcessExit(sessionId: string, code: number | null): SessionRuntimeState {
    const unexpected = code !== null && code !== 0;
    return this.updateRuntime(sessionId, {
      phase: unexpected ? 'error' : 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      lastExit: {
        code,
        timestamp: new Date().toISOString(),
        unexpected,
      },
    });
  }

  clearSession(sessionId: string): void {
    this.runtimes.delete(sessionId);
  }

  clearAllSessions(): void {
    this.runtimes.clear();
    this.emitter.removeAllListeners('event');
  }

  private updateRuntime(sessionId: string, input: RuntimeUpdateInput): SessionRuntimeState {
    const previous = this.getRuntime(sessionId);
    const next: SessionRuntimeState = {
      ...previous,
      ...input,
      updatedAt: new Date().toISOString(),
    };
    this.runtimes.set(sessionId, next);
    this.emitter.emit('event', {
      type: 'session_runtime_updated',
      sessionId,
      data: { sessionRuntime: next },
    } satisfies SessionRuntimeEvent);
    return next;
  }
}

export const sessionRuntimeStoreService = new SessionRuntimeStoreService();
