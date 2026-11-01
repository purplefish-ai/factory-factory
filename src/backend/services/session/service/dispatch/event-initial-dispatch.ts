import { withEventEvidenceDeadline } from '@/backend/services/session/service/lifecycle/event-evidence-deadline';
import type {
  EventInitialPermit,
  EventSessionAuthority,
} from '@/backend/services/session/service/lifecycle/event-session-authority';
import type { QueuedMessage } from '@/shared/acp-protocol';
import type { InitialAttempt } from '@/shared/event-agent-delivery';
import type { RuntimeStopEvidence } from '@/shared/event-agent-delivery';

export class EventInitialDispatchInterrupted extends Error {
  constructor(readonly cleanup: 'CONFIRMED' | 'UNKNOWN') {
    super('Event initial dispatch interrupted');
  }
}

/** Dedicated singleton dispatch: ordinary queue/settings never participate in this turn. */
export class EventInitialDispatcher {
  constructor(
    private readonly ports: {
      authority: EventSessionAuthority;
      start(sessionId: string, permit: EventInitialPermit): Promise<unknown>;
      send(sessionId: string, text: string, permit: EventInitialPermit): Promise<void>;
      commit(sessionId: string, message: QueuedMessage): void;
      interrupt?(sessionId: string, cause: 'SHUTDOWN' | 'TIMEOUT'): Promise<RuntimeStopEvidence>;
    }
  ) {}
  async dispatch(input: {
    attempt: InitialAttempt;
    text: string;
    assertCurrent(): void;
    signal?: AbortSignal;
  }): Promise<void> {
    if (!input.text.trim()) {
      return Promise.reject(new Error('Initial prompt is empty'));
    }
    let closed = false;
    const check = () => {
      if (closed) {
        throw new Error('Event operation closed');
      }
      input.signal?.throwIfAborted();
      input.assertCurrent();
    };
    const operation = this.ports.authority.runInitial(
      input.attempt,
      async (permit) => {
        const { sessionId, messageId } = permit.attempt;
        await this.ports.start(sessionId, permit);
        this.ports.authority.assertCurrent(permit);
        // This is a local transcript projection, never provider acceptance evidence.
        this.ports.commit(sessionId, {
          id: messageId,
          text: input.text,
          timestamp: new Date().toISOString(),
          settings: {
            selectedModel: permit.execution.model,
            reasoningEffort: permit.execution.reasoningEffort,
            thinkingEnabled: false,
            planModeEnabled: false,
          },
        });
        await this.ports.send(sessionId, input.text, permit);
      },
      check
    );
    if (!input.signal) {
      return operation;
    }
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('Event operation aborted'));
    });
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) {
      abort();
    }
    try {
      await Promise.race([operation, cancelled]);
    } catch (error) {
      if (!input.signal.aborted) {
        throw error;
      }
      const evidence = await this.ports
        .interrupt?.(input.attempt.sessionId, 'SHUTDOWN')
        .catch(() => null);
      await withEventEvidenceDeadline(
        operation.catch(() => undefined),
        () => {
          closed = true;
        }
      ).catch(() => undefined);
      throw new EventInitialDispatchInterrupted(
        evidence?.status === 'LOCAL_RUNTIME_GROUP_STOPPED' ? 'CONFIRMED' : 'UNKNOWN'
      );
    } finally {
      closed = true;
      input.signal.removeEventListener('abort', abort);
    }
  }
}
