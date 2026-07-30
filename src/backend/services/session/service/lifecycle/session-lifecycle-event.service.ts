import { createLogger } from '@/backend/services/logger.service';
import type {
  SessionLifecycleEventRecord,
  SessionLifecycleEventStore,
} from '@/backend/services/session/resources/session-lifecycle-event.accessor';
import type { ChatMessage } from '@/shared/acp-protocol';
import type { SessionLifecycleEventKind, SessionLifecycleEventReason } from '@/shared/core';
import type { SessionDomainService } from '../session-domain.service';
import {
  mergeLifecycleTranscript,
  toLifecycleChatMessage,
} from '../store/session-lifecycle-transcript';

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
  'emitDelta' | 'getTranscriptSnapshot' | 'replaceTranscript' | 'upsertLifecycleMessage'
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
    try {
      const event = await this.dependencies.store.upsert({ ...input, createdAt });
      this.publish(input.sessionId, toLifecycleChatMessage(event));
      return event;
    } catch (error) {
      logger.error(
        'Failed persisting session lifecycle event',
        toError(error),
        lifecycleEventLogContext(input)
      );
      this.publish(input.sessionId, toLifecycleChatMessage(toTransientEvent(input, createdAt)));
      return null;
    }
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
    const agentMessage = message.message;
    if (!agentMessage) {
      return;
    }
    if (!this.dependencies.sessionDomainService.upsertLifecycleMessage(sessionId, message)) {
      return;
    }
    this.dependencies.sessionDomainService.emitDelta(sessionId, {
      type: 'agent_message',
      data: agentMessage,
    });
  }
}

function toTransientEvent(
  input: RecordLifecycleEventInput,
  createdAt: Date
): SessionLifecycleEventRecord {
  return {
    ...input,
    id: `transient:${input.sessionId}:${input.dedupeKey}`,
    createdAt,
  };
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
