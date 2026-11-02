import { createLogger } from '@/backend/services/logger.service';
import type { SessionCallerGuard } from '@/backend/services/session/service/bridges';
import type { MailRecoveryRetry } from '@/backend/services/session/service/lifecycle/session-notification-delivery.service';
import { sessionDomainService as domain } from '@/backend/services/session/service/session-domain.service';
import type { QueuedMessage } from '@/shared/acp-protocol';
import type { SessionDispatchNotificationDeliveryService } from './session-dispatch.types';
import type { SessionQueuedSteering } from './session-queued-steering';

const logger = createLogger('workspace-mail-signal-dispatch');

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
    !notifications.isOwnedMailSignal?.(sessionId, messageId, message.text)
  ) {
    return;
  }
  const claim = notifications.claimForDispatch(sessionId, messageId);
  if (claim.status !== 'claimed') {
    return;
  }
  const receipt = notifications.captureMailSignalReceipt?.(sessionId, messageId);
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

export function requeueFailedWorkspaceMailSignal(
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
