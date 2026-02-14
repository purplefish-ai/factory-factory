import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { createLogger } from '@/backend/services/logger.service';
import type { SessionDeltaEvent } from '@/shared/claude';
import type { CommandInfo } from '@/shared/claude/protocol/models';

/**
 * Stateless translator that maps ACP SessionUpdate variants to FF SessionDeltaEvent arrays.
 *
 * Modeled on CodexEventTranslator. Each ACP session update type is mapped to the
 * appropriate FF delta event type(s) that the frontend already knows how to render.
 *
 * Error handling: Never throws. Malformed or missing data produces a warning log
 * and returns an empty array, so one bad event does not break the pipeline.
 */
export class AcpEventTranslator {
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(logger: ReturnType<typeof createLogger>) {
    this.logger = logger;
  }

  translateSessionUpdate(update: SessionUpdate): SessionDeltaEvent[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.translateAgentMessageChunk(update);

      case 'agent_thought_chunk':
        return this.translateAgentThoughtChunk(update);

      case 'tool_call':
        return this.translateToolCall(update);

      case 'tool_call_update':
        return this.translateToolCallUpdate(update);

      case 'plan':
        return this.translatePlan(update);

      case 'available_commands_update':
        return this.translateAvailableCommands(update);

      case 'usage_update':
        return this.translateUsageUpdate(update);

      case 'config_option_update':
        return this.translateConfigOptionUpdate(update);

      // Not yet translated -- log-only
      case 'current_mode_update':
      case 'session_info_update':
      case 'user_message_chunk':
        return [];

      default:
        this.logger.warn('Unknown ACP session update type', {
          sessionUpdate: (update as { sessionUpdate: string }).sessionUpdate,
        });
        return [];
    }
  }

  private translateAgentMessageChunk(
    update: Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' }>
  ): SessionDeltaEvent[] {
    if (!update.content) {
      this.logger.warn('agent_message_chunk: missing content', { update });
      return [];
    }

    if (update.content.type !== 'text') {
      this.logger.warn('agent_message_chunk: non-text content type, skipping', {
        contentType: update.content.type,
      });
      return [];
    }

    const text = (update.content as { type: 'text'; text: string }).text;

    return [
      {
        type: 'agent_message',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text }],
          },
        },
      },
    ];
  }

  private translateAgentThoughtChunk(
    update: Extract<SessionUpdate, { sessionUpdate: 'agent_thought_chunk' }>
  ): SessionDeltaEvent[] {
    if (!update.content) {
      this.logger.warn('agent_thought_chunk: missing content', { update });
      return [];
    }

    if (update.content.type !== 'text') {
      this.logger.warn('agent_thought_chunk: non-text content type, skipping', {
        contentType: update.content.type,
      });
      return [];
    }

    const text = (update.content as { type: 'text'; text: string }).text;

    return [
      {
        type: 'agent_message',
        data: {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: text },
          },
        },
      },
    ];
  }

  private translateToolCall(
    update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>
  ): SessionDeltaEvent[] {
    if (!(update.toolCallId && update.title)) {
      this.logger.warn('tool_call: missing toolCallId or title', {
        toolCallId: update.toolCallId,
        title: update.title,
      });
      return [];
    }

    // Prefer _meta.claudeCode.toolName (the actual tool name) over title
    // (display label that may be generic like "Terminal" or a formatted command string).
    const meta = (update as Record<string, unknown>)._meta as
      | { claudeCode?: { toolName?: string } }
      | undefined;
    const toolName = meta?.claudeCode?.toolName ?? update.title;

    const events: SessionDeltaEvent[] = [
      {
        type: 'agent_message',
        data: {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: update.toolCallId,
              name: toolName,
              input: (update.rawInput as Record<string, unknown>) ?? {},
            },
          },
        },
      },
      {
        type: 'tool_progress',
        tool_use_id: update.toolCallId,
        tool_name: toolName,
        acpLocations: update.locations ?? [],
        acpKind: update.kind ?? undefined,
        acpStatus: update.status ?? undefined,
      } as SessionDeltaEvent,
    ];

    return events;
  }

  private translateToolCallUpdate(
    update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>
  ): SessionDeltaEvent[] {
    if (!update.toolCallId) {
      this.logger.warn('tool_call_update: missing toolCallId', { update });
      return [];
    }

    const event: Record<string, unknown> = {
      type: 'tool_progress',
      tool_use_id: update.toolCallId,
      tool_name: update.title ?? undefined,
      acpStatus: update.status ?? undefined,
      acpKind: update.kind ?? undefined,
      acpLocations: update.locations ?? [],
      acpContent: update.content ?? undefined,
    };

    // Signal completion to existing tool progress tracking
    if (update.status === 'completed' || update.status === 'failed') {
      event.elapsed_time_seconds = 0;
    }

    const events: SessionDeltaEvent[] = [event as SessionDeltaEvent];

    // Emit tool_result so the frontend can pair it with the tool_use (transitions pending → success/error)
    if (update.status === 'completed' || update.status === 'failed') {
      events.push({
        type: 'agent_message',
        data: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: update.toolCallId,
                content: this.extractContentText(update.content),
                ...(update.status === 'failed' ? { is_error: true } : {}),
              },
            ],
          },
        },
      });
    }

    return events;
  }

  private translatePlan(
    update: Extract<SessionUpdate, { sessionUpdate: 'plan' }>
  ): SessionDeltaEvent[] {
    return [
      {
        type: 'task_notification',
        message: JSON.stringify({
          type: 'acp_plan',
          entries: update.entries ?? [],
        }),
      },
    ];
  }

  private translateAvailableCommands(
    update: Extract<SessionUpdate, { sessionUpdate: 'available_commands_update' }>
  ): SessionDeltaEvent[] {
    const slashCommands: CommandInfo[] = (update.availableCommands ?? []).map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      argumentHint: cmd.input?.hint,
    }));

    return [
      {
        type: 'slash_commands',
        slashCommands,
      },
    ];
  }

  private extractContentText(content: unknown): string {
    if (!content) {
      return '';
    }
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter((c): c is { type: 'text'; text: string } => c?.type === 'text')
        .map((c) => c.text)
        .join('\n');
    }
    return JSON.stringify(content);
  }

  private translateConfigOptionUpdate(
    update: Extract<SessionUpdate, { sessionUpdate: 'config_option_update' }>
  ): SessionDeltaEvent[] {
    const configOptions = (update as { configOptions?: unknown[] }).configOptions;
    if (!Array.isArray(configOptions)) {
      this.logger.warn('config_option_update: missing configOptions array', { update });
      return [];
    }

    return [
      {
        type: 'config_options_update',
        configOptions,
      } as SessionDeltaEvent,
    ];
  }

  private translateUsageUpdate(
    update: Extract<SessionUpdate, { sessionUpdate: 'usage_update' }>
  ): SessionDeltaEvent[] {
    return [
      {
        type: 'agent_message',
        data: {
          type: 'result',
          result: update,
        },
      },
    ];
  }
}
