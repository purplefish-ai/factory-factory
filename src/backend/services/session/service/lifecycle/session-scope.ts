import { createLogger } from '@/backend/services/logger.service';

const logger = createLogger('session');

/** An explicit stop, or a runtime exit observed without one. */
export type SessionTeardownTrigger = 'stop' | 'exit';

/**
 * Per-session disposers for one stateful collaborator. Each hook drops state
 * the collaborator keeps for a session id; hooks must be synchronous,
 * idempotent and safe for sessions the collaborator has never seen.
 */
export interface SessionScopeParticipant {
  /** A stop or runtime exit has begun; drop per-turn bookkeeping first. */
  beginTeardown?(sessionId: string, trigger: SessionTeardownTrigger): void;
  /** Explicit stop only: flush and cancel live interaction before the runtime stops. */
  quiesce?(sessionId: string): void;
  /** The runtime is gone and orphaned tool calls are finalized. */
  settle?(sessionId: string, trigger: SessionTeardownTrigger): void;
  /** Explicit stop only, after finalization: reset coordination a stop can strand. */
  completeStop?(sessionId: string): void;
  /** The durable session record was deleted; drop everything retained across stops. */
  forget?(sessionId: string): void;
}

type SessionScopeStage = keyof SessionScopeParticipant;

/**
 * Lifetime owner for per-session in-memory state. Collaborators register
 * disposers once at composition; the termination and runtime-exit coordinators
 * run each stage instead of enumerating collaborators. Within a stage,
 * disposers run in registration order. A failing disposer is logged and does
 * not prevent the remaining disposers or the surrounding teardown.
 */
export class SessionScope {
  private readonly participants: Array<{ name: string; participant: SessionScopeParticipant }> = [];

  register(name: string, participant: SessionScopeParticipant): void {
    if (this.participants.some((entry) => entry.name === name)) {
      throw new Error(`Session scope participant already registered: ${name}`);
    }
    this.participants.push({ name, participant });
  }

  beginTeardown(sessionId: string, trigger: SessionTeardownTrigger): void {
    this.run('beginTeardown', sessionId, trigger);
  }

  quiesce(sessionId: string): void {
    this.run('quiesce', sessionId);
  }

  settle(sessionId: string, trigger: SessionTeardownTrigger): void {
    this.run('settle', sessionId, trigger);
  }

  completeStop(sessionId: string): void {
    this.run('completeStop', sessionId);
  }

  forget(sessionId: string): void {
    this.run('forget', sessionId);
  }

  private run(
    stage: SessionScopeStage,
    sessionId: string,
    trigger: SessionTeardownTrigger = 'stop'
  ): void {
    for (const { name, participant } of this.participants) {
      const dispose = participant[stage];
      if (!dispose) {
        continue;
      }
      try {
        dispose.call(participant, sessionId, trigger);
      } catch (error) {
        logger.warn('Session scope disposer failed', {
          sessionId,
          stage,
          participant: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/** Runtime collaborators that both stop and runtime exit tear down. */
export type SessionRuntimeScopeParticipants = {
  promptTurnCompletion: { clearSession(sessionId: string): void };
  queuedPrompts: { clearQueuedAcpPrompts(sessionId: string): void };
  acpEvents: {
    clearStreamingState(sessionId: string): void;
    clearReplaySuppression(sessionId: string): void;
    clearSessionState(sessionId: string): void;
  };
  permissions: { cancelPendingRequests(sessionId: string): void };
};

/**
 * Registers the runtime collaborators in the order the coordinators have always
 * torn them down. Shared by the composition root and lifecycle tests.
 */
export function registerSessionRuntimeParticipants(
  scope: SessionScope,
  participants: SessionRuntimeScopeParticipants
): void {
  scope.register('prompt-turn-completion', {
    beginTeardown: (id) => participants.promptTurnCompletion.clearSession(id),
  });
  scope.register('queued-acp-prompts', {
    beginTeardown: (id) => participants.queuedPrompts.clearQueuedAcpPrompts(id),
  });
  scope.register('acp-events', {
    quiesce: (id) => {
      participants.acpEvents.clearStreamingState(id);
      participants.acpEvents.clearReplaySuppression(id);
    },
    settle: (id) => participants.acpEvents.clearSessionState(id),
  });
  scope.register('permissions', {
    // A stop cancels before the runtime stops; an exit has no quiesce stage.
    quiesce: (id) => participants.permissions.cancelPendingRequests(id),
    settle: (id, trigger) => {
      if (trigger === 'exit') {
        participants.permissions.cancelPendingRequests(id);
      }
    },
  });
}
