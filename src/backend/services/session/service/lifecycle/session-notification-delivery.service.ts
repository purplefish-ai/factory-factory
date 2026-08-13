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
  findForDelivery(notificationId: string): Promise<{ deliveredAt: Date | null } | null>;
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
  notificationPort: NotificationPersistencePort;
  queuePort: NotificationQueuePort;
  transcriptPort: NotificationTranscriptPort;
  deltaPort: NotificationDeltaPort;
};

type CommittedNotificationMatch = {
  id: string;
  matchedByContent: boolean;
};

export class SessionNotificationDeliveryService {
  private readonly notificationPort: NotificationPersistencePort;
  private readonly queuePort: NotificationQueuePort;
  private readonly transcriptPort: NotificationTranscriptPort;
  private readonly deltaPort: NotificationDeltaPort;
  private readonly dispatchClaims = new Map<string, string>();

  constructor(dependencies: SessionNotificationDeliveryServiceDependencies) {
    this.notificationPort = dependencies.notificationPort;
    this.queuePort = dependencies.queuePort;
    this.transcriptPort = dependencies.transcriptPort;
    this.deltaPort = dependencies.deltaPort;
  }

  async recoverPending(input: {
    sessionId: string;
    workspaceId: string;
    assertAllowed(): void;
  }): Promise<{ dispatchableCount: number }> {
    const { sessionId, workspaceId, assertAllowed } = input;
    try {
      const pending = await this.notificationPort.listPendingForDelivery(workspaceId);
      assertAllowed();
      if (pending.length === 0) {
        return { dispatchableCount: 0 };
      }

      let enqueuedCount = 0;
      let dispatchableCount = 0;
      const consumedContentMatchIds = new Set<string>();
      for (const notification of pending) {
        assertAllowed();
        const messageId = workspaceNotificationMessageId(notification.id);
        if (this.queuePort.hasQueuedMessage(sessionId, messageId)) {
          dispatchableCount += 1;
          continue;
        }

        const messageText = buildWorkspaceNotificationMessageText(notification);
        const alreadyDelivered = await this.markDeliveredIfTranscriptMatch({
          sessionId,
          workspaceId,
          notificationId: notification.id,
          messageId,
          messageText,
          consumedContentMatchIds,
        });
        assertAllowed();
        if (alreadyDelivered) {
          continue;
        }
        if (this.queuePort.hasQueuedMessage(sessionId, messageId)) {
          dispatchableCount += 1;
          continue;
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
          continue;
        }

        enqueuedCount += 1;
        dispatchableCount += 1;
        this.emitWorkspaceUpdateCard(sessionId, notification, timestamp);
      }

      lifecycleLogger.info('Queued pending workspace notifications', {
        sessionId,
        workspaceId,
        count: enqueuedCount,
        dispatchableCount,
      });
      return { dispatchableCount };
    } catch (error) {
      lifecycleLogger.warn('Failed to deliver pending workspace notifications', {
        sessionId,
        workspaceId,
        error: this.formatError(error),
      });
      return { dispatchableCount: 0 };
    }
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

    this.dispatchClaims.set(notificationId, sessionId);
    return {
      status: 'claimed',
      notificationId,
      release: () => {
        if (this.dispatchClaims.get(notificationId) === sessionId) {
          this.dispatchClaims.delete(notificationId);
        }
      },
    };
  }

  async isAlreadyDelivered(notificationId: string): Promise<boolean> {
    try {
      const notification = await this.notificationPort.findForDelivery(notificationId);
      return notification?.deliveredAt != null;
    } catch (error) {
      chatLogger.warn('[Chat WS] Failed to check workspace notification delivery state', {
        notificationId,
        error: this.formatError(error),
      });
      return false;
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

  removeDuplicateFromQueue(sessionId: string, messageId: string): boolean {
    chatLogger.info('[Chat WS] Dropping already-delivered workspace notification', {
      dbSessionId: sessionId,
      messageId,
    });
    return this.queuePort.removeQueuedMessage(sessionId, messageId);
  }

  resetSession(sessionId: string): void {
    for (const [notificationId, ownerSessionId] of this.dispatchClaims) {
      if (ownerSessionId === sessionId) {
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

  private findCommittedNotificationMatch(
    sessionId: string,
    messageId: string,
    messageText: string,
    consumedContentMatchIds: ReadonlySet<string>
  ): CommittedNotificationMatch | undefined {
    const userEntries = this.transcriptPort
      .getTranscriptSnapshot(sessionId)
      .filter((entry) => entry.source === 'user');
    const exactIdMatch = userEntries.find((entry) => entry.id === messageId);
    if (exactIdMatch) {
      return { id: exactIdMatch.id, matchedByContent: false };
    }
    if (this.transcriptPort.getHistoryHydrationSource(sessionId) !== 'jsonl') {
      return undefined;
    }
    const contentMatch = userEntries.find(
      (entry) =>
        !entry.id.startsWith(WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX) &&
        entry.text === messageText &&
        !consumedContentMatchIds.has(entry.id)
    );
    return contentMatch ? { id: contentMatch.id, matchedByContent: true } : undefined;
  }

  private async markDeliveredIfTranscriptMatch(input: {
    sessionId: string;
    workspaceId: string;
    notificationId: string;
    messageId: string;
    messageText: string;
    consumedContentMatchIds: Set<string>;
  }): Promise<boolean> {
    const committedMessage = this.findCommittedNotificationMatch(
      input.sessionId,
      input.messageId,
      input.messageText,
      input.consumedContentMatchIds
    );
    if (!committedMessage) {
      return false;
    }
    if (committedMessage.matchedByContent) {
      input.consumedContentMatchIds.add(committedMessage.id);
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

  private isNotificationCommittedToTranscript(sessionId: string, messageId: string): boolean {
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
