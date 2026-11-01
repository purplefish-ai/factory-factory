import type {
  EventInitialPermit,
  EventSessionAuthority,
} from '@/backend/services/session/service/lifecycle/event-session-authority';
import type { QueuedMessage } from '@/shared/acp-protocol';
import type { InitialAttempt } from '@/shared/event-agent-delivery';

/** Dedicated singleton dispatch: ordinary queue/settings never participate in this turn. */
export class EventInitialDispatcher {
  constructor(
    private readonly ports: {
      authority: EventSessionAuthority;
      start(sessionId: string, permit: EventInitialPermit): Promise<unknown>;
      send(sessionId: string, text: string, permit: EventInitialPermit): Promise<void>;
      commit(sessionId: string, message: QueuedMessage): void;
    }
  ) {}
  dispatch(input: { attempt: InitialAttempt; text: string; assertCurrent(): void }): Promise<void> {
    if (!input.text.trim()) {
      return Promise.reject(new Error('Initial prompt is empty'));
    }
    return this.ports.authority.runInitial(
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
      input.assertCurrent
    );
  }
}
