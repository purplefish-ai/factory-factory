import type { SessionDeltaEvent } from '@/shared/claude';

export interface CodexDeltaMessage {
  kind:
    | 'assistant_text'
    | 'thinking'
    | 'tool_call'
    | 'tool_result'
    | 'completion'
    | 'system'
    | 'provider_event';
  text?: string;
  toolUseId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  payload?: unknown;
  providerStatus?: string;
}

function addOrder<T extends SessionDeltaEvent>(event: T, order?: number): T {
  if (order === undefined) {
    return event;
  }
  return { ...event, order } as T;
}

function createAssistantDelta(
  text: string,
  mode: 'text' | 'thinking',
  order?: number
): SessionDeltaEvent {
  return addOrder(
    {
      type: 'agent_message',
      data: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content:
            mode === 'text' ? [{ type: 'text', text }] : [{ type: 'thinking', thinking: text }],
        },
      },
    },
    order
  );
}

function createToolCallDelta(message: CodexDeltaMessage, order?: number): SessionDeltaEvent {
  return addOrder(
    {
      type: 'agent_message',
      data: {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: message.toolUseId ?? 'codex-tool',
            name: message.toolName ?? 'codex_tool',
            input: message.input ?? {},
          },
        },
      },
    },
    order
  );
}

function createToolResultDelta(message: CodexDeltaMessage, order?: number): SessionDeltaEvent {
  return addOrder(
    {
      type: 'agent_message',
      data: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolUseId ?? 'codex-tool',
              content: message.text ?? JSON.stringify(message.payload ?? {}),
            },
          ],
        },
      },
    },
    order
  );
}

function createCompletionDelta(message: CodexDeltaMessage, order?: number): SessionDeltaEvent {
  return addOrder(
    {
      type: 'agent_message',
      data: {
        type: 'result',
        result: (message.payload as Record<string, unknown> | undefined) ?? {},
      },
    },
    order
  );
}

function createProviderEventDelta(message: CodexDeltaMessage, order?: number): SessionDeltaEvent {
  return addOrder(
    {
      type: 'agent_message',
      data: {
        type: 'system',
        subtype: 'status',
        status: message.providerStatus ?? 'codex_provider_event',
        result: message.payload,
      },
    },
    order
  );
}

export function mapCodexMessageToDelta(
  message: CodexDeltaMessage,
  order?: number
): SessionDeltaEvent {
  switch (message.kind) {
    case 'assistant_text':
      return createAssistantDelta(message.text ?? '', 'text', order);
    case 'thinking':
      return createAssistantDelta(message.text ?? '', 'thinking', order);
    case 'tool_call':
      return createToolCallDelta(message, order);
    case 'tool_result':
      return createToolResultDelta(message, order);
    case 'completion':
      return createCompletionDelta(message, order);
    default:
      return createProviderEventDelta(message, order);
  }
}
