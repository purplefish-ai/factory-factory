import { SERVICE_LIMITS } from '@/backend/services/constants';
import {
  type ChatIntentAccessor,
  type IntentRecord,
} from '@/backend/services/session/resources/chat-intent.accessor';
import { MessageState, type QueuedMessage } from '@/shared/acp-protocol';
import type { ChatIntentDomain } from './chat-intent-domain';
import { UncertainChatDispatchError } from './chat-intent-errors';
import { validateAttachment } from './chat-message-handlers/attachment-processing';

/** Durable authority; the domain queue is its disposable runtime projection. */
export class SessionChatIntentService {
  private readonly attempted = new Map<string, Map<string, string>>();
  private readonly staged = new Map<string, Map<string, Set<symbol>>>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private canAccept = (_id: string) => true;
  configureAdmissionGuard(guard: (id: string) => boolean): void {
    this.canAccept = guard;
  }
  constructor(
    readonly store: ChatIntentAccessor,
    private readonly domain: ChatIntentDomain
  ) {}

  holdProjection(sessionId: string, messages: QueuedMessage[]): (() => void) | undefined {
    if (messages.some((message) => this.isStaged(sessionId, message.id))) {
      return undefined;
    }
    const token = Symbol();
    const staged = this.staged.get(sessionId) ?? new Map<string, Set<symbol>>();
    this.staged.set(sessionId, staged);
    for (const message of messages) {
      const holders = staged.get(message.id) ?? new Set<symbol>();
      holders.add(token);
      staged.set(message.id, holders);
    }
    return () => {
      for (const message of messages) {
        const holders = staged.get(message.id);
        holders?.delete(token);
        if (!holders?.size) {
          staged.delete(message.id);
          this.attempted.get(sessionId)?.delete(message.id);
        }
      }
      if (!staged.size) {
        this.staged.delete(sessionId);
        this.attempted.delete(sessionId);
      }
    };
  }
  private isStaged(sessionId: string, messageId: string): boolean {
    return Boolean(this.staged.get(sessionId)?.has(messageId));
  }

  run<T>(id: string, work: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(id) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.tails.set(id, result);
    void result
      .finally(() => {
        if (this.tails.get(id) === result) {
          this.tails.delete(id);
        }
      })
      .catch(() => undefined);
    return result;
  }

  hasQueuedInput(sessionId: string): boolean {
    return this.domain
      .getQueueSnapshot(sessionId)
      .some(
        (message) => !(message.source || /^(pr-event-|workspace-notification-)/.test(message.id))
      );
  }

  hydrate(sessionId: string, options?: { publish?: boolean }): Promise<void> {
    return this.run(sessionId, () => this.hydrateLocked(sessionId, options?.publish));
  }
  private async hydrateLocked(sessionId: string, publish = true): Promise<void> {
    const rows = await this.store.read(sessionId, true);
    for (const row of rows) {
      if (row.status === 'queued' && !this.isStaged(sessionId, row.message.id)) {
        const result = this.domain.restoreAcceptedMessage(sessionId, row.message, {
          emitSnapshot: publish,
        });
        if ('error' in result) {
          throw new Error(result.error);
        }
      } else if (row.status === 'uncertain' || row.status === 'failed') {
        this.publishRecorded(sessionId, row, publish);
      }
    }
  }

  accept(
    sessionId: string,
    message: QueuedMessage,
    isCurrent = () => true
  ): Promise<IntentRecord & { position?: number }> {
    return this.run(sessionId, async () => {
      for (const attachment of message.attachments ?? []) {
        validateAttachment(attachment);
      }
      await this.hydrateLocked(sessionId);
      const record = await this.store.accept(
        sessionId,
        message,
        this.domain.getQueueLength(sessionId) >= SERVICE_LIMITS.sessionStoreMaxQueueSize
      );
      if (record.status !== 'queued') {
        this.publishRecorded(sessionId, record);
        return record;
      }
      if (!(isCurrent() && this.canAccept(sessionId))) {
        await this.store.cancel(sessionId, message.id);
        const cancelled = { ...record, status: 'cancelled' as const };
        this.publishRecorded(sessionId, cancelled);
        return cancelled;
      }
      if (this.isStaged(sessionId, message.id)) {
        return { ...record, position: 0 };
      }
      const result = this.domain.enqueue(sessionId, record.message);
      if ('error' in result) {
        await this.store.cancel(sessionId, message.id);
        throw new Error(result.error);
      }
      return { ...record, position: result.position };
    });
  }

  hasAccepted(sessionId: string, messageId: string): Promise<boolean> {
    return this.run(sessionId, async () => Boolean(await this.store.find(sessionId, messageId)));
  }

  async settleNotInvoked(
    sessionId: string,
    attemptId: string,
    status: 'queued' | 'cancelled',
    evidence = 'confirmed local rejection before provider invocation'
  ): Promise<void> {
    await this.run(sessionId, async () => {
      await this.store.settle(attemptId, status, evidence);
      const attempts = this.attempted.get(sessionId);
      for (const [id, claimed] of attempts ?? []) {
        if (claimed === attemptId) {
          attempts?.delete(id);
        }
      }
    });
  }

  recoverInitial(sessionId: string, messageId: string): Promise<QueuedMessage | null> {
    return this.run(sessionId, async () => {
      const prior = await this.store.find(sessionId, messageId);
      if (!prior) {
        return null;
      }
      await this.hydrateLocked(sessionId);
      return prior.message;
    });
  }

  acceptInitial(
    sessionId: string,
    message: QueuedMessage,
    isCurrent?: () => boolean
  ): Promise<IntentRecord & { position?: number }> {
    return this.accept(sessionId, message, isCurrent);
  }

  cancelQueued(sessionId: string, messageId: string): Promise<boolean> {
    return this.run(sessionId, async () => {
      const message = this.domain.getQueueSnapshot(sessionId).find((item) => item.id === messageId);
      if (!message) {
        return false;
      }
      const release = this.holdProjection(sessionId, [message]);
      if (!release) {
        return false;
      }
      try {
        await this.store.cancel(sessionId, messageId);
        return this.domain.removeQueuedMessage(sessionId, messageId, { expectedMessage: message });
      } finally {
        release();
      }
    });
  }

  private publishRecorded(sessionId: string, row: IntentRecord, publish = true): void {
    if (row.status === 'uncertain' && this.isStaged(sessionId, row.message.id)) {
      if (publish) {
        this.domain.emitDelta(sessionId, {
          type: 'message_state_changed',
          id: row.message.id,
          newState: MessageState.DISPATCHED,
        });
      }
      return;
    }
    if (row.status === 'uncertain' || row.status === 'failed') {
      this.domain.failMessage(
        sessionId,
        row.message,
        row.status === 'uncertain'
          ? `Delivery outcome is uncertain (batch ${row.attemptId ?? 'unknown'}). Check provider history before submitting again. This batch will not be resent automatically.`
          : 'Message was not sent. Submit a new message to retry.',
        'failed',
        publish
      );
    } else {
      this.domain.emitDelta(sessionId, {
        type: 'message_state_changed',
        id: row.message.id,
        newState: row.status === 'committed' ? MessageState.COMMITTED : MessageState.CANCELLED,
      });
    }
  }

  resolve(sessionId: string, attemptId: string, status: 'committed' | 'cancelled'): Promise<void> {
    return this.run(sessionId, async () => {
      const members = (await this.store.read(sessionId, true)).filter(
        (row) => row.attemptId === attemptId
      );
      if (members.some((row) => this.isStaged(sessionId, row.message.id))) {
        throw new Error('Dispatch attempt is still in flight');
      }
      await this.store.resolve(sessionId, attemptId, status);
      for (const row of members) {
        this.domain.clearMessageRejection(sessionId, row.message.id);
        this.publishRecorded(sessionId, { ...row, status });
      }
    });
  }

  override(
    sessionId: string,
    requestedAt: number,
    settings: Partial<QueuedMessage['settings']>
  ): Promise<void> {
    return this.run(sessionId, async () => {
      await this.store.override(sessionId, requestedAt, settings);
      for (const message of this.domain.getQueueSnapshot(sessionId)) {
        if (!message.source && Date.parse(message.timestamp) <= requestedAt) {
          message.settings = { ...message.settings, ...settings };
        }
      }
    });
  }
  cancel(
    sessionId: string,
    messageId?: string,
    status: 'cancelled' | 'failed' = 'cancelled'
  ): Promise<void> {
    return this.run(sessionId, () => this.store.cancel(sessionId, messageId, status));
  }
  refreshSelected(sessionId: string, messages: QueuedMessage[]): Promise<Record<string, number>> {
    return this.run(sessionId, async () => {
      const rows = await this.store.read(sessionId, true);
      const revisions: Record<string, number> = {};
      for (const message of messages) {
        const row = rows.find((entry) => entry.message.id === message.id);
        if (row?.status === 'queued') {
          message.settings = { ...row.message.settings };
          revisions[message.id] = row.revision;
        }
      }
      return revisions;
    });
  }

  protectClaimedBatchFailure(
    sessionId: string,
    messages: QueuedMessage[],
    error: unknown
  ): unknown {
    if (error instanceof UncertainChatDispatchError) {
      return error;
    }
    const attemptId = messages
      .map((message) => this.attempted.get(sessionId)?.get(message.id))
      .find((id) => id !== undefined);
    return attemptId ? new UncertainChatDispatchError(attemptId, { cause: error }) : error;
  }

  claim(...args: Parameters<ChatIntentAccessor['claim']>): ReturnType<ChatIntentAccessor['claim']> {
    return this.run(args[0], async () => {
      const attemptId = await this.store.claim(...args);
      if (attemptId) {
        const attempts = this.attempted.get(args[0]) ?? new Map<string, string>();
        for (const message of args[1]) {
          if (this.isStaged(args[0], message.id)) {
            attempts.set(message.id, attemptId);
          }
        }
        if (attempts.size) {
          this.attempted.set(args[0], attempts);
        }
      }
      return attemptId;
    });
  }
}
