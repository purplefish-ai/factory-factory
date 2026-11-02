import { createLogger } from '@/backend/services/logger.service';
import { AcpSteeringTimeoutError } from '@/backend/services/session/service/acp/acp-steering';
import { sessionDomainService as domain } from '@/backend/services/session/service/session-domain.service';
import { MessageState, type AgentContentItem, type QueuedMessage } from '@/shared/acp-protocol';
import { UncertainChatDispatchError } from '../chat/chat-intent-errors';
import type { SessionChatIntentService } from '../chat/session-chat-intent.service';
import { prepareDurableAttempt } from './session-durable-attempt';
import { buildMessageContent } from './session-message-content';
import { QueuedMessageNotFoundError } from './session-steering-errors';

const logger = createLogger('session-steering');

interface SteeringPorts {
  chatIntent?(): SessionChatIntentService | undefined;
  generation?(sessionId: string): number;
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
    let releaseProjection: (() => void) | undefined;
    try {
      releaseProjection = this.holdProjection(sessionId, message);
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
      const result = await this.sendSteering(sessionId, message, content, isCurrent);
      if (result.outcome === 'promptRequired') {
        return;
      }
      // Accepted input is consumed even if stop advanced the generation.
      // Publish the removal together with the committed entry, never an empty handoff.
      const removed = domain.takeQueuedMessages(sessionId, [message]);
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
      resumeDispatch = this.handleSteerError(sessionId, message, error);
      throw error;
    } finally {
      releaseProjection?.();
      this.releaseClaim(sessionId, token, isCurrent, resumeDispatch);
    }
  }

  private holdProjection(sessionId: string, message: QueuedMessage): (() => void) | undefined {
    const owner = this.ports.chatIntent?.();
    if (!owner) {
      return undefined;
    }
    const release = owner.holdProjection(sessionId, [message]);
    if (!release) {
      throw new QueuedMessageNotFoundError();
    }
    return release;
  }

  private async sendSteering(
    sessionId: string,
    message: QueuedMessage,
    content: string | AgentContentItem[],
    isCurrent: () => boolean
  ) {
    const attempt = await prepareDurableAttempt({
      owner: this.ports.chatIntent?.(),
      sessionId,
      messages: [message],
      content,
      settings: message.settings,
      generation: this.ports.generation?.(sessionId) ?? 0,
      isCurrent,
    });
    return attempt.invoke(
      () => this.ports.send(sessionId, content),
      (result) => (result.outcome === 'injected' ? 'committed' : 'queued')
    );
  }

  private handleSteerError(sessionId: string, message: QueuedMessage, error: unknown): boolean {
    if (error instanceof UncertainChatDispatchError) {
      domain.takeQueuedMessages(sessionId, [message]);
      domain.failMessage(sessionId, message, error.message);
      return false;
    }
    return !(error instanceof AcpSteeringTimeoutError);
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
