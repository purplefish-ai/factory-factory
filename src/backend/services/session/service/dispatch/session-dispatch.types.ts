import type { PromptConfigurationPermit } from '@/backend/services/session/service/acp/acp-prompt-configuration';
import type { AcpRuntimeManager } from '@/backend/services/session/service/acp/acp-runtime-manager';
import type { SessionCallerGuard } from '@/backend/services/session/service/bridges';
import type { SessionChatIntentService } from '@/backend/services/session/service/chat/session-chat-intent.service';
import type { SessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import type {
  NotificationDispatchClaim,
  NotificationDispatchState,
  NotificationDispatchBlockReason,
} from '@/backend/services/session/service/lifecycle/session-notification-delivery.service';
import type { SessionConfigService } from '@/backend/services/session/service/lifecycle/session.config.service';
import type { AgentContentItem } from '@/shared/acp-protocol';

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
  }): Promise<{ dispatchableCount: number }>;
  claimForDispatch(sessionId: string, messageId: string): NotificationDispatchClaim;
  getDispatchState(notificationId: string): Promise<NotificationDispatchState>;
  acknowledgeSuccessfulDispatch(messageId: string): Promise<void>;
  removeBlockedFromQueue(
    sessionId: string,
    messageId: string,
    reason?: NotificationDispatchBlockReason
  ): boolean;
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
  chatIntent?: SessionChatIntentService;
  eventAuthority?: { assertOrdinary(sessionId: string): Promise<void> };
  runtimeManager: Pick<AcpRuntimeManager, 'isSessionPromptInFlight' | 'isSessionRunning'>;
  configService: Pick<
    SessionConfigService,
    'configureQueuedMessage' | 'resolveQueuedMessageSettings'
  > &
    Partial<Pick<SessionConfigService, 'withPromptConfiguration'>>;
  promptService: {
    steerSessionMessage(
      sessionId: string,
      content: string | AgentContentItem[]
    ): Promise<{ outcome: 'injected' | 'promptRequired' }>;
    sendSessionMessage(
      sessionId: string,
      content: string | AgentContentItem[],
      guard?: SessionCallerGuard,
      configurationPermit?: PromptConfigurationPermit
    ): Promise<void>;
  };
  backgroundDelivery: Pick<
    SessionBackgroundDeliveryService,
    'prepare' | 'validate' | 'fail' | 'complete'
  >;
}
