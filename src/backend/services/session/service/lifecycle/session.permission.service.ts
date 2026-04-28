import {
  AcpPermissionBridge,
  type AcpPermissionRequestEvent,
} from '@/backend/services/session/service/acp';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { AskUserQuestion } from '@/shared/acp-protocol';
import { extractPlanText } from '@/shared/acp-protocol/plan-content';
import { isExitPlanModeRequest, isUserQuestionRequest } from '@/shared/pending-request-types';

export type SessionPermissionServiceDependencies = {
  sessionDomainService?: SessionDomainService;
};

export class SessionPermissionService {
  private readonly sessionDomainService: SessionDomainService;
  private readonly acpPermissionBridges = new Map<string, AcpPermissionBridge>();

  constructor(options?: SessionPermissionServiceDependencies) {
    this.sessionDomainService = options?.sessionDomainService ?? sessionDomainService;
  }

  createPermissionBridge(sessionId: string): AcpPermissionBridge {
    const bridge = new AcpPermissionBridge();
    this.acpPermissionBridges.set(sessionId, bridge);
    return bridge;
  }

  cancelPendingRequests(sessionId: string): void {
    const bridge = this.acpPermissionBridges.get(sessionId);
    if (!bridge) {
      return;
    }

    bridge.cancelAll();
    this.acpPermissionBridges.delete(sessionId);
  }

  respondToPermission(
    sessionId: string,
    requestId: string,
    optionId: string,
    answers?: Record<string, string[]>
  ): boolean {
    const bridge = this.acpPermissionBridges.get(sessionId);
    if (!bridge) {
      return false;
    }

    return bridge.resolvePermission(requestId, optionId, answers);
  }

  handlePermissionRequest(sessionId: string, event: AcpPermissionRequestEvent): void {
    const { requestId, params } = event;
    const toolInput = (params.toolCall.rawInput as Record<string, unknown>) ?? {};
    const toolName = this.resolveToolName(params.toolCall.title, toolInput);
    const acpOptions = params.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    }));
    const planContent = this.extractPlanContent(toolName, toolInput);
    const isUserQuestion = isUserQuestionRequest({ toolName, input: toolInput });
    const questions = isUserQuestion ? this.extractAskUserQuestions(toolInput) : [];
    const pendingInput = isUserQuestion ? { ...toolInput, questions } : toolInput;

    if (isUserQuestion) {
      this.sessionDomainService.emitDelta(sessionId, {
        type: 'user_question',
        requestId,
        toolName,
        questions,
        acpOptions,
      });
    } else {
      this.sessionDomainService.emitDelta(sessionId, {
        type: 'permission_request',
        requestId,
        toolName,
        toolUseId: params.toolCall.toolCallId,
        toolInput,
        planContent,
        acpOptions,
      });
    }

    this.sessionDomainService.setPendingInteractiveRequest(sessionId, {
      requestId,
      toolName,
      toolUseId: params.toolCall.toolCallId,
      input: pendingInput,
      planContent,
      acpOptions,
      timestamp: new Date().toISOString(),
    });
  }

  private extractAskUserQuestions(input: Record<string, unknown>): AskUserQuestion[] {
    const questions = input.questions;
    if (!Array.isArray(questions)) {
      return [];
    }

    return questions.flatMap((question): AskUserQuestion[] => {
      if (!question || typeof question !== 'object') {
        return [];
      }

      const record = question as Record<string, unknown>;
      if (typeof record.question !== 'string') {
        return [];
      }

      const options = Array.isArray(record.options)
        ? record.options.flatMap((option): AskUserQuestion['options'] => {
            if (!option || typeof option !== 'object') {
              return [];
            }

            const optionRecord = option as Record<string, unknown>;
            if (typeof optionRecord.label !== 'string') {
              return [];
            }

            return [
              {
                label: optionRecord.label,
                description:
                  typeof optionRecord.description === 'string' ? optionRecord.description : '',
              },
            ];
          })
        : [];

      return [
        {
          ...(typeof record.id === 'string' ? { id: record.id } : {}),
          question: record.question,
          ...(typeof record.header === 'string' ? { header: record.header } : {}),
          options,
          ...(typeof record.multiSelect === 'boolean' ? { multiSelect: record.multiSelect } : {}),
        },
      ];
    });
  }

  private extractPlanContent(toolName: string, input: Record<string, unknown>): string | null {
    if (!isExitPlanModeRequest({ toolName, input })) {
      return null;
    }

    return extractPlanText(input.plan);
  }

  private resolveToolName(
    title: string | null | undefined,
    input: Record<string, unknown>
  ): string {
    const type = input.type;
    if (type === 'AskUserQuestion' || type === 'ExitPlanMode') {
      return type;
    }

    return title ?? 'ACP Tool';
  }
}
