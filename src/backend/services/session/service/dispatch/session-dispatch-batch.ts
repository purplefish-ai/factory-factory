import { createLogger } from '@/backend/services/logger.service';
import { ChatIntentRevisionChangedError } from '@/backend/services/session/resources/chat-intent.accessor';
import { PromptNotInvokedError } from '@/backend/services/session/service/acp/acp-prompt-invocation';
import type { SessionCallerGuard } from '@/backend/services/session/service/bridges';
import { UncertainChatDispatchError } from '@/backend/services/session/service/chat/chat-intent-errors';
import { PermanentAttachmentError } from '@/backend/services/session/service/chat/chat-message-handlers/attachment-processing';
import type { SessionChatIntentService } from '@/backend/services/session/service/chat/session-chat-intent.service';
import {
  notificationClaimBlockReason,
  type NotificationDispatchClaim,
} from '@/backend/services/session/service/lifecycle/session-notification-delivery.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { AgentContentItem, QueuedMessage } from '@/shared/acp-protocol';
import type {
  SessionDispatchDependencies,
  SessionDispatchNotificationDeliveryService,
} from './session-dispatch.types';

const logger = createLogger('session-dispatch-batch');

/** Skip held external work without changing the order of eligible delivery retries. */
export async function getDispatchableHead(
  sessionId: string,
  isHeld: (message: QueuedMessage) => Promise<boolean>
): Promise<QueuedMessage | undefined> {
  const first = sessionDomainService.peekNextMessage(sessionId);
  if (!(first && (await isHeld(first)))) {
    return first;
  }
  sessionDomainService.prioritizeQueuedHumanMessages(sessionId);
  const candidate = sessionDomainService.peekNextMessage(sessionId);
  return candidate && !(await isHeld(candidate)) ? candidate : undefined;
}

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

type CollectedBatchInput = {
  chatIntent?: SessionChatIntentService;
  sessionId: string;
  batch: Awaited<ReturnType<typeof collectDispatchBatch>>;
  backgroundDelivery: SessionDispatchDependencies['backgroundDelivery'];
  isCurrent(): boolean;
  send(messages: QueuedMessage[]): Promise<void>;
  onError(message: QueuedMessage, error: unknown): void | Promise<void>;
  onSuccess(): void;
};

export async function dispatchCollectedBatch(
  input: CollectedBatchInput
): Promise<'retry' | undefined> {
  const { messages } = input.batch;
  const releaseProjection = input.chatIntent?.holdProjection(input.sessionId, [...messages]);
  if (input.chatIntent && !releaseProjection) {
    await releasePreparedBackgrounds(
      messages,
      input.backgroundDelivery,
      new Error('Queued cancellation is settling')
    );
    input.batch.release();
    return 'retry';
  }
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
      return await handleFailedBatch(input, messages, error);
    }
  } finally {
    releaseProjection?.();
    input.batch.release();
  }
  return undefined;
}

async function handleFailedBatch(
  input: CollectedBatchInput,
  messages: QueuedMessage[],
  error: unknown
): Promise<'retry' | undefined> {
  // Requeue from the end so a busy provider preserves FIFO order.
  const backwards = [...messages].reverse();
  error = input.chatIntent?.protectClaimedBatchFailure(input.sessionId, messages, error) ?? error;
  if (
    error instanceof ChatIntentRevisionChangedError ||
    (error instanceof PromptNotInvokedError && input.isCurrent())
  ) {
    await releasePreparedBackgrounds(backwards, input.backgroundDelivery, error);
    if (!input.isCurrent()) {
      await handleMemberErrors(input, backwards, error);
      return;
    }
    for (const message of backwards) {
      // Confirmed non-invocation invalidates only the provisional transcript,
      // not the accepted durable input that is about to retry.
      sessionDomainService.removeTranscriptMessageById(input.sessionId, message.id, {
        emitSnapshot: false,
      });
      sessionDomainService.requeueFront(input.sessionId, message);
    }
    return 'retry';
  }
  if (!(error instanceof UncertainChatDispatchError)) {
    await releasePreparedBackgrounds(
      backwards,
      input.backgroundDelivery,
      error,
      input.isCurrent() ? 'failed' : 'cancelled'
    );
  }
  await handleMemberErrors(input, backwards, error);
  return undefined;
}

async function dropBlockedNotification(
  notifications: SessionDispatchNotificationDeliveryService,
  sessionId: string,
  messageId: string,
  claims: Extract<NotificationDispatchClaim, { status: 'claimed' }>[],
  guard?: SessionCallerGuard
) {
  if (guard) {
    await guard.check();
    guard.assertCurrent?.();
  }
  const claim = notifications.claimForDispatch(sessionId, messageId);
  if (claim.status === 'claimed') {
    claims.push(claim);
  }
  const reason = await notificationClaimBlockReason(notifications, claim);
  if (reason && reason !== 'unavailable') {
    if (guard) {
      await guard.check();
      guard.assertCurrent?.();
    }
    notifications.removeBlockedFromQueue(sessionId, messageId, reason);
  }
  return reason;
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
  isHeld?(message: QueuedMessage): Promise<boolean>;
  onNotificationUnavailable?(): void;
  guard?: SessionCallerGuard;
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
      if (await isBatchBoundary(message, input.isCurrent, input.isHeld)) {
        break;
      }
      // One PR claim already covers all pending facts for this conversation.
      if (message.source && messages.some((item) => item.source)) {
        break;
      }
      const reason = await dropBlockedNotification(
        input.notifications,
        input.sessionId,
        message.id,
        claims,
        input.guard
      );
      if (reason === 'unavailable') {
        input.onNotificationUnavailable?.();
        break;
      }
      if (reason) {
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

export async function prepareBackgroundForDispatch(
  dependencies: Pick<
    SessionDispatchDependencies,
    'runtimeManager' | 'backgroundDelivery' | 'chatIntent'
  >,
  dbSessionId: string,
  peeked: QueuedMessage,
  isCurrent: () => boolean,
  guard?: SessionCallerGuard
): Promise<boolean> {
  if (!peeked.source) {
    return true;
  }
  if (await dependencies.chatIntent?.store.hasUncertainAttempt(dbSessionId)) {
    return false;
  }
  if (
    dependencies.runtimeManager.isSessionPromptInFlight(dbSessionId) ||
    sessionDomainService.getPendingInteractiveRequest(dbSessionId)
  ) {
    return false;
  }
  const prepared = await dependencies.backgroundDelivery.prepare(
    dbSessionId,
    peeked,
    ...(guard ? [guard] : [])
  );
  try {
    if (guard) {
      await guard.check();
      guard.assertCurrent?.();
    }
  } catch (error) {
    if (prepared.status === 'ready') {
      await prepared.releaseOnRejection(error);
    }
    throw error;
  }
  if (prepared.status === 'discard') {
    sessionDomainService.removeQueuedMessage(dbSessionId, peeked.id, {
      expectedMessage: peeked,
    });
    return false;
  }
  if (prepared.status !== 'ready') {
    return false;
  }
  if (!isCurrent()) {
    await dependencies.backgroundDelivery.fail(
      peeked,
      new Error('Session stopped before dispatch'),
      'cancelled'
    );
    return false;
  }

  return true;
}

async function handleMemberErrors(
  input: CollectedBatchInput,
  messages: QueuedMessage[],
  error: unknown
): Promise<void> {
  const failures: unknown[] = [];
  for (const message of messages) {
    try {
      await input.onError(message, error);
    } catch (failure) {
      failures.push(failure);
      logger.warn('Failed persisting one batch member failure; continuing cleanup', {
        messageId: message.id,
        error: failure,
      });
    }
  }
  if (failures.length) {
    throw new AggregateError(
      failures,
      `Failed handling ${failures.length} dispatch member failures`
    );
  }
}

async function isBatchBoundary(
  message: QueuedMessage,
  isCurrent: () => boolean,
  isHeld?: (message: QueuedMessage) => Promise<boolean>
) {
  return !isCurrent() || isCommand(message) || (await isHeld?.(message));
}
