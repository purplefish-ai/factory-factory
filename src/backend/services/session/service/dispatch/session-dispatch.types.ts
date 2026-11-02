import type { AcpRuntimeManager } from '@/backend/services/session/service/acp/acp-runtime-manager';
import type { SessionCallerGuard } from '@/backend/services/session/service/bridges';
import type { SessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import type {
  MailRecoveryRetry,
  MailSignalReceipt,
  NotificationDispatchClaim,
} from '@/backend/services/session/service/lifecycle/session-notification-delivery.service';
import type { SessionConfigService } from '@/backend/services/session/service/lifecycle/session.config.service';
import type { AgentContentItem, QueuedMessage } from '@/shared/acp-protocol';

export type DispatchOptions = { bypassTurnInProgressBackoff?: boolean; guard?: SessionCallerGuard };

export interface SessionDispatchStartOptions {
  assertCurrent?: () => Promise<void>;
  assertCurrentSync?: () => void;
  resumePolicy?: 'allow_fallback' | 'require_existing';
  thinkingEnabled?: boolean;
  planModeEnabled?: boolean;
  model?: string;
  reasoningEffort?: string;
}

export interface SessionDispatchLifecycleGate {
  getGeneration(sessionId: string): number;
  isGenerationCurrent(sessionId: string, generation: number): boolean;
  isSessionStopping(sessionId: string): boolean;
}

export interface SessionDispatchStartupService {
  getSessionClient(sessionId: string): unknown | undefined;
  getOrCreateSessionClient(
    sessionId: string,
    options: SessionDispatchStartOptions
  ): Promise<unknown>;
}

export interface SessionDispatchNotificationDeliveryService {
  recoverPending(input: {
    sessionId: string;
    workspaceId: string;
    assertAllowed(): void;
    assertAllowedSync?(): void;
    preferSession?: boolean;
  }): Promise<{ dispatchableCount: number }>;
  configureRetry(retry: (input: MailRecoveryRetry) => void): void;
  recoverSession(sessionId: string, assertAllowed: () => void | Promise<void>): Promise<void>;
  captureMailSignalReceipt(
    sessionId: string,
    messageId: string,
    expectedMessage?: QueuedMessage
  ): MailSignalReceipt | null;
  isMailSignalQuarantined(messageId: string): boolean;
  isOwnedMailSignal(sessionId: string, messageId: string, text: string): boolean;
  claimForDispatch(sessionId: string, messageId: string): NotificationDispatchClaim;
  isAlreadyDelivered(notificationId: string): Promise<boolean>;
  acknowledgeSuccessfulDispatch(messageId: string): Promise<void>;
  removeDuplicateFromQueue(sessionId: string, messageId: string): boolean;
  resetSession(sessionId: string): void;
  isNotificationMessage(messageId: string): boolean;
}

export interface SessionDispatchLifecycleDependencies {
  gate: SessionDispatchLifecycleGate;
  startup: SessionDispatchStartupService;
  notificationDelivery: SessionDispatchNotificationDeliveryService;
}

/** Method-level capabilities supplied by the session composition root. */
export interface SessionDispatchDependencies {
  eventAuthority?: { assertOrdinary(sessionId: string): Promise<void> };
  runtimeManager: Pick<AcpRuntimeManager, 'isSessionPromptInFlight' | 'isSessionRunning'>;
  configService: Pick<
    SessionConfigService,
    'configureQueuedMessage' | 'resolveQueuedMessageSettings'
  >;
  promptService: {
    steerSessionMessage(
      sessionId: string,
      content: string | AgentContentItem[],
      options?: { preserveRuntimeOnTimeout?: boolean; onLateInjected?: () => Promise<void> }
    ): Promise<{ outcome: 'injected' | 'promptRequired' }>;
    sendSessionMessage(
      sessionId: string,
      content: string | AgentContentItem[],
      guard?: SessionCallerGuard
    ): Promise<void>;
  };
  backgroundDelivery: Pick<
    SessionBackgroundDeliveryService,
    'prepare' | 'validate' | 'fail' | 'complete'
  >;
}
