import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import type { SessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import type { SessionLifecycleService } from '@/backend/services/session/service/lifecycle/session.lifecycle.service';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { AgentContentItem } from '@/shared/acp-protocol';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import type { ChatMessageInput } from '@/shared/websocket';

export interface SessionCommandContext {
  sessionId: string;
  workingDir: string;
}

export type SessionCommandError =
  | {
      kind:
        | 'no_session'
        | 'permission_not_pending'
        | 'session_not_found'
        | 'workspace_archived'
        | 'no_active_session'
        | 'background_monitoring_required'
        | 'message_not_queued';
    }
  | { kind: 'queue_input_invalid'; reason: string }
  | {
      kind:
        | 'set_model_failed'
        | 'set_config_option_failed'
        | 'set_thinking_budget_failed'
        | 'permission_response_failed'
        | 'start_failed';
      cause: unknown;
    };

export type SessionCommandReply =
  | { type: 'chat_capabilities'; capabilities: ChatBarCapabilities }
  | { type: 'error'; error: SessionCommandError; requestId?: string };

export interface SessionCommandOutcome {
  replies: SessionCommandReply[];
}

export type SessionCommandHandler<T extends ChatMessageInput> = (
  context: SessionCommandContext,
  message: T
) => SessionCommandOutcome | Promise<SessionCommandOutcome>;

export interface SessionPermissionCommandService {
  respondToPermission(
    sessionId: string,
    requestId: string,
    optionId: string,
    answers?: Record<string, string[]>
  ): boolean;
}

export interface SessionModelCommandService {
  setSessionModel(sessionId: string, model?: string): Promise<void>;
  setSessionReasoningEffort(
    sessionId: string,
    reasoningEffort: string | null
  ): Promise<void> | void;
  getChatBarCapabilities(sessionId: string): Promise<ChatBarCapabilities>;
}

export interface SessionCommandConfigService extends SessionModelCommandService {
  setSessionThinkingBudget(sessionId: string, maxTokens: number | null): Promise<void>;
  /** Completes configuration publication, including rejection corrections, before settling. */
  setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void>;
  getSessionConfigOptions(sessionId: string): SessionConfigOption[];
}

/** Execution capabilities; leaf commands neither own the runtime graph nor its transports. */
export interface SessionExecutionCommandServices {
  domain: Pick<
    SessionDomainService,
    'markError' | 'rejectMessage' | 'enqueue' | 'emitDelta' | 'removeQueuedMessage'
  >;
  lifecycle: Pick<SessionLifecycleService, 'getSessionOptions' | 'stopSession'>;
  backgroundDelivery: Pick<SessionBackgroundDeliveryService, 'captureResumeGuard' | 'userResume'>;
  clearPendingRequest(sessionId: string): void;
}

export interface SessionCommandRuntimeManager {
  isSessionRunning(sessionId: string): boolean;
}
export interface SessionCommandPromptService {
  sendSessionMessage(sessionId: string, content: string | AgentContentItem[]): Promise<void>;
}
export type { SessionDispatchStartupService as SessionCommandStartupService } from '@/backend/services/session/service/dispatch/session-dispatch.types';
