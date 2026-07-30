import { createLogger } from '@/backend/services/logger.service';
import type {
  SessionLifecycleEventRecord,
  SessionLifecycleEventStore,
} from '@/backend/services/session/resources/session-lifecycle-event.accessor';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import {
  mergeLifecycleTranscript,
  toLifecycleChatMessage,
} from '@/backend/services/session/service/store/session-lifecycle-transcript';
import type { ChatMessage } from '@/shared/acp-protocol';
import type { SessionLifecycleEventKind, SessionLifecycleEventReason } from '@/shared/core';

const logger = createLogger('session-lifecycle-event-service');

export interface RecordLifecycleEventInput {
  workspaceId: string;
  sessionId: string;
  kind: SessionLifecycleEventKind;
  reason: SessionLifecycleEventReason;
  message: string;
  dedupeKey: string;
  createdAt?: Date;
}

type SessionLifecycleEventDomain = Pick<
  SessionDomainService,
  | 'emitDelta'
  | 'getTranscriptSnapshot'
  | 'removeTranscriptMessageById'
  | 'replaceTranscript'
  | 'upsertLifecycleMessage'
>;

export class SessionLifecycleEventService {
  constructor(
    private readonly dependencies: {
      store: SessionLifecycleEventStore;
      sessionDomainService: SessionLifecycleEventDomain;
    }
  ) {}

  async record(input: RecordLifecycleEventInput): Promise<SessionLifecycleEventRecord | null> {
    const createdAt = input.createdAt ?? new Date();
    let event: SessionLifecycleEventRecord;
    try {
      event = await this.dependencies.store.upsert({ ...input, createdAt });
    } catch (error) {
      logger.error(
        'Failed persisting session lifecycle event',
        toError(error),
        lifecycleEventLogContext(input)
      );
      this.publishBestEffort(
        input,
        toLifecycleChatMessage(toTransientEvent(input, createdAt)),
        false
      );
      return null;
    }

    this.publishBestEffort(input, toLifecycleChatMessage(event), true);
    return event;
  }

  async hydrate(sessionId: string): Promise<void> {
    let events: SessionLifecycleEventRecord[];
    try {
      events = await this.dependencies.store.findBySessionId(sessionId);
    } catch (error) {
      logger.error('Failed hydrating session lifecycle events', toError(error), { sessionId });
      return;
    }

    const transcript = this.dependencies.sessionDomainService.getTranscriptSnapshot(sessionId);
    this.dependencies.sessionDomainService.replaceTranscript(
      sessionId,
      mergeLifecycleTranscript(transcript, events)
    );
  }

  private publish(sessionId: string, message: ChatMessage): void {
    const previousOrderById = new Map(
      this.dependencies.sessionDomainService
        .getTranscriptSnapshot(sessionId)
        .map((entry) => [entry.id, entry.order])
    );
    if (!this.dependencies.sessionDomainService.upsertLifecycleMessage(sessionId, message)) {
      return;
    }
    const changedMessages = this.dependencies.sessionDomainService
      .getTranscriptSnapshot(sessionId)
      .filter(
        (entry) =>
          entry.source === 'agent' &&
          entry.message !== undefined &&
          previousOrderById.get(entry.id) !== entry.order
      );
    for (const changedMessage of changedMessages) {
      const agentMessage = changedMessage.message;
      if (!agentMessage) {
        continue;
      }
      this.dependencies.sessionDomainService.emitDelta(sessionId, {
        type: 'agent_message',
        data: agentMessage,
        messageId: changedMessage.id,
        order: changedMessage.order,
      });
    }
  }

  private publishBestEffort(
    input: RecordLifecycleEventInput,
    message: ChatMessage,
    durable: boolean
  ): void {
    try {
      if (durable) {
        this.dependencies.sessionDomainService.removeTranscriptMessageById(
          input.sessionId,
          transientLifecycleMessageId(input),
          { emitSnapshot: false }
        );
      }
      this.publish(input.sessionId, message);
    } catch (error) {
      logger.error('Failed publishing session lifecycle event', toError(error), {
        ...lifecycleEventLogContext(input),
        durable,
      });
    }
  }
}

function toTransientEvent(
  input: RecordLifecycleEventInput,
  createdAt: Date
): SessionLifecycleEventRecord {
  return {
    ...input,
    id: transientLifecycleEventId(input),
    createdAt,
  };
}

function transientLifecycleEventId(input: RecordLifecycleEventInput): string {
  return `transient:${input.sessionId}:${input.dedupeKey}`;
}

function transientLifecycleMessageId(input: RecordLifecycleEventInput): string {
  return `session-lifecycle:${transientLifecycleEventId(input)}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function lifecycleEventLogContext(input: RecordLifecycleEventInput): Record<string, unknown> {
  return {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    kind: input.kind,
    reason: input.reason,
    dedupeKey: input.dedupeKey,
  };
}
