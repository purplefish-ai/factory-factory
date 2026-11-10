import { createLogger } from '@/backend/services/logger.service';
import {
  AcpSteeringNotSentError,
  AcpSteeringTimeoutError,
} from '@/backend/services/session/service/acp/acp-steering';
import type { MailSignalReceipt } from '@/backend/services/session/service/lifecycle/session-notification-delivery.service';
import { sessionDomainService as domain } from '@/backend/services/session/service/session-domain.service';
import { MessageState, type QueuedMessage, type AgentContentItem } from '@/shared/acp-protocol';
import { buildMessageContent } from './session-message-content';
import { QueuedMessageNotFoundError } from './session-steering-errors';

const logger = createLogger('session-steering');

interface SteeringPorts {
  isPromptInFlight(sessionId: string): boolean;
  captureGuard(sessionId: string): () => boolean;
  isAllowed(sessionId: string): Promise<boolean>;
  send(
    sessionId: string,
    content: string | AgentContentItem[],
    options?: {
      preserveRuntimeOnTimeout?: boolean;
      onLateInjected?: () => Promise<void>;
      onLateNotInjected?: () => Promise<void>;
    }
  ): Promise<{ outcome: 'injected' | 'promptRequired' }>;
  dispatch(sessionId: string): Promise<void>;
}

function assertSteerableMessage(message: QueuedMessage, allowMail: boolean): void {
  if (
    message.source ||
    /^(pr-event-|workspace-notification-)/.test(message.id) ||
    (message.id.startsWith('workspace-mail-wake-') && !allowMail) ||
    message.text.trimStart().startsWith('/')
  ) {
    throw new Error('Only ordinary queued human messages can be steered');
  }
}

type MailSteering = {
  onInjected(): Promise<boolean>;
  releaseForDispatch(): void;
  receipt: MailSignalReceipt;
};

/** Holds normal queue dispatch while an explicit native delivery is unsettled. */
export class SessionQueuedSteering {
  private readonly requests = new Map<string, { messageId: string; operation: Promise<void> }>();
  private readonly lateRecoveryRequested = new Set<string>();
  private readonly pending = new Map<string, { token: symbol; messageId: string }>();
  constructor(private readonly ports: SteeringPorts) {}
  isPending(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  reset(sessionId: string): void {
    this.pending.delete(sessionId);
    this.requests.delete(sessionId);
    this.lateRecoveryRequested.delete(sessionId);
  }

  async steerMailSignal(
    sessionId: string,
    messageId: string,
    onInjected: () => Promise<boolean>,
    releaseForDispatch: () => void,
    receipt: MailSignalReceipt
  ): Promise<void> {
    await this.steer(sessionId, messageId, { onInjected, releaseForDispatch, receipt });
  }

  async steer(sessionId: string, messageId: string, mail?: MailSteering): Promise<void> {
    const existing = this.requests.get(sessionId);
    if (existing) {
      if (existing.messageId === messageId) {
        return await existing.operation;
      }
      throw new Error('Another queued message is being steered. Try again when it finishes.');
    }
    const operation = this.performSteer(sessionId, messageId, mail);
    const entry = { messageId, operation };
    this.requests.set(sessionId, entry);
    try {
      await operation;
    } finally {
      // A stopped operation cannot release a replacement session's request.
      if (this.requests.get(sessionId) === entry) {
        this.requests.delete(sessionId);
      }
    }
  }

  private async performSteer(
    sessionId: string,
    messageId: string,
    mail?: MailSteering
  ): Promise<void> {
    if (this.hasPendingSteer(sessionId, messageId)) {
      return;
    }
    const message = domain.getQueueSnapshot(sessionId).find(({ id }) => id === messageId);
    if (!message) {
      throw new QueuedMessageNotFoundError();
    }
    assertSteerableMessage(message, Boolean(mail));
    if (domain.isMessageAdmissionPending(message)) {
      throw new Error('Message admission is still pending. The selected message remains queued.');
    }
    if (!this.ports.isPromptInFlight(sessionId)) {
      if (domain.peekNextMessage(sessionId) !== message) {
        throw new Error('No active turn to steer. The selected message remains queued.');
      }
      mail?.releaseForDispatch();
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
      const result = await this.sendSteering(sessionId, message, content, isCurrent, mail);
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
      await mail?.onInjected();
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
      mail?.releaseForDispatch();
      this.releaseClaim(sessionId, token, isCurrent, resumeDispatch);
    }
  }

  private async sendSteering(
    sessionId: string,
    message: QueuedMessage,
    content: string | AgentContentItem[],
    isCurrent: () => boolean,
    mail?: MailSteering
  ): Promise<{ outcome: 'injected' | 'promptRequired' }> {
    if (!mail) {
      return this.ports.send(sessionId, content);
    }
    // Persist before the RPC: a crash or uncertain failure must never leave an
    // expiring ordinary claim that can replay accepted native input.
    const commitLateMessage = domain.captureLateMessageCommit(sessionId, message);
    const isStoreCurrent = domain.captureStoreGuard(sessionId);
    if (!(await mail.receipt.arm())) {
      throw new AcpSteeringNotSentError('Mail wake attempt no longer owns its durable claim');
    }
    let finishAttempt!: () => void;
    const attemptSettled = new Promise<void>((resolve) => {
      finishAttempt = resolve;
    });
    try {
      if (!isCurrent()) {
        throw new AcpSteeringNotSentError('Session stopped before steering');
      }
      const result = await this.ports.send(sessionId, content, {
        preserveRuntimeOnTimeout: true,
        onLateNotInjected: async () => {
          await attemptSettled;
          await this.recoverLateUnsentMailSignal(sessionId, mail, isCurrent, isStoreCurrent);
        },
        onLateInjected: () =>
          this.acceptLateMailSignal(
            sessionId,
            message,
            mail.onInjected,
            isCurrent,
            commitLateMessage
          ),
      });
      if (result.outcome === 'promptRequired') {
        await this.disarmMailAttempt(mail);
      }
      return result;
    } catch (error) {
      if (error instanceof AcpSteeringNotSentError) {
        await this.disarmMailAttempt(mail);
      } else {
        mail.receipt.quarantine();
      }
      throw error;
    } finally {
      finishAttempt();
    }
  }

  private async disarmMailAttempt(mail: MailSteering): Promise<boolean> {
    try {
      const disarmed = await mail.receipt.disarm();
      if (!disarmed) {
        mail.receipt.quarantine();
      }
      return disarmed;
    } catch (error) {
      mail.receipt.quarantine();
      throw error;
    }
  }

  private async recoverLateUnsentMailSignal(
    sessionId: string,
    mail: MailSteering,
    isCurrent: () => boolean,
    isStoreCurrent: () => boolean
  ): Promise<void> {
    if (!((await this.disarmMailAttempt(mail)) && isCurrent() && isStoreCurrent())) {
      return;
    }
    if (!((await this.ports.isAllowed(sessionId)) && isCurrent() && isStoreCurrent())) {
      return;
    }
    await this.requestLateDispatch(sessionId);
  }

  private async acceptLateMailSignal(
    sessionId: string,
    message: QueuedMessage,
    accept: () => Promise<boolean>,
    isCurrent: () => boolean,
    commitLateMessage: () => boolean
  ): Promise<void> {
    if (!(await accept())) {
      return;
    }
    if (!commitLateMessage()) {
      return;
    }
    domain.emitDelta(sessionId, {
      type: 'message_state_changed',
      id: message.id,
      newState: MessageState.COMMITTED,
    });
    if (isCurrent()) {
      await this.requestLateDispatch(sessionId);
    }
  }

  private async requestLateDispatch(sessionId: string): Promise<void> {
    if (this.isPending(sessionId)) {
      this.lateRecoveryRequested.add(sessionId);
    } else {
      await this.ports.dispatch(sessionId);
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
    const lateRecovery =
      !this.pending.has(sessionId) && this.lateRecoveryRequested.delete(sessionId);
    if ((resumeDispatch || lateRecovery) && isCurrent()) {
      void this.ports.dispatch(sessionId).catch((error) => {
        logger.warn('Failed to resume queue after steering', { sessionId, error });
      });
    }
  }
}
