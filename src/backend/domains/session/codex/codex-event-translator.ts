import type { SessionDeltaEvent } from '@/shared/claude';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import { mapCodexMessageToDelta } from './codex-delta-mapper';
import { createUnsupportedOperationError } from './errors';
import {
  CODEX_DYNAMIC_TOOL_CALL_METHOD,
  isCodexCommandApprovalMethod,
  isCodexFileChangeApprovalMethod,
  isCodexUserInputMethod,
} from './interactive-methods';
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
  return mapCodexMessageToDelta({
    kind: 'provider_event',
    providerStatus: `codex:${method}`,
    payload: params,
  });
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

      return [mapCodexMessageToDelta({ kind: 'thinking', text: thinking })];
    }

    if (method.includes('toolResult')) {
      const parsed = parseToolResultNotificationWithSchema(params);
      return [
        mapCodexMessageToDelta({
          kind: 'tool_result',
          toolUseId: parsed.toolUseId,
          text: parsed.output ?? undefined,
          payload: parsed.payload,
        }),
      ];
    }

    if (method.includes('toolCall')) {
      const parsed = parseToolCallNotificationWithSchema(params);
      return [
        mapCodexMessageToDelta({
          kind: 'tool_call',
          toolUseId: parsed.toolUseId,
          toolName: parsed.toolName,
          input: parsed.input,
        }),
      ];
    }

    const text = parseNotificationTextWithSchema(params);
    if (text) {
      return [mapCodexMessageToDelta({ kind: 'assistant_text', text })];
    }

    return [buildProviderEventMessage(method, params)];
  }

  translateServerRequest(method: string, requestId: string, params: unknown): SessionDeltaEvent {
    if (isCodexCommandApprovalMethod(method) || isCodexFileChangeApprovalMethod(method)) {
      return {
        type: 'permission_request',
        requestId,
        toolName: isCodexCommandApprovalMethod(method)
          ? 'CodexCommandApproval'
          : 'CodexFileChangeApproval',
        toolInput: asRecord(params),
      };
    }

    if (isCodexUserInputMethod(method)) {
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

    if (method === CODEX_DYNAMIC_TOOL_CALL_METHOD) {
      return {
        type: 'error',
        message: 'Unsupported Codex interactive request: item/tool/call (intentionally disabled)',
        data: {
          code: 'UNSUPPORTED_OPERATION',
          operation: method,
          reason: 'INTENTIONALLY_UNSUPPORTED',
        },
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
