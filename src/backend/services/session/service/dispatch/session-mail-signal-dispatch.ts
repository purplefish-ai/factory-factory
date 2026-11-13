import { WorkspaceInitFenceError } from '@/backend/lib/workspace-init-fence-error';
import { createLogger } from '@/backend/services/logger.service';
import { AcpSteeringNotSentError } from '@/backend/services/session/service/acp/acp-steering';
import type { SessionCallerGuard } from '@/backend/services/session/service/bridges';
import type {
  MailRecoveryRetry,
  MailSignalReceipt,
} from '@/backend/services/session/service/delivery/session-notification-delivery.service';
import {
  isTurnAlreadyInProgressError,
  toErrorMessage,
} from '@/backend/services/session/service/errors/session.error-message';
import { EventSessionFenceError } from '@/backend/services/session/service/event-agent/event-session-fence-error';
import { sessionDomainService as domain } from '@/backend/services/session/service/store/session-domain.service';
import type { QueuedMessage } from '@/shared/acp-protocol';
import type { SessionDispatchNotificationDeliveryService } from './session-dispatch.types';
import type { SessionQueuedSteering } from './session-queued-steering';

const logger = createLogger('workspace-mail-signal-dispatch');

/** Use only for caller checks performed before the provider prompt RPC. */
export function wrapUnsentDispatchGuard(
  guard?: SessionCallerGuard
): SessionCallerGuard | undefined {
  if (!guard) {
    return undefined;
  }
  return {
    check: async () => {
      try {
        await guard.check();
      } catch (error) {
        throw classifyProvenUnsentFailure(error);
      }
    },
    assertCurrent: () => {
      try {
        guard.assertCurrent?.();
      } catch (error) {
        throw classifyProvenUnsentFailure(error);
      }
    },
  };
}

/** The exact body-free signal and session ownership are checked before steering. */
export async function steerOwnedWorkspaceMailSignal(
  sessionId: string,
  messageId: string,
  notifications: SessionDispatchNotificationDeliveryService,
  steering: SessionQueuedSteering
): Promise<void> {
  const message = domain.getQueueSnapshot(sessionId).find((item) => item.id === messageId);
  if (
    !message ||
    message.attachments?.length ||
    !notifications.isOwnedMailSignal(sessionId, messageId, message.text)
  ) {
    return;
  }
  const claim = notifications.claimForDispatch(sessionId, messageId);
  if (claim.status !== 'claimed') {
    return;
  }
  const receipt = notifications.captureMailSignalReceipt(sessionId, messageId, message);
  if (!receipt) {
    claim.release();
    return;
  }
  try {
    await steering.steerMailSignal(
      sessionId,
      messageId,
      async () => {
        try {
          return await receipt.accept();
        } catch (error) {
          logger.warn('Mail signal provider receipt recovery deferred', { sessionId, error });
          return false;
        }
      },
      () => claim.release(),
      receipt
    );
  } finally {
    claim.release();
  }
}

/** Fence every mail claim in a queued prompt before any provider acceptance is possible. */
export async function sendArmedWorkspaceMailBatch(input: {
  sessionId: string;
  messages: QueuedMessage[];
  notifications: SessionDispatchNotificationDeliveryService;
  assertCurrent(): void;
  send(): Promise<void>;
}): Promise<void> {
  const receipts: MailSignalReceipt[] = [];
  let attempted = false;
  try {
    await armBatchMailReceipts(input.sessionId, input.messages, input.notifications, receipts);
    input.assertCurrent();
    attempted = true;
    await input.send();
  } catch (error) {
    for (const receipt of receipts) {
      if (!attempted || isKnownUnsentDispatchFailure(error)) {
        await disarmUnsentMailReceipt(input.sessionId, receipt);
      } else {
        receipt.quarantine();
      }
    }
    throw !attempted ? classifyProvenUnsentFailure(error) : error;
  }
  // Receipt persistence failures cannot turn an accepted provider prompt into a retry.
  for (const receipt of receipts) {
    try {
      await receipt.accept();
    } catch (error) {
      logger.warn('Mail signal provider receipt recovery deferred', {
        sessionId: input.sessionId,
        error,
      });
    }
  }
}

async function armBatchMailReceipts(
  sessionId: string,
  messages: QueuedMessage[],
  notifications: SessionDispatchNotificationDeliveryService,
  receipts: MailSignalReceipt[]
): Promise<void> {
  for (const message of messages.filter((item) => item.id.startsWith('workspace-mail-wake-'))) {
    const receipt = notifications.captureMailSignalReceipt(sessionId, message.id, message);
    if (!receipt) {
      throw new AcpSteeringNotSentError('Mail wake attempt no longer owns its durable claim');
    }
    receipts.push(receipt);
    if (!(await receipt.arm())) {
      throw new AcpSteeringNotSentError('Mail wake attempt no longer owns its durable claim');
    }
  }
}

export function isKnownUnsentDispatchFailure(error: unknown): boolean {
  return (
    error instanceof AcpSteeringNotSentError ||
    error instanceof WorkspaceInitFenceError ||
    error instanceof EventSessionFenceError ||
    isTurnAlreadyInProgressError(error)
  );
}

function classifyProvenUnsentFailure(error: unknown): unknown {
  return isKnownUnsentDispatchFailure(error)
    ? error
    : new AcpSteeringNotSentError(toErrorMessage(error), { cause: error });
}

export function reportAmbiguousWorkspaceMailFailure(
  sessionId: string,
  message: QueuedMessage,
  error: unknown,
  recordRuntimeError: () => void
): void {
  domain.removeTranscriptMessageById(sessionId, message.id, { emitSnapshot: false });
  logger.warn('Mail signal delivery is ambiguous; explicit retry required', {
    sessionId,
    messageId: message.id,
    error,
  });
  domain.emitDelta(sessionId, {
    type: 'error',
    message:
      'Workspace mail delivery could not be confirmed. Inspect the inbox before retrying the wake.',
  });
  recordRuntimeError();
}

async function disarmUnsentMailReceipt(
  sessionId: string,
  receipt: MailSignalReceipt
): Promise<void> {
  try {
    if (await receipt.disarm()) {
      return;
    }
  } catch (error) {
    logger.warn('Mail signal attempt could not be disarmed', { sessionId, error });
  }
  receipt.quarantine();
}

export function mailRecoveryRetryGuard(
  input: MailRecoveryRetry,
  isCurrent: () => boolean
): SessionCallerGuard {
  return {
    check: async () => {
      await input.assertAllowed();
    },
    assertCurrent: () => {
      input.assertAllowedSync?.();
      if (!isCurrent()) {
        throw new Error('Session stopped before mail retry');
      }
    },
  };
}

export function requeueProvenUnsentMessage(
  sessionId: string,
  message: QueuedMessage,
  isRunning: boolean,
  retry: () => void
): void {
  domain.removeTranscriptMessageById(sessionId, message.id, { emitSnapshot: false });
  domain.requeueFront(sessionId, message);
  if (isRunning) {
    domain.markIdle(sessionId, 'alive');
  }
  retry();
}
