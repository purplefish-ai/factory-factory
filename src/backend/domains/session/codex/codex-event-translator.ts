import type { SessionDeltaEvent } from '@/shared/claude';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import { createUnsupportedOperationError } from './errors';
import { asRecord } from './payload-utils';
import {
  parseNotificationTextWithSchema,
  parseToolCallNotificationWithSchema,
  parseToolResultNotificationWithSchema,
  parseUserInputQuestionsWithSchema,
} from './schemas';

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
    type: 'agent_message',
    data: {
      type: 'system',
      subtype: 'status',
      status: `codex:${method}`,
      result: params,
    },
  };
}

function translateTurnLifecycle(method: string, params: unknown): SessionDeltaEvent[] | null {
  if (method.startsWith('turn/started') || method.startsWith('turn/running')) {
    return [buildRuntimeUpdate('running', 'alive', 'WORKING')];
  }

  if (method.startsWith('turn/completed') || method.startsWith('turn/finished')) {
    return [
      buildRuntimeUpdate('idle', 'alive', 'IDLE'),
      {
        type: 'agent_message',
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

  if (method.startsWith('turn/cancelled') || method.startsWith('turn/failed')) {
    return [buildRuntimeUpdate('idle', 'alive', 'IDLE'), buildProviderEventMessage(method, params)];
  }

  return null;
}

export class CodexEventTranslator {
  constructor(private readonly options?: { userInputEnabled?: boolean }) {}

  translateNotification(method: string, params: unknown): SessionDeltaEvent[] {
    const turnLifecycleEvents = translateTurnLifecycle(method, params);
    if (turnLifecycleEvents) {
      return turnLifecycleEvents;
    }

    if (method.includes('thinking')) {
      const thinking = parseNotificationTextWithSchema(params);
      if (!thinking) {
        return [buildProviderEventMessage(method, params)];
      }

      return [
        {
          type: 'agent_message',
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
      const parsed = parseToolResultNotificationWithSchema(params);
      return [
        {
          type: 'agent_message',
          data: {
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: parsed.toolUseId,
                  content: parsed.output ?? JSON.stringify(parsed.payload),
                },
              ],
            },
          },
        },
      ];
    }

    if (method.includes('toolCall')) {
      const parsed = parseToolCallNotificationWithSchema(params);
      return [
        {
          type: 'agent_message',
          data: {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: parsed.toolUseId,
                name: parsed.toolName,
                input: parsed.input,
              },
            },
          },
        },
      ];
    }

    const text = parseNotificationTextWithSchema(params);
    if (text) {
      return [
        {
          type: 'agent_message',
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

    if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') {
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

      return {
        type: 'user_question',
        requestId,
        questions: parseUserInputQuestionsWithSchema(params),
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
