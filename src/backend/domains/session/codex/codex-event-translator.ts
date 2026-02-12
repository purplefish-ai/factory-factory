import type { SessionDeltaEvent } from '@/shared/claude';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import { createUnsupportedOperationError } from './errors';

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function extractText(params: unknown): string | null {
  const record = asRecord(params);

  const direct = asString(record.text) ?? asString(record.delta) ?? asString(record.chunk);
  if (direct) {
    return direct;
  }

  const item = asRecord(record.item);
  const itemText = asString(item.text) ?? asString(item.delta) ?? asString(item.content);
  if (itemText) {
    return itemText;
  }

  const message = asRecord(item.message);
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    const blockRecord = asRecord(block);
    const blockText = asString(blockRecord.text);
    if (blockText) {
      return blockText;
    }
  }

  return null;
}

function buildRuntimeUpdate(
  phase: SessionRuntimeState['phase'],
  processState: SessionRuntimeState['processState'],
  activity: SessionRuntimeState['activity']
): SessionDeltaEvent {
  return {
    type: 'session_runtime_updated',
    sessionRuntime: {
      phase,
      processState,
      activity,
      updatedAt: new Date().toISOString(),
    },
  };
}

function buildProviderEventMessage(method: string, params: unknown): SessionDeltaEvent {
  return {
    type: 'claude_message',
    data: {
      type: 'system',
      subtype: 'status',
      status: `codex:${method}`,
      result: params,
    },
  };
}

export class CodexEventTranslator {
  constructor(private readonly options?: { userInputEnabled?: boolean }) {}

  translateNotification(method: string, params: unknown): SessionDeltaEvent[] {
    if (method.startsWith('turn/started') || method.startsWith('turn/running')) {
      return [buildRuntimeUpdate('running', 'alive', 'WORKING')];
    }

    if (method.startsWith('turn/completed') || method.startsWith('turn/finished')) {
      return [
        buildRuntimeUpdate('idle', 'alive', 'IDLE'),
        {
          type: 'claude_message',
          data: {
            type: 'result',
            result: asRecord(params),
          },
        },
      ];
    }

    if (method.startsWith('turn/interrupted')) {
      return [
        buildRuntimeUpdate('idle', 'alive', 'IDLE'),
        {
          type: 'status_update',
          permissionMode: 'interrupted',
        },
      ];
    }

    if (method.includes('thinking')) {
      const thinking = extractText(params);
      if (!thinking) {
        return [buildProviderEventMessage(method, params)];
      }

      return [
        {
          type: 'claude_message',
          data: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'thinking',
                  thinking,
                },
              ],
            },
          },
        },
      ];
    }

    if (method.includes('toolResult')) {
      const record = asRecord(params);
      const toolUseId =
        asString(record.toolUseId) ?? asString(asRecord(record.item).toolUseId) ?? 'codex-tool';
      return [
        {
          type: 'claude_message',
          data: {
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolUseId,
                  content: asString(record.output) ?? JSON.stringify(record),
                },
              ],
            },
          },
        },
      ];
    }

    if (method.includes('toolCall')) {
      const record = asRecord(params);
      const toolUseId =
        asString(record.toolUseId) ?? asString(asRecord(record.item).id) ?? 'codex-tool';
      const toolName =
        asString(record.toolName) ?? asString(asRecord(record.item).name) ?? 'codex_tool';
      return [
        {
          type: 'claude_message',
          data: {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: toolUseId,
                name: toolName,
                input: asRecord(record.input),
              },
            },
          },
        },
      ];
    }

    const text = extractText(params);
    if (text) {
      return [
        {
          type: 'claude_message',
          data: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text,
                },
              ],
            },
          },
        },
      ];
    }

    return [buildProviderEventMessage(method, params)];
  }

  translateServerRequest(method: string, requestId: string, params: unknown): SessionDeltaEvent {
    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval'
    ) {
      return {
        type: 'permission_request',
        requestId,
        toolName:
          method === 'item/commandExecution/requestApproval'
            ? 'CodexCommandApproval'
            : 'CodexFileChangeApproval',
        toolInput: asRecord(params),
      };
    }

    if (method === 'item/tool/requestUserInput') {
      if (!this.options?.userInputEnabled) {
        const error = createUnsupportedOperationError('question_response');
        return {
          type: 'error',
          message: error.message,
          data: {
            code: error.code,
            ...error.metadata,
          },
        };
      }

      const prompt =
        asString(asRecord(params).prompt) ??
        asString(asRecord(asRecord(params).item).prompt) ??
        'Provide input';

      return {
        type: 'user_question',
        requestId,
        questions: [
          {
            header: 'Codex Input',
            question: prompt,
            options: [
              {
                label: 'Continue',
                description: 'Provide an answer and continue execution.',
              },
              {
                label: 'Cancel',
                description: 'Decline and stop this request.',
              },
            ],
          },
        ],
      };
    }

    return {
      type: 'error',
      message: `Unsupported Codex interactive request: ${method}`,
      data: {
        code: 'UNSUPPORTED_OPERATION',
        operation: method,
      },
    };
  }
}
