import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import type { SessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import type { SessionLifecycleService } from '@/backend/services/session/service/lifecycle/session.lifecycle.service';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import type { ChatMessageInput } from '@/shared/websocket';

export interface SessionCommandContext {
  sessionId: string;
  workingDir: string;
}

const sessionCommandTypes = [
  'set_model',
  'set_config_option',
  'set_thinking_budget',
  'permission_response',
  'start',
  'stop',
  'user_input',
  'queue_message',
  'remove_queued_message',
  'resume_queued_messages',
] as const satisfies readonly ChatMessageInput['type'][];

export type SessionCommandMessage = Extract<
  ChatMessageInput,
  { type: (typeof sessionCommandTypes)[number] }
>;

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
  /** The command chooses the confirmed rollback value; the adapter delivers it after requester replies. */
  configOptionsCorrection?: [SessionConfigOption, ...SessionConfigOption[]];
}

export type SessionCommandHandler<T extends SessionCommandMessage> = (
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
  setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void>;
  getSessionConfigOptions(sessionId: string): SessionConfigOption[];
}

export function isSessionCommandMessage(
  message: ChatMessageInput
): message is SessionCommandMessage {
  return sessionCommandTypes.some((type) => type === message.type);
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
