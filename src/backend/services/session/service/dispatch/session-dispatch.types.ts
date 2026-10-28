import type { AcpRuntimeManager } from '@/backend/services/session/service/acp/acp-runtime-manager';
import type { SessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import type { NotificationDispatchClaim } from '@/backend/services/session/service/lifecycle/session-notification-delivery.service';
import type { SessionConfigService } from '@/backend/services/session/service/lifecycle/session.config.service';
import type { AgentContentItem } from '@/shared/acp-protocol';

export type DispatchOptions = { bypassTurnInProgressBackoff?: boolean };

export interface SessionDispatchStartOptions {
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
  runtimeManager: Pick<AcpRuntimeManager, 'isSessionPromptInFlight' | 'isSessionRunning'>;
  configService: Pick<
    SessionConfigService,
    | 'setSessionCollaborationMode'
    | 'setSessionThinkingBudget'
    | 'setSessionModel'
    | 'setSessionReasoningEffort'
  >;
  promptService: {
    sendSessionMessage(sessionId: string, content: string | AgentContentItem[]): Promise<void>;
  };
  backgroundDelivery: Pick<
    SessionBackgroundDeliveryService,
    'prepare' | 'validate' | 'fail' | 'complete'
  >;
}
