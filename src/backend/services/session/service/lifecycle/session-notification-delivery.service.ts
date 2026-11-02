import { createLogger } from '@/backend/services/logger.service';
import type {
  AgentMessage,
  ChatMessage,
  QueuedMessage,
  SessionDeltaEvent,
} from '@/shared/acp-protocol';
import {
  WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX,
  type WorkspaceNotificationDirection,
} from '@/shared/workspace-notifications';

const lifecycleLogger = createLogger('session');
const chatLogger = createLogger('chat-message-handlers');
export const WORKSPACE_MAIL_WAKE_PREFIX = 'workspace-mail-wake-';
export type MailWakeClaim = { workspaceId: string; revision: number; claimId: string };

export function workspaceMailWakeId(wake: Pick<MailWakeClaim, 'workspaceId' | 'revision'>): string {
  return `${WORKSPACE_MAIL_WAKE_PREFIX}${wake.workspaceId}:${wake.revision}`;
}

export function buildWorkspaceMailSignal(
  wake: Pick<MailWakeClaim, 'workspaceId' | 'revision'>
): string {
  return `You have workspace mail (revision ${wake.revision}). Use list_mail to inspect summaries, read_mail for selected bodies, and ack_mail with the observed revision after inspection. Mail acknowledgement is separate from task completion.\n\n<!-- ${workspaceMailWakeId(wake)} -->`;
}

export type MailSignalReceipt = {
  arm(): Promise<boolean>;
  disarm(): Promise<boolean>;
  accept(): Promise<boolean>;
  quarantine(): void;
};

export type NotificationDispatchClaim =
  | { status: 'not_notification' }
  | { status: 'duplicate' }
  | { status: 'quarantined' }
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
  claimWake?(input: { workspaceId: string }): Promise<MailWakeClaim | null>;
  settleWake?(input: MailWakeClaim): Promise<boolean>;
  releaseWake?(input: MailWakeClaim): Promise<void>;
  quarantineWake?(input: MailWakeClaim): Promise<boolean>;
  disarmWake?(input: MailWakeClaim): Promise<boolean>;
  nextWakeRetryAt?(input: { workspaceId: string }): Promise<Date | null>;
  listPendingForDelivery(workspaceId: string): Promise<PendingWorkspaceNotification[]>;
  findForDelivery(notificationId: string): Promise<{ deliveredAt: Date | null } | null>;
  markDelivered(notificationIds: string[]): Promise<void>;
};

export type NotificationQueuePort = {
  hasQueuedMessage(sessionId: string, messageId: string): boolean;
  enqueue(sessionId: string, message: QueuedMessage): { position: number } | { error: string };
  removeQueuedMessage(
    sessionId: string,
    messageId: string,
    options?: { expectedMessage?: QueuedMessage }
  ): boolean;
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

type MailRecoveryInput = {
  sessionId: string;
  workspaceId: string;
  assertAllowed(): void | Promise<void>;
  assertAllowedSync?(): void;
  preferSession?: boolean;
};

export type MailRecoveryRetry = {
  sessionId: string;
  retryAt: Date;
  assertAllowed(): void | Promise<void>;
  assertAllowedSync?(): void;
};

type ActiveDispatchClaim = {
  sessionId: string;
  notificationId: string;
};

export class SessionNotificationDeliveryService {
  private readonly notificationPort: NotificationPersistencePort;
  private readonly queuePort: NotificationQueuePort;
  private readonly transcriptPort: NotificationTranscriptPort;
  private retry: ((input: MailRecoveryRetry) => void) | undefined;
  private readonly mailWakes = new Map<string, { wake: MailWakeClaim; sessionId: string }>();
  private readonly ambiguousSignals = new Set<string>();
  private readonly preferredRecipients = new Map<string, MailRecoveryInput>();
  private readonly sessionWorkspaces = new Map<string, string>();
  private readonly recovering = new Map<string, Promise<{ dispatchableCount: number }>>();
  private readonly dispatchClaims = new Map<string, ActiveDispatchClaim>();
  // A reset transfers dispatch ownership, but the old send can still reject and
  // roll back its provisional transcript entry. Retain that evidence until release.
  private readonly unsettledDispatchClaims = new Set<ActiveDispatchClaim>();

  constructor(dependencies: SessionNotificationDeliveryServiceDependencies) {
    this.notificationPort = dependencies.notificationPort;
    this.queuePort = dependencies.queuePort;
    this.transcriptPort = dependencies.transcriptPort;
  }

  configureRetry(retry: (input: MailRecoveryRetry) => void): void {
    this.retry = retry;
  }

  async recoverPending(input: MailRecoveryInput): Promise<{ dispatchableCount: number }> {
    if (input.preferSession) {
      this.preferredRecipients.set(input.workspaceId, input);
      for (const [sessionId, workspaceId] of this.sessionWorkspaces) {
        if (workspaceId === input.workspaceId && sessionId !== input.sessionId) {
          this.sessionWorkspaces.delete(sessionId);
        }
      }
    }
    this.sessionWorkspaces.set(input.sessionId, input.workspaceId);
    const active = this.recovering.get(input.workspaceId);
    if (active !== undefined) {
      await active;
      await input.assertAllowed();
      input.assertAllowedSync?.();
      if (input.preferSession && this.preferredRecipients.get(input.workspaceId) === input) {
        return this.recoverPending(input);
      }
      return { dispatchableCount: 0 };
    }
    const recovery = this.recoverMail(input);
    this.recovering.set(input.workspaceId, recovery);
    try {
      return await recovery;
    } finally {
      if (this.recovering.get(input.workspaceId) === recovery) {
        this.recovering.delete(input.workspaceId);
      }
    }
  }

  async recoverSession(
    sessionId: string,
    assertAllowed: () => void | Promise<void>
  ): Promise<void> {
    const workspaceId = this.sessionWorkspaces.get(sessionId);
    if (workspaceId) {
      await this.recoverPending({ sessionId, workspaceId, assertAllowed });
    }
  }

  private async recoverMail(input: MailRecoveryInput): Promise<{ dispatchableCount: number }> {
    let owned: MailWakeClaim | null = null;
    try {
      const existing = await this.recoverExistingMail(input);
      if (existing) {
        return existing;
      }
      // Older test/integration ports may omit the mail facade. Fail closed: never
      // recover legacy notification bodies into a provider prompt.
      owned = (await this.notificationPort.claimWake?.({ workspaceId: input.workspaceId })) ?? null;
      await input.assertAllowed();
      if (!owned) {
        const retryAt = await this.notificationPort.nextWakeRetryAt?.({
          workspaceId: input.workspaceId,
        });
        if (retryAt) {
          this.retry?.({ ...input, retryAt });
        }
        return { dispatchableCount: 0 };
      }
      return await this.queueMailWake(input, owned);
    } catch (error) {
      if (owned) {
        this.mailWakes.delete(workspaceMailWakeId(owned));
        try {
          await this.notificationPort.releaseWake?.(owned);
        } catch {
          /* Lease expiry retains retryability. */
        }
      }
      this.retry?.({ ...input, retryAt: new Date(Date.now() + 1000) });
      lifecycleLogger.warn('Failed to recover workspace mail signal', {
        sessionId: input.sessionId,
        error: this.formatError(error),
      });
      return { dispatchableCount: 0 };
    }
  }

  private async recoverExistingMail(
    input: MailRecoveryInput
  ): Promise<{ dispatchableCount: number } | null> {
    for (const [id, existing] of this.mailWakes) {
      if (existing.wake.workspaceId !== input.workspaceId) {
        continue;
      }
      await input.assertAllowed();
      if (this.isTranscriptMessageInFlight(existing.sessionId, id)) {
        return { dispatchableCount: 0 };
      }
      if (this.ambiguousSignals.has(id)) {
        return this.recoverAmbiguousWake(input, existing.sessionId, id);
      }
      if (this.queuePort.hasQueuedMessage(existing.sessionId, id)) {
        return this.recoverQueuedMail(input, id, existing);
      }
      await this.notificationPort.releaseWake?.(existing.wake);
      this.mailWakes.delete(id);
    }
    return null;
  }

  private async recoverQueuedMail(
    input: MailRecoveryInput,
    id: string,
    existing: { wake: MailWakeClaim; sessionId: string }
  ): Promise<{ dispatchableCount: number }> {
    const preferred = this.preferredRecipients.get(input.workspaceId);
    if (existing.sessionId !== input.sessionId && preferred?.sessionId === input.sessionId) {
      await preferred.assertAllowed();
      preferred.assertAllowedSync?.();
      await input.assertAllowed();
      input.assertAllowedSync?.();
      if (this.isTranscriptMessageInFlight(existing.sessionId, id)) {
        return { dispatchableCount: 0 };
      }
      this.queuePort.removeQueuedMessage(existing.sessionId, id);
      return await this.queueMailWake(input, existing.wake);
    }
    return { dispatchableCount: existing.sessionId === input.sessionId ? 1 : 0 };
  }

  private async recoverAmbiguousWake(
    input: MailRecoveryInput,
    previousSessionId: string,
    id: string
  ): Promise<{ dispatchableCount: number }> {
    const claim = await this.notificationPort.claimWake?.({ workspaceId: input.workspaceId });
    try {
      await input.assertAllowed();
      input.assertAllowedSync?.();
    } catch (error) {
      if (claim) {
        await this.notificationPort.releaseWake?.(claim);
      }
      throw error;
    }
    if (!claim) {
      return { dispatchableCount: 0 };
    }
    this.queuePort.removeQueuedMessage(previousSessionId, id);
    this.mailWakes.delete(id);
    this.ambiguousSignals.delete(id);
    return this.queueMailWake(input, claim);
  }

  private async queueMailWake(
    input: MailRecoveryInput,
    owned: MailWakeClaim
  ): Promise<{ dispatchableCount: number }> {
    const id = workspaceMailWakeId(owned);
    const text = buildWorkspaceMailSignal(owned);
    if (this.hasCommittedNotificationMatch(input.sessionId, id, text)) {
      await this.notificationPort.settleWake?.(owned);
      return { dispatchableCount: 0 };
    }
    this.mailWakes.set(id, { wake: owned, sessionId: input.sessionId });
    if (!this.queuePort.hasQueuedMessage(input.sessionId, id)) {
      const result = this.queuePort.enqueue(input.sessionId, {
        id,
        text,
        timestamp: new Date().toISOString(),
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      });
      if ('error' in result) {
        this.mailWakes.delete(id);
        await this.notificationPort.releaseWake?.(owned);
        this.retry?.({ ...input, retryAt: new Date(Date.now() + 1000) });
        return { dispatchableCount: 0 };
      }
    }
    return { dispatchableCount: 1 };
  }

  isOwnedMailSignal(sessionId: string, messageId: string, text: string): boolean {
    const owned = this.mailWakes.get(messageId);
    return (
      !this.ambiguousSignals.has(messageId) &&
      owned?.sessionId === sessionId &&
      text === buildWorkspaceMailSignal(owned.wake)
    );
  }

  captureMailSignalReceipt(
    sessionId: string,
    messageId: string,
    expectedMessage?: QueuedMessage
  ): MailSignalReceipt | null {
    const owned = this.mailWakes.get(messageId);
    if (owned?.sessionId !== sessionId) {
      return null;
    }
    const { wake } = owned;
    return {
      arm: async () => (await this.notificationPort.quarantineWake?.(wake)) ?? false,
      disarm: async () => (await this.notificationPort.disarmWake?.(wake)) ?? false,
      accept: async () => {
        const settled = (await this.notificationPort.settleWake?.(wake)) ?? false;
        if (settled && this.mailWakes.get(messageId)?.wake.claimId === wake.claimId) {
          this.mailWakes.delete(messageId);
          this.ambiguousSignals.delete(messageId);
        }
        return settled;
      },
      quarantine: () => {
        if (this.mailWakes.get(messageId)?.wake.claimId !== wake.claimId) {
          return;
        }
        this.ambiguousSignals.add(messageId);
        this.queuePort.removeQueuedMessage(
          sessionId,
          messageId,
          ...(expectedMessage ? [{ expectedMessage }] : [])
        );
      },
    };
  }

  isMailSignalQuarantined(messageId: string): boolean {
    return this.ambiguousSignals.has(messageId);
  }

  claimForDispatch(sessionId: string, messageId: string): NotificationDispatchClaim {
    const notificationId = this.getNotificationId(messageId);
    if (this.ambiguousSignals.has(messageId)) {
      return { status: 'quarantined' };
    }
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

  async isAlreadyDelivered(notificationId: string): Promise<boolean> {
    if (notificationId.startsWith(WORKSPACE_MAIL_WAKE_PREFIX)) {
      return false;
    }
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
    const mail = this.mailWakes.get(messageId);
    if (mail) {
      // A provider receipt closes the wake latch; only ack_mail acknowledges rows.
      await this.notificationPort.settleWake?.(mail.wake);
      this.mailWakes.delete(messageId);
      return;
    }
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
    const workspaceId = this.sessionWorkspaces.get(sessionId);
    this.sessionWorkspaces.delete(sessionId);
    if (workspaceId && this.preferredRecipients.get(workspaceId)?.sessionId === sessionId) {
      this.preferredRecipients.delete(workspaceId);
    }
    for (const [notificationId, claim] of this.dispatchClaims) {
      if (claim.sessionId === sessionId) {
        this.dispatchClaims.delete(notificationId);
      }
    }
  }

  isNotificationMessage(messageId: string): boolean {
    return this.getNotificationId(messageId) != null;
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
    if (messageId.startsWith(WORKSPACE_MAIL_WAKE_PREFIX)) {
      return messageId;
    }
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
