import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
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
] as const satisfies readonly ChatMessageInput['type'][];

export type SessionCommandMessage = Extract<
  ChatMessageInput,
  { type: (typeof sessionCommandTypes)[number] }
>;

export type SessionCommandError =
  | { kind: 'no_session' | 'permission_not_pending' }
  | {
      kind:
        | 'set_model_failed'
        | 'set_config_option_failed'
        | 'set_thinking_budget_failed'
        | 'permission_response_failed';
      cause: unknown;
    };

export type SessionCommandReply =
  | { type: 'chat_capabilities'; capabilities: ChatBarCapabilities }
  | { type: 'error'; error: SessionCommandError };

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
