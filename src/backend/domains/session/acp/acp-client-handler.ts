import type {
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { sessionFileLogger } from '@/backend/domains/session/logging/session-file-logger.service';
import type { createLogger } from '@/backend/services/logger.service';

export type AcpEventCallback = (sessionId: string, event: unknown) => void;

export class AcpClientHandler implements Client {
  private readonly sessionId: string;
  private readonly onEvent: AcpEventCallback;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(
    sessionId: string,
    onEvent: AcpEventCallback,
    logger: ReturnType<typeof createLogger>
  ) {
    this.sessionId = sessionId;
    this.onEvent = onEvent;
    this.logger = logger;
  }

  // biome-ignore lint/suspicious/useAwait: async required by Client interface contract
  async sessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update;

    // Log ALL events to session file logger (EVENT-06)
    sessionFileLogger.log(this.sessionId, 'FROM_CLAUDE_CLI', {
      eventType: 'acp_session_update',
      sessionUpdate: update.sessionUpdate,
      data: update,
    });

    // Forward actionable events to session domain for WebSocket push
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.onEvent(this.sessionId, {
          type: 'acp_agent_message_chunk',
          content: update.content,
        });
        break;

      case 'tool_call':
        this.onEvent(this.sessionId, {
          type: 'acp_tool_call',
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: update.status,
        });
        break;

      case 'tool_call_update':
        this.onEvent(this.sessionId, {
          type: 'acp_tool_call_update',
          toolCallId: update.toolCallId,
          status: update.status,
          content: update.content,
        });
        break;

      // Phase 19: Log but do not render these yet
      // Phase 20 handles full event translation
      case 'agent_thought_chunk':
      case 'plan':
      case 'available_commands_update':
      case 'config_option_update':
      case 'current_mode_update':
      case 'session_info_update':
      case 'usage_update':
      case 'user_message_chunk':
        this.logger.debug('ACP session update (deferred to Phase 20)', {
          sessionId: this.sessionId,
          updateType: update.sessionUpdate,
        });
        break;

      default:
        this.logger.warn('Unknown ACP session update type', {
          sessionId: this.sessionId,
          update,
        });
    }
  }

  // biome-ignore lint/suspicious/useAwait: async required by Client interface contract
  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.logger.debug('ACP permission request (auto-approving)', {
      sessionId: this.sessionId,
      optionCount: params.options.length,
      toolCallId: params.toolCall.toolCallId,
    });

    // Log permission request to session file logger
    sessionFileLogger.log(this.sessionId, 'FROM_CLAUDE_CLI', {
      eventType: 'acp_permission_request',
      toolCallId: params.toolCall.toolCallId,
      options: params.options.map((o) => ({ optionId: o.optionId, kind: o.kind, name: o.name })),
    });

    // Phase 19: Auto-approve with first allow option
    // Phase 20 adds full permission UI with option selection
    const allowOption = params.options.find(
      (o) => o.kind === 'allow_always' || o.kind === 'allow_once'
    );
    const firstOption = params.options[0];
    const selectedOptionId = allowOption?.optionId ?? firstOption?.optionId ?? 'unknown';

    return {
      outcome: {
        outcome: 'selected',
        optionId: selectedOptionId,
      },
    };
  }
}
