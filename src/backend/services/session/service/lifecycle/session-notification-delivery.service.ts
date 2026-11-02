import { createLogger } from '@/backend/services/logger.service';
import type {
  AgentMessage,
  ChatMessage,
  QueuedMessage,
  SessionDeltaEvent,
} from '@/shared/acp-protocol';
import {
  buildWorkspaceNotificationMessageText,
  WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX,
  type WorkspaceNotificationDirection,
  workspaceNotificationMessageId,
} from '@/shared/workspace-notifications';

const lifecycleLogger = createLogger('session');
const chatLogger = createLogger('chat-message-handlers');

export type NotificationDispatchClaim =
  | { status: 'not_notification' }
  | { status: 'duplicate' }
  | { status: 'claimed'; notificationId: string; release(): void };

export type NotificationDispatchState =
  | 'pending'
  | 'delivered'
  | 'held'
  | 'missing'
  | 'unavailable';
export type NotificationDispatchBlockReason =
  | Exclude<NotificationDispatchState, 'pending' | 'missing'>
  | 'duplicate';

function notificationDispatchBlockReason(
  state: NotificationDispatchState
): NotificationDispatchBlockReason | undefined {
  return state === 'pending' || state === 'missing' ? undefined : state;
}

export async function notificationClaimBlockReason(
  notifications: Pick<SessionNotificationDeliveryService, 'getDispatchState'>,
  claim: NotificationDispatchClaim
): Promise<NotificationDispatchBlockReason | undefined> {
  if (claim.status === 'duplicate') {
    return 'duplicate';
  }
  return claim.status === 'claimed'
    ? notificationDispatchBlockReason(await notifications.getDispatchState(claim.notificationId))
    : undefined;
}

export type PendingWorkspaceNotification = Readonly<{
  id: string;
  workspaceId: string;
  sourceWorkspaceId: string;
  sourceWorkspaceName: string;
  sourceProjectName: string;
  message: string;
  direction: WorkspaceNotificationDirection;
  deliveredAt: Date | null;
  createdAt: Date;
}>;

export type NotificationPersistencePort = {
  listPendingForDelivery(workspaceId: string): Promise<PendingWorkspaceNotification[]>;
  findForDelivery(
    notificationId: string
  ): Promise<{ deliveredAt: Date | null; recoveryHeld: boolean } | null>;
  markDelivered(notificationIds: string[]): Promise<void>;
};

export type NotificationQueuePort = {
  hasQueuedMessage(sessionId: string, messageId: string): boolean;
  enqueue(sessionId: string, message: QueuedMessage): { position: number } | { error: string };
  removeQueuedMessage(sessionId: string, messageId: string): boolean;
};

export type NotificationTranscriptPort = {
  getTranscriptSnapshot(sessionId: string): ChatMessage[];
  getHistoryHydrationSource(sessionId: string): 'jsonl' | 'acp_fallback' | 'none' | undefined;
  appendClaudeEvent(sessionId: string, message: AgentMessage): number;
};

export type NotificationDeltaPort = {
  emitDelta(sessionId: string, event: SessionDeltaEvent): void;
};

export type SessionNotificationDeliveryServiceDependencies = {
  isRecoveryHeld?(sessionId: string): Promise<boolean>;
  withRecoveryGate?<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  notificationPort: NotificationPersistencePort;
  queuePort: NotificationQueuePort;
  transcriptPort: NotificationTranscriptPort;
  deltaPort: NotificationDeltaPort;
};

type ActiveDispatchClaim = {
  sessionId: string;
  notificationId: string;
};

export class SessionNotificationDeliveryService {
  private readonly notificationPort: NotificationPersistencePort;
  private readonly queuePort: NotificationQueuePort;
  private readonly transcriptPort: NotificationTranscriptPort;
  private readonly deltaPort: NotificationDeltaPort;
  private readonly dispatchClaims = new Map<string, ActiveDispatchClaim>();
  // A reset transfers dispatch ownership, but the old send can still reject and
  // roll back its provisional transcript entry. Retain that evidence until release.
  private readonly unsettledDispatchClaims = new Set<ActiveDispatchClaim>();

  private readonly isRecoveryHeld;
  private readonly withRecoveryGate;
  constructor(dependencies: SessionNotificationDeliveryServiceDependencies) {
    this.isRecoveryHeld = dependencies.isRecoveryHeld;
    this.withRecoveryGate = dependencies.withRecoveryGate;
    this.notificationPort = dependencies.notificationPort;
    this.queuePort = dependencies.queuePort;
    this.transcriptPort = dependencies.transcriptPort;
    this.deltaPort = dependencies.deltaPort;
  }

  async recoverPending(input: {
    sessionId: string;
    workspaceId: string;
    assertAllowed(): void | Promise<void>;
  }): Promise<{ dispatchableCount: number }> {
    const { sessionId, workspaceId, assertAllowed } = input;
    try {
      if (await this.isRecoveryHeld?.(sessionId)) {
        return { dispatchableCount: 0 };
      }
      const pending = await this.notificationPort.listPendingForDelivery(workspaceId);
      const recover = async () => {
        if (await this.isRecoveryHeld?.(sessionId)) {
          return { dispatchableCount: 0 };
        }
        await assertAllowed();
        if (pending.length === 0) {
          return { dispatchableCount: 0 };
        }

        let enqueuedCount = 0;
        let dispatchableCount = 0;
        for (const notification of pending) {
          const result = await this.recoverNotification(
            sessionId,
            workspaceId,
            notification,
            assertAllowed
          );
          enqueuedCount += Number(result.enqueued);
          dispatchableCount += Number(result.dispatchable);
        }

        lifecycleLogger.info('Queued pending workspace notifications', {
          sessionId,
          workspaceId,
          count: enqueuedCount,
          dispatchableCount,
        });
        return { dispatchableCount };
      };
      return this.withRecoveryGate
        ? await this.withRecoveryGate(sessionId, recover)
        : await recover();
    } catch (error) {
      lifecycleLogger.warn('Failed to deliver pending workspace notifications', {
        sessionId,
        workspaceId,
        error: this.formatError(error),
      });
      return { dispatchableCount: 0 };
    }
  }

  private async recoverNotification(
    sessionId: string,
    workspaceId: string,
    notification: PendingWorkspaceNotification,
    assertAllowed: () => void | Promise<void>
  ) {
    await assertAllowed();
    const messageId = workspaceNotificationMessageId(notification.id);
    if (this.queuePort.hasQueuedMessage(sessionId, messageId)) {
      return { enqueued: false, dispatchable: true };
    }

    const messageText = buildWorkspaceNotificationMessageText(notification);
    const alreadyDelivered = await this.markDeliveredIfTranscriptMatch({
      sessionId,
      workspaceId,
      notificationId: notification.id,
      messageId,
      messageText,
    });
    await assertAllowed();
    if (alreadyDelivered) {
      return { enqueued: false, dispatchable: false };
    }
    if (this.queuePort.hasQueuedMessage(sessionId, messageId)) {
      return { enqueued: false, dispatchable: true };
    }

    const timestamp = notification.createdAt.toISOString();
    const enqueueResult = this.queuePort.enqueue(sessionId, {
      id: messageId,
      text: messageText,
      timestamp,
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });
    if ('error' in enqueueResult) {
      lifecycleLogger.warn('Failed to enqueue pending workspace notification', {
        sessionId,
        workspaceId,
        notificationId: notification.id,
        error: enqueueResult.error,
      });
      return { enqueued: false, dispatchable: false };
    }
    this.emitWorkspaceUpdateCard(sessionId, notification, timestamp);
    return { enqueued: true, dispatchable: true };
  }

  claimForDispatch(sessionId: string, messageId: string): NotificationDispatchClaim {
    const notificationId = this.getNotificationId(messageId);
    if (!notificationId) {
      return { status: 'not_notification' };
    }
    if (
      this.dispatchClaims.has(notificationId) ||
      this.isNotificationCommittedToTranscript(sessionId, messageId)
    ) {
      return { status: 'duplicate' };
    }

    const claim = { sessionId, notificationId };
    this.dispatchClaims.set(notificationId, claim);
    this.unsettledDispatchClaims.add(claim);
    return {
      status: 'claimed',
      notificationId,
      release: () => {
        this.unsettledDispatchClaims.delete(claim);
        if (this.dispatchClaims.get(notificationId) === claim) {
          this.dispatchClaims.delete(notificationId);
        }
      },
    };
  }

  async getDispatchState(notificationId: string): Promise<NotificationDispatchState> {
    try {
      const notification = await this.notificationPort.findForDelivery(notificationId);
      if (!notification) {
        return 'missing';
      }
      if (notification.recoveryHeld) {
        return 'held';
      }
      return notification.deliveredAt !== null ? 'delivered' : 'pending';
    } catch (error) {
      chatLogger.warn('[Chat WS] Failed to check workspace notification delivery state', {
        notificationId,
        error: this.formatError(error),
      });
      return 'unavailable';
    }
  }

  async acknowledgeSuccessfulDispatch(messageId: string): Promise<void> {
    const notificationId = this.getNotificationId(messageId);
    if (!notificationId) {
      return;
    }

    try {
      await this.notificationPort.markDelivered([notificationId]);
    } catch (error) {
      chatLogger.warn('[Chat WS] Failed to mark workspace notification delivered', {
        messageId,
        notificationId,
        error: this.formatError(error),
      });
    }
  }

  removeBlockedFromQueue(
    sessionId: string,
    messageId: string,
    reason: NotificationDispatchBlockReason = 'delivered'
  ): boolean {
    chatLogger.info('[Chat WS] Dropping blocked workspace notification', {
      dbSessionId: sessionId,
      messageId,
      reason,
    });
    return this.queuePort.removeQueuedMessage(sessionId, messageId);
  }

  resetSession(sessionId: string): void {
    for (const [notificationId, claim] of this.dispatchClaims) {
      if (claim.sessionId === sessionId) {
        this.dispatchClaims.delete(notificationId);
      }
    }
  }

  isNotificationMessage(messageId: string): boolean {
    return this.getNotificationId(messageId) != null;
  }

  private emitWorkspaceUpdateCard(
    sessionId: string,
    notification: PendingWorkspaceNotification,
    timestamp: string
  ): void {
    const message: AgentMessage =
      notification.direction === 'PARENT_TO_CHILD'
        ? {
            type: 'parent_workspace_update',
            parentWorkspaceId: notification.sourceWorkspaceId,
            parentWorkspaceName: notification.sourceWorkspaceName,
            parentProjectName: notification.sourceProjectName,
            text: notification.message,
            timestamp,
          }
        : {
            type: 'child_workspace_update',
            childWorkspaceId: notification.sourceWorkspaceId,
            childWorkspaceName: notification.sourceWorkspaceName,
            childProjectName: notification.sourceProjectName,
            text: notification.message,
            timestamp,
          };
    const order = this.transcriptPort.appendClaudeEvent(sessionId, message);
    this.deltaPort.emitDelta(sessionId, {
      type: 'agent_message',
      data: message,
      order,
    } as SessionDeltaEvent & { order: number });
  }

  private hasCommittedNotificationMatch(
    sessionId: string,
    messageId: string,
    messageText: string
  ): boolean {
    const userEntries = this.transcriptPort
      .getTranscriptSnapshot(sessionId)
      .filter(
        (entry) => entry.source === 'user' && !this.isTranscriptMessageInFlight(sessionId, entry.id)
      );
    if (userEntries.some((entry) => entry.id === messageId)) {
      return true;
    }
    if (this.transcriptPort.getHistoryHydrationSource(sessionId) !== 'jsonl') {
      return false;
    }
    // Canonical text includes this notification's unique receipt marker, including in a combined prompt.
    return userEntries.some(
      (entry) =>
        !entry.id.startsWith(WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX) &&
        Boolean(entry.text?.includes(messageText))
    );
  }

  private async markDeliveredIfTranscriptMatch(input: {
    sessionId: string;
    workspaceId: string;
    notificationId: string;
    messageId: string;
    messageText: string;
  }): Promise<boolean> {
    if (!this.hasCommittedNotificationMatch(input.sessionId, input.messageId, input.messageText)) {
      return false;
    }
    await this.markDeliveredAfterTranscriptMatch(
      input.sessionId,
      input.workspaceId,
      input.notificationId
    );
    return true;
  }

  private async markDeliveredAfterTranscriptMatch(
    sessionId: string,
    workspaceId: string,
    notificationId: string
  ): Promise<void> {
    try {
      await this.notificationPort.markDelivered([notificationId]);
    } catch (error) {
      lifecycleLogger.warn('Failed to mark already-transcripted workspace notification delivered', {
        sessionId,
        workspaceId,
        notificationId,
        error: this.formatError(error),
      });
    }
  }

  private isTranscriptMessageInFlight(sessionId: string, messageId: string): boolean {
    const notificationId = this.getNotificationId(messageId);
    return [...this.unsettledDispatchClaims].some(
      (claim) => claim.sessionId === sessionId && claim.notificationId === notificationId
    );
  }

  private isNotificationCommittedToTranscript(sessionId: string, messageId: string): boolean {
    if (this.isTranscriptMessageInFlight(sessionId, messageId)) {
      return false;
    }
    return this.transcriptPort
      .getTranscriptSnapshot(sessionId)
      .some((entry) => entry.source === 'user' && entry.id === messageId);
  }

  private getNotificationId(messageId: string): string | null {
    if (!messageId.startsWith(WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX)) {
      return null;
    }
    const notificationId = messageId.slice(WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX.length);
    return notificationId || null;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
