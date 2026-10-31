import { createLogger } from '@/backend/services/logger.service';
import { AcpSteeringTimeoutError } from '@/backend/services/session/service/acp/acp-steering';
import { sessionDomainService as domain } from '@/backend/services/session/service/session-domain.service';
import { MessageState, type AgentContentItem } from '@/shared/acp-protocol';
import { buildMessageContent } from './session-message-content';
import { QueuedMessageNotFoundError } from './session-steering-errors';

const logger = createLogger('session-steering');

interface SteeringPorts {
  isPromptInFlight(sessionId: string): boolean;
  captureGuard(sessionId: string): () => boolean;
  isAllowed(sessionId: string): Promise<boolean>;
  send(
    sessionId: string,
    content: string | AgentContentItem[]
  ): Promise<{ outcome: 'injected' | 'promptRequired' }>;
  dispatch(sessionId: string): Promise<void>;
}

/** Holds normal queue dispatch while an explicit native delivery is unsettled. */
export class SessionQueuedSteering {
  private readonly pending = new Map<string, { token: symbol; messageId: string }>();
  constructor(private readonly ports: SteeringPorts) {}
  isPending(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  reset(sessionId: string): void {
    this.pending.delete(sessionId);
  }

  async steer(sessionId: string, messageId: string): Promise<void> {
    if (this.hasPendingSteer(sessionId, messageId)) {
      return;
    }
    const message = domain.getQueueSnapshot(sessionId).find(({ id }) => id === messageId);
    if (!message) {
      throw new QueuedMessageNotFoundError();
    }
    if (
      message.source ||
      /^(pr-event-|workspace-notification-)/.test(message.id) ||
      message.text.trimStart().startsWith('/')
    ) {
      throw new Error('Only ordinary queued human messages can be steered');
    }
    if (!this.ports.isPromptInFlight(sessionId)) {
      if (domain.peekNextMessage(sessionId) !== message) {
        throw new Error('No active turn to steer. The selected message remains queued.');
      }
      await this.ports.dispatch(sessionId);
      return;
    }
    const isCurrent = this.ports.captureGuard(sessionId);
    const token = Symbol();
    this.pending.set(sessionId, { token, messageId });
    let resumeDispatch = true;
    try {
      if (!(await this.ports.isAllowed(sessionId))) {
        throw new Error('Session is not ready for steering');
      }
      if (!isCurrent()) {
        throw new Error('Session stopped before steering');
      }
      if (!domain.getQueueSnapshot(sessionId).includes(message)) {
        return;
      }
      const content = buildMessageContent(message);
      const result = await this.ports.send(sessionId, content);
      if (result.outcome === 'promptRequired') {
        return;
      }
      // Accepted input is consumed even if stop advanced the generation.
      const removed = domain.removeQueuedMessage(sessionId, message.id, {
        expectedMessage: message,
      });
      if (!(removed || isCurrent())) {
        return;
      }
      domain.commitSentUserMessage(sessionId, message);
      domain.emitDelta(sessionId, {
        type: 'message_state_changed',
        id: message.id,
        newState: MessageState.COMMITTED,
      });
    } catch (error) {
      // A missing acknowledgment has an uncertain delivery outcome. Keep the
      // message available for explicit retry without restarting the stopped agent.
      resumeDispatch = !(error instanceof AcpSteeringTimeoutError);
      throw error;
    } finally {
      this.releaseClaim(sessionId, token, isCurrent, resumeDispatch);
    }
  }

  private hasPendingSteer(sessionId: string, messageId: string): boolean {
    const pending = this.pending.get(sessionId);
    if (!pending) {
      return false;
    }
    if (pending.messageId !== messageId) {
      throw new Error('Another queued message is being steered. Try again when it finishes.');
    }
    return true;
  }

  private releaseClaim(
    sessionId: string,
    token: symbol,
    isCurrent: () => boolean,
    resumeDispatch: boolean
  ): void {
    // An old request must not release a replacement generation's claim.
    if (this.pending.get(sessionId)?.token === token) {
      this.pending.delete(sessionId);
    }
    if (resumeDispatch && isCurrent()) {
      void this.ports.dispatch(sessionId).catch((error) => {
        logger.warn('Failed to resume queue after steering', { sessionId, error });
      });
    }
  }
}
