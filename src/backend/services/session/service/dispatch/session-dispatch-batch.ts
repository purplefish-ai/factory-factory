import { createLogger } from '@/backend/services/logger.service';
import { PermanentAttachmentError } from '@/backend/services/session/service/chat/chat-message-handlers/attachment-processing';
import type { NotificationDispatchClaim } from '@/backend/services/session/service/lifecycle/session-notification-delivery.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { AgentContentItem, QueuedMessage } from '@/shared/acp-protocol';
import type {
  SessionDispatchDependencies,
  SessionDispatchNotificationDeliveryService,
} from './session-dispatch.types';

const logger = createLogger('session-dispatch-batch');

/** Slash commands must remain standalone so providers interpret them as commands. */
function isCommand(message: QueuedMessage): boolean {
  return !message.source && message.text.trimStart().startsWith('/');
}

export function prepareBatchContents(
  messages: QueuedMessage[],
  buildContent: (message: QueuedMessage) => string | AgentContentItem[],
  reject: (message: QueuedMessage, error: PermanentAttachmentError) => void
) {
  const contents = new Map<QueuedMessage, string | AgentContentItem[]>();
  for (const message of [...messages]) {
    try {
      contents.set(message, buildContent(message));
    } catch (error) {
      if (!(error instanceof PermanentAttachmentError)) {
        throw error;
      }
      reject(message, error);
      messages.splice(messages.indexOf(message), 1);
    }
  }
  return contents;
}

export function combineBatchContents(
  messages: QueuedMessage[],
  contents: Map<QueuedMessage, string | AgentContentItem[]>
): string | AgentContentItem[] {
  const parts = messages.map((message) => {
    const content = contents.get(message);
    if (content === undefined) {
      throw new Error('Queued message content was not prepared');
    }
    return content;
  });
  return parts.every((part) => typeof part === 'string')
    ? parts.join('\n\n')
    : parts.flatMap((part, index) => batchPartBlocks(part, index > 0));
}

function batchPartBlocks(part: string | AgentContentItem[], boundary: boolean): AgentContentItem[] {
  if (typeof part === 'string') {
    return [{ type: 'text', text: `${boundary ? '\n\n' : ''}${part}` }];
  }
  const firstText = part.findIndex((block) => block.type === 'text');
  // Claude restores each text block separately, so separators must stay with meaningful text.
  return part.map((block, index) =>
    boundary && index === firstText && block.type === 'text'
      ? { ...block, text: `\n\n${block.text}` }
      : block
  );
}

async function releasePreparedBackgrounds(
  messages: QueuedMessage[],
  background: SessionDispatchDependencies['backgroundDelivery'],
  error: unknown,
  state: 'failed' | 'cancelled' = 'failed'
) {
  for (const message of messages.filter((item) => item.source)) {
    await background
      .fail(message, error, state)
      .catch((failure) =>
        logger.warn('PR claim recovery deferred', { messageId: message.id, error: failure })
      );
  }
}

function takeDispatchBatch(sessionId: string, messages: QueuedMessage[]): boolean {
  if (messages.length > 1) {
    return sessionDomainService.takeQueuedMessages(sessionId, messages);
  }
  if (sessionDomainService.peekNextMessage(sessionId) !== messages[0]) {
    return false;
  }
  const message = sessionDomainService.dequeueNext(sessionId, { emitSnapshot: false });
  if (!message) {
    return false;
  }
  messages[0] = message;
  return true;
}

export async function dispatchCollectedBatch(input: {
  sessionId: string;
  batch: Awaited<ReturnType<typeof collectDispatchBatch>>;
  backgroundDelivery: SessionDispatchDependencies['backgroundDelivery'];
  isCurrent(): boolean;
  send(messages: QueuedMessage[]): Promise<void>;
  onError(message: QueuedMessage, error: unknown): void;
  onSuccess(): void;
}): Promise<'retry' | undefined> {
  const { messages } = input.batch;
  try {
    if (!input.isCurrent()) {
      await releasePreparedBackgrounds(
        messages,
        input.backgroundDelivery,
        new Error('Session stopped before dispatch'),
        'cancelled'
      );
      return;
    }
    // Every selected message remains visible until the complete batch is ready.
    if (!takeDispatchBatch(input.sessionId, messages)) {
      await releasePreparedBackgrounds(
        messages,
        input.backgroundDelivery,
        new Error('Turn in progress: human message queued during preparation')
      );
      return 'retry';
    }
    try {
      await input.send(messages);
      input.onSuccess();
    } catch (error) {
      // Requeue from the end so a busy provider preserves FIFO order.
      const backwards = [...messages].reverse();
      await releasePreparedBackgrounds(
        backwards,
        input.backgroundDelivery,
        error,
        input.isCurrent() ? 'failed' : 'cancelled'
      );
      for (const message of backwards) {
        input.onError(message, error);
      }
    }
  } finally {
    input.batch.release();
  }
  return undefined;
}

async function dropDuplicateNotification(
  notifications: SessionDispatchNotificationDeliveryService,
  sessionId: string,
  messageId: string,
  claims: Extract<NotificationDispatchClaim, { status: 'claimed' }>[]
) {
  const claim = notifications.claimForDispatch(sessionId, messageId);
  if (claim.status === 'claimed') {
    claims.push(claim);
  }
  const duplicate =
    claim.status === 'duplicate' ||
    (claim.status === 'claimed' && (await notifications.isAlreadyDelivered(claim.notificationId)));
  if (duplicate) {
    notifications.removeDuplicateFromQueue(sessionId, messageId);
  }
  return duplicate;
}

/** Receipt/notification acknowledgement must never roll back a successful provider turn. */
export async function acknowledgeSentBatch(input: {
  sessionId: string;
  messages: QueuedMessage[];
  backgroundDelivery: SessionDispatchDependencies['backgroundDelivery'];
  notifications: SessionDispatchNotificationDeliveryService;
  isCurrent(): boolean;
}) {
  for (const message of input.messages) {
    try {
      if (message.source) {
        await input.backgroundDelivery.complete(message);
      } else {
        await input.notifications.acknowledgeSuccessfulDispatch(message.id);
      }
    } catch (error) {
      logger.warn('Queued message received; delivery acknowledgement deferred', {
        sessionId: input.sessionId,
        messageId: message.id,
        error,
      });
    }
  }
  const background = input.messages.find((message) => message.source);
  if (background?.source && input.isCurrent()) {
    await input.notifications
      .recoverPending({
        sessionId: input.sessionId,
        workspaceId: background.source.request.workspaceId,
        assertAllowed: () => {
          if (!input.isCurrent()) {
            throw new Error('Session stopped before notification recovery');
          }
        },
      })
      .catch((error) =>
        logger.warn('Notification recovery deferred after successful turn', {
          sessionId: input.sessionId,
          error,
        })
      );
  }
}

/** Freeze one next-turn batch while retaining notification claims until its send settles. */
export async function collectDispatchBatch(input: {
  sessionId: string;
  first: QueuedMessage;
  notifications: SessionDispatchNotificationDeliveryService;
  prepareBackground(message: QueuedMessage): Promise<boolean>;
  isCurrent(): boolean;
}) {
  const messages = [input.first];
  const claims: Extract<NotificationDispatchClaim, { status: 'claimed' }>[] = [];
  const release = () => claims.forEach((claim) => claim.release());
  if (isCommand(input.first)) {
    return { messages, release };
  }
  const snapshot = sessionDomainService.getQueueSnapshot(input.sessionId);
  try {
    for (const message of snapshot.slice(1)) {
      if (!input.isCurrent() || isCommand(message)) {
        break;
      }
      // One PR claim already covers all pending facts for this conversation.
      if (message.source && messages.some((item) => item.source)) {
        break;
      }
      if (
        await dropDuplicateNotification(input.notifications, input.sessionId, message.id, claims)
      ) {
        continue;
      }
      if (message.source && !(await input.prepareBackground(message))) {
        break;
      }
      messages.push(message);
    }
    return { messages, release };
  } catch (error) {
    release();
    throw error;
  }
}
